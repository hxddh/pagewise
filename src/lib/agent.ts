import { throwIfAborted } from "./abort-utils";
import { extractPageText, getPdfOutline } from "./pdf";
import {
  ToolLoopAgent,
  stepCountIs,
  tool,
  InvalidToolInputError,
  type StopCondition,
  type ToolCallRepairFunction,
} from "ai";
import { z } from "zod";
import {
  buildDocToolContext,
  buildRuntimeContext,
  resolveDocPath,
  type PageWiseDocToolContext,
  type PageWiseRuntimeContext,
} from "./agent-runtime-context";
import { emitAgentProgress } from "./agent-progress";
import { formatSearchPreview } from "./search-preview";
import {
  buildViewContextInstructions,
  buildWholeDocumentInstructions,
} from "./agent-view-context";
import { docCache } from "./doc-cache";
import { resolveModel, resolveReasoning } from "./llm";
import { hasWholeDocumentIntent } from "./page-intent";
import { loadSettings } from "./settings";
import { searchInDocument } from "../document/search";
import { consumeIndexFailure, ensurePageIndexed } from "../document/index-queue";
import { DEFAULT_SETTINGS, type LoadedDocument } from "./types";
import { pickBetterPageText, MIN_INDEX_CHARS } from "./page-text-merge";
import { isMetaToolOnlyLoop } from "./agent-loop-guards";
import { coerceNumericToolInput, normalizeRangeInput } from "./agent-tool-repair";
import {
  READ_PDF_RANGE_TOOL,
  type DocumentToolName,
} from "./document-tool-names";
import { getAgentRunAbortSignal } from "./agent-abort";
import { yieldToUi } from "./yield-to-ui";

/** Default cap per read_pdf_range call — keeps tool results out of context blowups. */
export const DEFAULT_RANGE_MAX_CHARS = 6_000;
/** Default cap per read_pdf_page call. */
export const DEFAULT_PAGE_MAX_CHARS = 6_000;
/**
 * Step budget floor for every run. NOT gated on any intent heuristic — a broad
 * question phrased outside the whole-document keyword set ("review every
 * section", "what recurs across the paper") gets the same room as one that
 * matches. The cumulative read budget is the real cost rail; a targeted
 * question self-terminates well under this.
 */
const DEFAULT_MAX_AGENT_STEPS = 20;
/** Hard ceiling, so a runaway can't chain unbounded tool calls. */
const MAX_WHOLEDOC_STEPS = 30;

/** Step budget for a run: scales with page count (bounded), regardless of intent. */
export function resolveRunMaxSteps(totalPages: number): number {
  return Math.min(MAX_WHOLEDOC_STEPS, Math.max(DEFAULT_MAX_AGENT_STEPS, totalPages || 0));
}

/** Map SDK steps to the snapshot shape the meta-loop guard consumes. */
function toMetaLoopSnapshot(steps: ReadonlyArray<{ toolCalls: ReadonlyArray<unknown> }>) {
  return steps.map((step) => ({
    toolCalls: step.toolCalls.map((call) => ({
      toolName: (call as { toolName?: string }).toolName,
      input: (call as { input?: unknown }).input,
    })),
  }));
}

const stopMetaToolLoop: StopCondition<any, any> = ({ steps }) =>
  isMetaToolOnlyLoop(toMetaLoopSnapshot(steps));

const AGENT_STOP_WHEN = [stepCountIs(DEFAULT_MAX_AGENT_STEPS), stopMetaToolLoop];
/**
 * Cumulative characters a single run may read before it must synthesize. This
 * is the real cost/context rail (it caps accumulated tool output so it can't
 * overflow the provider window), applied uniformly to every run rather than
 * gated on an intent heuristic — a targeted question reads a fraction of it and
 * self-terminates, while a genuinely broad one gets the full budget whether or
 * not it matched a keyword.
 */
const RUN_CHAR_BUDGET = 200_000;

const docToolContextSchema = z.object({
  defaultDocPath: z.string().nullable(),
});

/** Mutable per-run read budget shared between a run's tools and prepareCall. */
interface ReadBudget {
  used: number;
  max: number;
  /**
   * Run generation, bumped by prepareCall. A tool promise still in flight from
   * an aborted run charges against a stale generation, so it can't eat into the
   * next run's budget after the reset.
   */
  gen: number;
}

/** Reject any model-supplied path that is not a currently-loaded document. */
function requireLoadedDoc(path: string): LoadedDocument {
  const doc = docCache.get(path);
  if (!doc) {
    throw new Error(
      `path not in loaded documents: "${path}". Open the document first.`,
    );
  }
  return doc;
}

/** Validate a 1-based page against the document's page count. */
function assertPageInBounds(doc: LoadedDocument, page: number): void {
  if (page < 1) {
    throw new Error(`page ${page} is invalid.`);
  }
  if (doc.totalPages === 0) {
    throw new Error(
      `Cannot read page ${page}: "${doc.name}" has no known page count.`,
    );
  }
  if (page > doc.totalPages) {
    throw new Error(
      `page ${page} is out of range: "${doc.name}" has ${doc.totalPages} page(s).`,
    );
  }
}

async function readPageText(path: string, page: number) {
  const signal = getAgentRunAbortSignal();
  throwIfAborted(signal);

  const doc = docCache.get(path);
  const kind = doc?.kind ?? (path.split(".").pop()?.toLowerCase() === "pdf" ? "pdf" : "image");

  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) {
    return { page, text: cached.text, source: "cache" as const };
  }

  emitAgentProgress(`Indexing page ${page}…`, "index", {
    key: "agent.activityIndexPage",
    params: { page },
  });

  if (kind === "pdf") {
    throwIfAborted(signal);
    const text = await extractPageText(path, page, signal);
    throwIfAborted(signal);
    if (text.trim().length >= MIN_INDEX_CHARS) {
      const merged = pickBetterPageText(cached?.text ?? "", text);
      docCache.upsertPageText(path, page, merged);
      return { page, text: merged, source: "pdf-text" as const };
    }
  }

  // Agent tool read: attribute this vision indexing to the current run's usage.
  await ensurePageIndexed(path, page, signal, true);
  throwIfAborted(signal);
  const after = docCache.getPages(path).find((p) => p.page === page);
  const text = after?.text ?? "";
  // Distinguish a genuinely empty page from an index FAILURE (missing key,
  // vision error, timeout): without this the model sees "" and concludes the
  // page has no content, and may re-read it (each read re-triggers a billed,
  // up-to-60s vision call).
  const indexFailure =
    text.trim().length < MIN_INDEX_CHARS ? consumeIndexFailure(path, page) : null;
  return { page, text, source: "vision" as const, indexFailure };
}

const BUDGET_NOTE =
  "Read budget for this turn is reached; do not read more pages. Synthesize your answer " +
  "from the pages already read, and tell the user clearly that your answer covers only " +
  "those pages — not the entire document.";

type ToolExecuteOptions = { context?: PageWiseDocToolContext };

/** Progress line for a tool call: English fallback plus an i18n key for the UI. */
interface ToolProgressSpec {
  message: string;
  key: string;
  params?: Record<string, string | number>;
}

/** Wrap tool execution so WebKit can paint streaming UI between agent steps. */
function bindToolExecute<T, R>(
  progress: (input: T) => ToolProgressSpec,
  phase: "tool" | "index" | "search" | "read",
  getRunGen: () => number,
  fn: (input: T, options: ToolExecuteOptions, runGen: number) => Promise<R>,
): (input: T, options?: ToolExecuteOptions) => Promise<R> {
  return async (input, options) => {
    const spec = progress(input);
    // Capture the run generation SYNCHRONOUSLY at dispatch: a tool parked on
    // the yieldToUi macrotask below while the next run's prepareCall bumps the
    // generation would otherwise capture the new one and charge the wrong
    // run's budget.
    const runGen = getRunGen();
    emitAgentProgress(spec.message, phase, { key: spec.key, params: spec.params });
    await yieldToUi();
    try {
      return await fn(input, options ?? {}, runGen);
    } finally {
      await yieldToUi();
    }
  };
}

function resolvePathInput(
  inputPath: string | undefined,
  options: ToolExecuteOptions,
): string {
  return resolveDocPath(inputPath, options.context?.defaultDocPath ?? null);
}

/**
 * Compress a list of page numbers into compact ranges for a terse tool result,
 * e.g. [51,52,53,80] -> "51-53, 80". Returns "" for an empty list.
 */
export function compressPageRanges(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const parts: string[] = [];
  let start = sorted[0]!;
  let prev = sorted[0]!;
  for (let i = 1; i <= sorted.length; i++) {
    const n = sorted[i];
    if (n !== undefined && n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    if (n !== undefined) {
      start = n;
      prev = n;
    }
  }
  return parts.join(", ");
}

const UNINDEXED_NOTE =
  "These pages have little or no extracted text, so search_in_document cannot match them. " +
  "Read them directly with read_pdf_page to access their content (this triggers on-demand indexing).";

/**
 * Cap on per-page stat entries in a document_outline result. Each entry is
 * ~200 chars of JSON, so an uncapped 1,000-page document would emit a single
 * tool result larger than the whole run budget.
 */
const MAX_OUTLINE_PAGE_STATS = 200;

function createDocumentTools(budget: ReadBudget) {
  // Charge chars to the run's budget — unless the charging tool belongs to an
  // earlier aborted run (stale generation), so it can't drain the new run.
  const chargeBudget = (runGen: number, chars: number): void => {
    if (budget.gen === runGen) budget.used += chars;
  };

  return {
    document_outline: tool({
      description:
        "Document overview: the native section/bookmark tree (title → page) when " +
        "the PDF has one, plus per-page character counts and short previews " +
        `(first ${MAX_OUTLINE_PAGE_STATS} pages). Use it to jump to a section or ` +
        "to plan chunked reads of a large document.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Loaded document path; defaults to the active document"),
      }),
      contextSchema: docToolContextSchema,
      execute: bindToolExecute(
        () => ({ message: "Scanning document…", key: "agent.activityIndex" }),
        "tool",
        () => budget.gen,
        async ({ path: inputPath }, options, runGen) => {
          const path = resolvePathInput(inputPath, options);
          const doc = requireLoadedDoc(path);
          if (budget.used >= budget.max) {
            return { budgetExceeded: true, note: BUDGET_NOTE };
          }
          const pages = docCache.getPages(path);
          const allStats = pages.map((p) => ({
            page: p.page,
            chars: p.text.length,
            preview: p.text.trim().slice(0, 160),
          }));
          const totalChars = allStats.reduce((sum, p) => sum + p.chars, 0);
          const unindexedPages = pages
            .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
            .map((p) => p.page);
          // Native bookmark/section tree, so the agent can jump by section
          // ("summarize chapter 3") instead of scanning per-page previews.
          // Image documents have no pdf.js outline — don't parse them as PDFs.
          const bookmarks = doc.kind === "pdf" ? await getPdfOutline(path) : [];
          const statsOmitted = Math.max(0, allStats.length - MAX_OUTLINE_PAGE_STATS);
          const result = {
            totalPages: doc.totalPages || pages.length,
            totalChars,
            suggestedChunkSize: DEFAULT_RANGE_MAX_CHARS,
            needsChunking: totalChars > DEFAULT_RANGE_MAX_CHARS,
            pages: statsOmitted > 0 ? allStats.slice(0, MAX_OUTLINE_PAGE_STATS) : allStats,
            ...(statsOmitted > 0
              ? {
                  pageStatsOmitted: statsOmitted,
                  pageStatsNote:
                    `Per-page stats cover the first ${MAX_OUTLINE_PAGE_STATS} of ` +
                    `${allStats.length} pages; use search_in_document or read_pdf_range ` +
                    "to work with later pages.",
                }
              : {}),
            ...(bookmarks.length > 0 ? { bookmarks } : {}),
            ...(unindexedPages.length > 0
              ? {
                  unindexedPageCount: unindexedPages.length,
                  unindexedPages: compressPageRanges(unindexedPages),
                  unindexedNote: UNINDEXED_NOTE,
                }
              : {}),
          };
          // Outline output lands in context like any read — count it.
          chargeBudget(runGen, JSON.stringify(result).length);
          return result;
        },
      ),
    }),

    read_pdf_page: tool({
      description:
        "Read text from a specific page of a loaded document (1-based page number). " +
        "For very long pages the output is capped at maxChars; when truncated=true, call again " +
        "with offset=nextOffset to continue the same page.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Loaded document path; defaults to the active document"),
        page: z.number().int().min(1),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the page to resume from (a previous nextOffset)"),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(50_000)
          .optional()
          .describe(`Max characters to return (default ${DEFAULT_PAGE_MAX_CHARS})`),
      }),
      contextSchema: docToolContextSchema,
      execute: bindToolExecute(
        (input) => {
          const page = (input as { page?: unknown } | undefined)?.page;
          return typeof page === "number"
            ? {
                message: `Reading page ${page}…`,
                key: "agent.activityReadPage",
                params: { page },
              }
            : { message: "Reading page…", key: "agent.activityReadRange" };
        },
        "read",
        () => budget.gen,
        async (
          { path: inputPath, page, offset = 0, maxChars = DEFAULT_PAGE_MAX_CHARS },
          options,
          runGen,
        ) => {
          const path = resolvePathInput(inputPath, options);
          const doc = requireLoadedDoc(path);
          assertPageInBounds(doc, page);

          if (budget.used >= budget.max) {
            return {
              page,
              text: "",
              truncated: false,
              nextOffset: null,
              charCount: 0,
              budgetExceeded: true,
              note: BUDGET_NOTE,
            };
          }

          const { text, source, indexFailure } = await readPageText(path, page);
          // An index FAILURE (missing key / vision error / timeout) is not an
          // empty page — tell the model so it doesn't conclude "no content" or
          // waste steps re-reading (each retry re-triggers a billed vision call).
          if (!text && indexFailure) {
            return {
              page,
              text: "",
              source,
              truncated: false,
              nextOffset: null,
              charCount: 0,
              indexingFailed: true,
              note: `This page could not be indexed (${indexFailure}). Its text is unavailable — do not treat this as an empty page, and don't re-read it without a fix; tell the user indexing failed.`,
            };
          }
          if (text.length > 0 && offset > text.length) {
            return {
              page,
              text: "",
              source,
              truncated: false,
              nextOffset: null,
              charCount: 0,
              note: "Page text changed since the prior read; call read_pdf_page again from the start if needed.",
            };
          }
          const from = Math.min(offset, text.length);
          const room = Math.min(maxChars, budget.max - budget.used);
          const slice = text.slice(from, from + room);
          chargeBudget(runGen, slice.length);

          const consumedEnd = from + slice.length;
          const truncated = consumedEnd < text.length;
          const limitedByBudget = truncated && budget.used >= budget.max;

          return {
            page,
            text: slice,
            source,
            truncated,
            nextOffset: truncated ? consumedEnd : null,
            charCount: slice.length,
            ...(limitedByBudget ? { budgetExceeded: true, note: BUDGET_NOTE } : {}),
          };
        },
      ),
    }),

    read_pdf_range: tool({
      description:
        "Read text from a page range (inclusive, 1-based). " +
        "For large documents use maxChars (default 6000) and continue when truncated=true: call again " +
        "with start=nextStart, and pass offset=nextOffset when it is non-null (the same page has more text). " +
        "truncated=false (with nextStart=null) means the range is fully read.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Loaded document path; defaults to the active document"),
        start: z.number().int().min(1),
        end: z.number().int().min(1),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the start page to resume from (a previous nextOffset)"),
        maxChars: z
          .number()
          .int()
          .min(2000)
          .max(50_000)
          .optional()
          .describe(`Max characters to return (default ${DEFAULT_RANGE_MAX_CHARS})`),
      }),
      contextSchema: docToolContextSchema,
      execute: bindToolExecute(
        () => ({ message: "Reading pages…", key: "agent.activityReadRange" }),
        "read",
        () => budget.gen,
        async ({
          path: inputPath,
          start,
          end,
          offset = 0,
          maxChars = DEFAULT_RANGE_MAX_CHARS,
        }, options, runGen) => {
          const path = resolvePathInput(inputPath, options);
          const doc = requireLoadedDoc(path);
          if (start > end) {
            throw new Error(
              `invalid page range: start (${start}) cannot be greater than end (${end}).`,
            );
          }
          if (doc.totalPages > 0 && start > doc.totalPages) {
            throw new Error(
              `start page ${start} is out of range: "${doc.name}" has ${doc.totalPages} page(s).`,
            );
          }
          const from = start;
          const to = end;
          assertPageInBounds(doc, from);

          const requestedEnd = to;
          const pageLimit = doc.totalPages > 0 ? Math.min(to, doc.totalPages) : to;
          const rangeClamped = doc.totalPages > 0 && to > doc.totalPages;

          const parts: string[] = [];
          let charCount = 0;
          let lastPage = from;
          let truncated = false;
          let nextStart: number | null = null;
          let nextOffset: number | null = null;
          let budgetExceeded = false;
          const failedPages: number[] = [];

          for (let page = from; page <= pageLimit; page++) {
            if (budget.used >= budget.max) {
              truncated = true;
              nextStart = page;
              nextOffset = page === from ? offset : 0;
              budgetExceeded = true;
              break;
            }

            const { text, indexFailure } = await readPageText(path, page);
            // Record pages that couldn't be indexed so the model doesn't read
            // their absence as "empty page".
            if (!text && indexFailure) failedPages.push(page);
            const pageOffset = page === from ? Math.min(offset, text.length) : 0;
            const remainingText = text.slice(pageOffset);
            const header = `--- Page ${page}${pageOffset > 0 ? " (cont.)" : ""} ---\n`;
            const separator = parts.length > 0 ? 2 : 0;

            const maxRoom = maxChars - charCount - separator - header.length;
            const budgetRoom = budget.max - budget.used - separator - header.length;
            const room = Math.min(maxRoom, budgetRoom);
            const limitedByBudget = budgetRoom <= maxRoom;

            if (room <= 0) {
              truncated = true;
              nextStart = page;
              nextOffset = pageOffset;
              budgetExceeded = limitedByBudget;
              break;
            }

            if (remainingText.length > room) {
              const slice = remainingText.slice(0, room);
              parts.push(header + slice);
              charCount += separator + header.length + slice.length;
              chargeBudget(runGen, slice.length);
              lastPage = page;
              truncated = true;
              nextStart = page;
              nextOffset = pageOffset + slice.length;
              budgetExceeded = limitedByBudget;
              break;
            }

            parts.push(header + remainingText);
            charCount += separator + header.length + remainingText.length;
            chargeBudget(runGen, remainingText.length);
            lastPage = page;
          }

          return {
            text: parts.join("\n\n"),
            truncated,
            nextStart,
            nextOffset,
            startPage: from,
            endPage: lastPage,
            requestedEnd,
            actualEnd: pageLimit,
            rangeClamped,
            charCount,
            ...(failedPages.length > 0
              ? {
                  indexingFailedPages: compressPageRanges(failedPages),
                  indexingFailedNote:
                    "These pages could not be indexed (missing key / vision error / timeout) — " +
                    "their absence is not evidence they are blank; tell the user indexing failed.",
                }
              : {}),
            ...(budgetExceeded ? { budgetExceeded: true, note: BUDGET_NOTE } : {}),
          };
        },
      ),
    }),

    search_in_document: tool({
      description:
        "Search for a keyword or phrase in the active document. Returns up to " +
        "maxResults hits (page + snippet); raise maxResults if you need more than the default.",
      inputSchema: z.object({
        query: z.string().min(1),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("Max hits to return (default 50)"),
      }),
      contextSchema: docToolContextSchema,
      execute: bindToolExecute(
        () => ({ message: "Searching document…", key: "agent.activitySearch" }),
        "search",
        () => budget.gen,
        async ({ query, maxResults = 50 }, options, runGen) => {
          const path = resolvePathInput(undefined, options);
          requireLoadedDoc(path);
          if (budget.used >= budget.max) {
            return { hits: [], truncated: false, budgetExceeded: true, note: BUDGET_NOTE };
          }
          const pages = docCache.getPages(path);
          // Silently bound a degenerate query instead of failing the call —
          // snippets embed the match, so a huge query inflates every hit.
          const boundedQuery = query.length > 400 ? query.slice(0, 400) : query;
          // Probe one hit past the cap so truncated distinguishes "exactly
          // maxResults matches" from "more matches exist".
          const raw = searchInDocument(pages, boundedQuery, maxResults + 1);
          const truncated = raw.length > maxResults;
          const hits = truncated ? raw.slice(0, maxResults) : raw;
          const preview = formatSearchPreview(hits);
          if (preview) {
            emitAgentProgress(preview.message, "search", {
              key: "agent.activitySearchMatches",
              params: { count: preview.pages, preview: preview.snippets },
            });
          }
          // Search output lands in context like any read — count it.
          chargeBudget(runGen, JSON.stringify(hits).length);
          return { hits, truncated };
        },
      ),
    }),
  };
}

const SYSTEM_INSTRUCTIONS = `You are PageWise, a local desktop PDF assistant.

Rules:
- Use tools to read document content; never invent page text. Ground your answers in what you read and cite pages for document facts — then explain, interpret, reason, and synthesize freely, adding background knowledge when it helps, while keeping clear what comes from the document vs. your own knowledge.
- The user has one active PDF; omit path on tools to use it.
- Sparse or scan pages are indexed via vision — wait for read results.
- Pick tools freely to answer: search_in_document locates where a term appears, read_pdf_page / read_pdf_range read specific pages, document_outline surveys structure. Search is often the fastest start for a keyword and an outline for a broad task, but read directly when that's more direct.
- If search returns nothing useful, read the relevant page(s) anyway — a figure or scanned page defeats search, so "no hits" does not mean the content is absent; read the page(s) before concluding something isn't in the document.
- When the user asks about a term or topic while viewing a page, read that page first — it is usually what they mean; read where an ambiguous term (e.g. an acronym) appears rather than guessing its meaning.
- If a page doesn't fully answer, read adjacent pages or search again before replying; don't answer a document-spanning question from a single page.
- When you state a fact from the document, cite its page (e.g. "page 5"); quote short key passages verbatim rather than paraphrasing.
- If no document is loaded, ask the user to open a PDF.`;

/**
 * Repair a tool call whose arguments failed schema validation. Handles the most
 * common weak-model mistake — numeric fields sent as strings (e.g. {"page":"5"})
 * — deterministically, without a second model round-trip. Returns null to fall
 * through (no repair) for anything else, including unknown-tool errors.
 */
const repairDocumentToolCall: ToolCallRepairFunction<any> = async ({ toolCall, error }) => {
  if (!InvalidToolInputError.isInstance(error)) return null;
  const repaired = coerceNumericToolInput(toolCall.input);
  if (repaired === null) return null;
  return { ...toolCall, input: repaired };
};

/**
 * Progressive tool disclosure: with no document loaded, expose no tools so the
 * model asks the user to open a PDF instead of calling tools that would throw.
 * Returns undefined (all tools active) once a document is present.
 */
function resolveActiveTools(hasActiveDoc: boolean): DocumentToolName[] | undefined {
  return hasActiveDoc ? undefined : [];
}

function buildToolsContext(runtime: ReturnType<typeof buildRuntimeContext>) {
  const docCtx = buildDocToolContext(runtime);
  return {
    document_outline: docCtx,
    read_pdf_page: docCtx,
    read_pdf_range: docCtx,
    search_in_document: docCtx,
  };
}

export function createDocAgent() {
  const budget: ReadBudget = { used: 0, max: RUN_CHAR_BUDGET, gen: 0 };
  let runMaxSteps = DEFAULT_MAX_AGENT_STEPS;
  const tools = createDocumentTools(budget);
  const defaultRuntime = buildRuntimeContext(null);

  return new ToolLoopAgent({
    model: resolveModel(DEFAULT_SETTINGS),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    toolsContext: buildToolsContext(defaultRuntime),
    stopWhen: AGENT_STOP_WHEN,
    experimental_repairToolCall: repairDocumentToolCall,
    experimental_refineToolInput: {
      [READ_PDF_RANGE_TOOL]: (input) => normalizeRangeInput(input),
    },
    // Force a text answer instead of another tool call when the run is about to
    // end with no synthesis:
    //   1. the last allowed step (step ceiling), and
    //   2. an imminent meta-tool loop — the prior steps already repeat a meta
    //      call (window 2), so without this the next repeat would trip
    //      stopMetaToolLoop and the run would end on a tool call → "noReply".
    // Only sets toolChoice; never mutates messages, so tool-call/result pairing
    // is safe.
    prepareStep: ({ stepNumber, steps }) => {
      if (stepNumber >= runMaxSteps - 1) return { toolChoice: "none" };
      if (steps.length >= 2 && isMetaToolOnlyLoop(toMetaLoopSnapshot(steps), 2)) {
        return { toolChoice: "none" };
      }
      return undefined;
    },
    prepareCall: async ({ toolsContext, runtimeContext: incomingRuntime, ...rest }) => {
      budget.used = 0;
      budget.gen += 1;

      const settings = await loadSettings();
      const runtime =
        (incomingRuntime as PageWiseRuntimeContext | undefined) ??
        buildRuntimeContext(null);
      const viewCtx = runtime.messageContext;
      let viewHint = viewCtx ? buildViewContextInstructions(viewCtx) : "";

      // The whole-document intent regex now ONLY adds an optional survey hint —
      // it no longer gates how much of the document the agent is allowed to read.
      // Budget and step room are uniform, so a broad question phrased outside the
      // keyword set is never silently capped.
      if (viewCtx && hasWholeDocumentIntent(viewCtx.userText)) {
        viewHint += buildWholeDocumentInstructions(viewCtx);
      }
      runMaxSteps = resolveRunMaxSteps(viewCtx?.totalPages ?? 0);
      budget.max = RUN_CHAR_BUDGET;

      return {
        ...rest,
        stopWhen: [stepCountIs(runMaxSteps), stopMetaToolLoop],
        model: resolveModel(settings),
        reasoning: resolveReasoning(settings),
        instructions: SYSTEM_INSTRUCTIONS + viewHint,
        runtimeContext: runtime,
        activeTools: resolveActiveTools(!!runtime.activeDocPath),
        toolsContext: {
          ...toolsContext,
          ...buildToolsContext(runtime),
        },
      };
    },
  });
}
