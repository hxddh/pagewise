import { throwIfAborted } from "./abort-utils";
import { extractPageText } from "./pdf";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
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
import { ensurePageIndexed } from "../document/index-queue";
import { DEFAULT_SETTINGS, type LoadedDocument } from "./types";
import { pickBetterPageText, MIN_INDEX_CHARS } from "./page-text-merge";
import { getAgentRunAbortSignal } from "./agent-abort";
import { yieldToUi } from "./yield-to-ui";

/** Default cap per read_pdf_range call — keeps tool results out of context blowups. */
export const DEFAULT_RANGE_MAX_CHARS = 6_000;
/** Default cap per read_pdf_page call. */
export const DEFAULT_PAGE_MAX_CHARS = 6_000;
/** Default ceiling per agent run. */
const DEFAULT_MAX_AGENT_STEPS = 12;
/** Cumulative characters a single run may read before it must synthesize. */
const RUN_CHAR_BUDGET = 120_000;

const docToolContextSchema = z.object({
  defaultDocPath: z.string().nullable(),
});

/** Mutable per-run read budget shared between a run's tools and prepareCall. */
interface ReadBudget {
  used: number;
  readonly max: number;
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

  emitAgentProgress(`Indexing page ${page}…`, "index");

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

  await ensurePageIndexed(path, page, signal);
  throwIfAborted(signal);
  const after = docCache.getPages(path).find((p) => p.page === page);
  const text = after?.text ?? "";
  return { page, text, source: "vision" as const };
}

const BUDGET_NOTE =
  "Cumulative read budget for this turn reached; synthesize your answer from the pages already read instead of reading more.";

type ToolExecuteOptions = { context?: PageWiseDocToolContext };

/** Wrap tool execution so WebKit can paint streaming UI between agent steps. */
function bindToolExecute<T, R>(
  label: string,
  phase: "tool" | "index" | "search" | "read",
  fn: (input: T, options: ToolExecuteOptions) => Promise<R>,
): (input: T, options?: ToolExecuteOptions) => Promise<R> {
  return async (input, options) => {
    emitAgentProgress(label, phase);
    await yieldToUi();
    try {
      return await fn(input, options ?? {});
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

function createDocumentTools(budget: ReadBudget) {
  return {
    document_outline: tool({
      description:
        "Document overview: per-page character counts and short previews. " +
        "Use before reading large documents to plan chunked reads.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Loaded document path; defaults to the active document"),
      }),
      contextSchema: docToolContextSchema,
      execute: bindToolExecute(
        "Scanning document…",
        "tool",
        async ({ path: inputPath }, options) => {
          const path = resolvePathInput(inputPath, options);
          const doc = requireLoadedDoc(path);
          const pages = docCache.getPages(path);
          const pageStats = pages.map((p) => ({
            page: p.page,
            chars: p.text.length,
            preview: p.text.trim().slice(0, 160),
          }));
          const totalChars = pageStats.reduce((sum, p) => sum + p.chars, 0);
          return {
            totalPages: doc.totalPages || pages.length,
            totalChars,
            suggestedChunkSize: DEFAULT_RANGE_MAX_CHARS,
            needsChunking: totalChars > DEFAULT_RANGE_MAX_CHARS,
            pages: pageStats,
          };
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
        "Reading page…",
        "read",
        async ({ path: inputPath, page, offset = 0, maxChars = DEFAULT_PAGE_MAX_CHARS }, options) => {
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

          const { text, source } = await readPageText(path, page);
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
          budget.used += slice.length;

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
        "Reading pages…",
        "read",
        async ({
          path: inputPath,
          start,
          end,
          offset = 0,
          maxChars = DEFAULT_RANGE_MAX_CHARS,
        }, options) => {
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

          for (let page = from; page <= pageLimit; page++) {
            if (budget.used >= budget.max) {
              truncated = true;
              nextStart = page;
              nextOffset = page === from ? offset : 0;
              budgetExceeded = true;
              break;
            }

            const { text } = await readPageText(path, page);
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
              budget.used += slice.length;
              lastPage = page;
              truncated = true;
              nextStart = page;
              nextOffset = pageOffset + slice.length;
              budgetExceeded = limitedByBudget;
              break;
            }

            parts.push(header + remainingText);
            charCount += separator + header.length + remainingText.length;
            budget.used += remainingText.length;
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
            ...(budgetExceeded ? { budgetExceeded: true, note: BUDGET_NOTE } : {}),
          };
        },
      ),
    }),

    search_in_document: tool({
      description: "Search for a keyword or phrase in the active document",
      inputSchema: z.object({
        query: z.string().min(1),
      }),
      contextSchema: docToolContextSchema,
      execute: bindToolExecute(
        "Searching document…",
        "search",
        async ({ query }, options) => {
          const path = resolvePathInput(undefined, options);
          requireLoadedDoc(path);
          const pages = docCache.getPages(path);
          const hits = searchInDocument(pages, query, 30);
          const preview = formatSearchPreview(hits);
          if (preview) emitAgentProgress(preview, "search");
          return hits;
        },
      ),
    }),
  };
}

const SYSTEM_INSTRUCTIONS = `You are PageWise, a local desktop PDF assistant.

Rules:
- Use tools to read document content; never invent page text.
- The user has one active PDF; omit path on tools to use it.
- Sparse or scan pages are indexed via vision — wait for read results.
- For keyword questions: search_in_document first, then read_pdf_page on hits.
- For whole-document tasks: document_outline first, then read_pdf_range in chunks.
- Cite page numbers when quoting.
- If no document is loaded, ask the user to open a PDF.`;

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
  const budget: ReadBudget = { used: 0, max: RUN_CHAR_BUDGET };
  let runMaxSteps = DEFAULT_MAX_AGENT_STEPS;
  const tools = createDocumentTools(budget);
  const defaultRuntime = buildRuntimeContext(null);

  return new ToolLoopAgent({
    model: resolveModel(DEFAULT_SETTINGS),
    instructions: SYSTEM_INSTRUCTIONS,
    tools,
    toolsContext: buildToolsContext(defaultRuntime),
    stopWhen: stepCountIs(DEFAULT_MAX_AGENT_STEPS),
    prepareCall: async ({ toolsContext, runtimeContext: incomingRuntime, ...rest }) => {
      budget.used = 0;

      const settings = await loadSettings();
      const runtime =
        (incomingRuntime as PageWiseRuntimeContext | undefined) ??
        buildRuntimeContext(null);
      const viewCtx = runtime.messageContext;
      runMaxSteps = DEFAULT_MAX_AGENT_STEPS;
      let viewHint = viewCtx ? buildViewContextInstructions(viewCtx) : "";

      if (viewCtx && hasWholeDocumentIntent(viewCtx.userText)) {
        viewHint += buildWholeDocumentInstructions(viewCtx);
      }

      return {
        ...rest,
        stopWhen: stepCountIs(runMaxSteps),
        model: resolveModel(settings),
        reasoning: resolveReasoning(settings),
        instructions: SYSTEM_INSTRUCTIONS + viewHint,
        runtimeContext: runtime,
        toolsContext: {
          ...toolsContext,
          ...buildToolsContext(runtime),
        },
      };
    },
  });
}

export const documentTools = createDocumentTools({ used: 0, max: RUN_CHAR_BUDGET });
