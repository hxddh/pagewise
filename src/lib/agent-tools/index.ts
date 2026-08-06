import { z } from "zod";
import { tool } from "ai";
import { throwIfAborted } from "./../abort-utils";
import { getPdfOutline } from "./../pdf";
import {
  resolveDocPath,
  type PageWiseDocToolContext,
} from "./../agent-runtime-context";
import { emitAgentProgress } from "./../agent-progress";
import { formatSearchPreview } from "./../search-preview";
import { docCache } from "./../doc-cache";
import { searchInDocument } from "./../../document/search";
import {
  consumeIndexFailure,
  DEFAULT_AGENT_SCAN_PAGES,
  ensurePageIndexed,
} from "./../../document/index-queue";
import type { LoadedDocument, DocHeading } from "./../types";
import { MIN_INDEX_CHARS } from "./../page-text-merge";
import { describeFigure, figuresOnPage, pagesWithFigures } from "./../read-figure";
import { linksOnPages, pagesWithLinks, type PageLink } from "./../page-links";
import { getMarks, marksOnPage, pagesWithMarks } from "./../mark-store";
import { findSectionIndex, sectionRange } from "./../section-range";
import { preferAuthoredOutline, usableOutline } from "./../outline-nav";
import { getAgentRunAbortSignal } from "./../agent-abort";
import { yieldToUi } from "./../yield-to-ui";
import type { ReadResult } from "./result";

/**
 * The six document tools, and the reading layer they share.
 *
 * These lived inside `agent.ts` alongside the prompt, the agent configuration
 * and the step hooks — 1,347 lines, the largest file in the repo, and the one
 * you had to open to change either how a tool reads or how the loop is
 * configured. The dedup gap fixed in 7.3 happened inside it, between two
 * readers two hundred lines apart, which is roughly the distance at which
 * nobody sees both at once.
 */

/** Default cap per read_pdf_range call — keeps tool results out of context blowups. */
export const DEFAULT_RANGE_MAX_CHARS = 6_000;
/** Default cap per read_pdf_page call. */
export const DEFAULT_PAGE_MAX_CHARS = 6_000;

/**
 * Cumulative characters a single run may read before it must synthesize. The
 * real cost rail: it caps accumulated tool output so it cannot overflow the
 * provider window, applied uniformly rather than gated on an intent heuristic.
 */
export const RUN_CHAR_BUDGET = 200_000;

/**
 * Hits a search returns unless asked for more.
 *
 * Fifty hits at ~240 characters of surrounding text is ~13,000 characters —
 * about 3,300 tokens for one call, which the loop then carries. A model picks
 * where to read from the first handful.
 */
export const DEFAULT_SEARCH_HITS = 12;

/** Figure picked when the model doesn't say which: the largest on the page. */
export const DEFAULT_FIGURE_INDEX = 1;

const docToolContextSchema = z.object({
  defaultDocPath: z.string().nullable(),
});

/** Mutable per-run read budget shared between a run's tools and prepareCall. */
export interface ReadBudget {
  used: number;
  max: number;
  /** Vision calls this run has triggered by reading un-indexed pages. */
  scans: number;
  /** Ceiling on those calls (0 = the assistant may not scan at all). */
  maxScans: number;
  /**
   * Run generation, bumped by prepareCall. A tool promise still in flight from
   * an aborted run charges against a stale generation, so it can't eat into the
   * next run's budget after the reset.
   */
  gen: number;
  /**
   * Pages whose text this run has already returned in full.
   *
   * The budget counted characters, not pages, so nothing stopped the same page
   * being handed over twice — read a range, then read one page inside it, and
   * the second copy went into the context and onto the bill. The text is still
   * right there in the transcript, so the repeat carries no information; it
   * only costs. Keyed `path#page`.
   */
  delivered: Set<string>;
}

/**
 * Has this run already handed the model the whole of this page?
 *
 * Kept next to the budget rather than inside a reader: 7.2 put the same logic
 * in the range reader alone, and the single-page tool — which has its own path
 * through readPageText — silently fell outside the guarantee it was written
 * for. Two functions both readers call is harder to grow out of.
 *
 * Only whole deliveries count. A page cut short must stay continuable, or a
 * long page becomes unreadable past its first slice.
 */
function alreadyDelivered(budget: ReadBudget, path: string, page: number): boolean {
  return budget.delivered.has(`${path}#${page}`);
}

function markDelivered(budget: ReadBudget, path: string, page: number): void {
  budget.delivered.add(`${path}#${page}`);
}

/** How many of the longest pages a survey names. Enough to point, not to list. */
const DENSEST_PAGE_COUNT = 5;

/**
 * The densest pages of a document, as page numbers.
 *
 * Replaces sending every page's character count. A model cannot act on "page 87
 * has 3,421 characters", but "the substance is around pages 12, 40 and 63" is a
 * place to start reading.
 */
function densest(stats: ReadonlyArray<{ page: number; chars: number }>): string {
  const ranked = [...stats].sort((a, b) => b.chars - a.chars).slice(0, DENSEST_PAGE_COUNT);
  return compressPageRanges(ranked.map((s) => s.page).sort((a, b) => a - b));
}

/** A fresh budget for one run. One definition, so a run and a test agree. */
export function newReadBudget(): ReadBudget {
  return {
    used: 0,
    max: RUN_CHAR_BUDGET,
    scans: 0,
    maxScans: DEFAULT_AGENT_SCAN_PAGES,
    gen: 0,
    delivered: new Set(),
  };
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

async function readPageText(path: string, page: number, budget?: ReadBudget) {
  const signal = getAgentRunAbortSignal();
  throwIfAborted(signal);

  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) {
    return { page, text: cached.text, source: "cache" as const };
  }

  // Opening the document extracted every page it could, so a page still empty
  // here has no text layer to re-read — only a vision call can produce one.
  emitAgentProgress(`Indexing page ${page}…`, "index", {
    key: "agent.activityIndexPage",
    params: { page },
  });

  // Reaching here means the page has no usable text and only a (billed) vision
  // call can produce any — so this is the point where the run's scan allowance
  // is spent. Refuse instead of scanning once it's gone: without this, a
  // question about a large scan walks the document one billed page at a time.
  if (budget && budget.scans >= budget.maxScans) {
    return { page, text: "", source: "vision" as const, indexFailure: null, scanLimit: true };
  }
  if (budget) budget.scans += 1;

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

const SCAN_LIMIT_NOTE =
  "This page has no extracted text and the scan allowance for this question is used up, " +
  "so it cannot be read. Do not retry it. Answer from the pages you could read and tell the " +
  "user plainly that some pages are unscanned — they can scan the rest from the command " +
  "palette (\"Scan all unscanned pages\") or raise the limit in Settings.";

/**
 * Stands in for a page this run already returned in full. Short by design: the
 * text it replaces is a few messages above, and repeating it buys nothing.
 */
const ALREADY_READ_NOTE = "[already returned in full earlier in this turn]";

/** Said once, by the outline itself, instead of withdrawing the tool. */
const ONCE_SURVEYED_NOTE =
  "This structure is now in the conversation above; consult it there rather than surveying again.";

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

/**
 * The standing explanation moved into the system prompt, where it is sent once
 * and lands inside the provider's cached prefix. Results carry the fact, not
 * the paragraph: at roughly 66 tokens it was a tenth of a default search.
 */
const UNINDEXED_NOTE = "See the note on unindexed pages.";

/**
 * Cap on per-page stat entries in a document_outline result. Each entry is
 * ~200 chars of JSON, so an uncapped 1,000-page document would emit a single
 * tool result larger than the whole run budget.
 */
const MAX_OUTLINE_PAGE_STATS = 200;

/** Preview length when previews are asked for. Enough to name a page's subject. */
const OUTLINE_PREVIEW_CHARS = 60;

/**
 * Read a page range, honouring every rule a page read has to honour.
 *
 * Both `read_pdf_range` and `read_section` come through here. A section is a
 * page range once its heading is resolved, and giving it its own reader would
 * mean a second implementation of vision indexing, the scan allowance, offset
 * continuation and indexing-failure reporting — four things that must not
 * disagree between two tools.
 */
/**
 * The section list the model is shown, and the one it is answered against.
 *
 * `document_outline` prefers a PDF's authored bookmarks and falls back to the
 * headings recovered from the page text. `read_section` has to resolve titles
 * against the same list: a model quoting a bookmark title would otherwise be
 * told no such section exists, on exactly the well-structured documents where
 * bookmarks are present.
 */
async function resolveOutline(doc: LoadedDocument, path: string): Promise<DocHeading[]> {
  const authored = doc.kind === "pdf" ? await getPdfOutline(path) : [];
  const usableAuthored = usableOutline(
    authored.filter((b): b is { title: string; page: number; level: number } => b.page !== null),
    doc.totalPages,
  );
  return preferAuthoredOutline(usableAuthored, usableOutline(doc.outline, doc.totalPages));
}

async function readPageRange(
  path: string,
  doc: LoadedDocument,
  args: { start: number; end: number; offset: number; maxChars: number },
  budget: ReadBudget,
  runGen: number,
  chargeBudget: (runGen: number, chars: number) => void,
): Promise<ReadResult> {
  const { start, end, offset, maxChars } = args;
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
        let scanLimitReached = false;
        const failedPages: number[] = [];
        const unscannedPages: number[] = [];

        for (let page = from; page <= pageLimit; page++) {
          if (budget.used >= budget.max) {
            truncated = true;
            nextStart = page;
            nextOffset = page === from ? offset : 0;
            budgetExceeded = true;
            break;
          }

          const { text, indexFailure, scanLimit } = await readPageText(path, page, budget);
          // The allowance is gone: keep walking the range so already-indexed
          // pages further in are still returned, but record what was skipped
          // instead of letting it read as "these pages are blank".
          if (scanLimit) {
            scanLimitReached = true;
            unscannedPages.push(page);
            continue;
          }
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

          // Already handed over in this run: point at it instead of paying for
          // a second copy. Only whole, untruncated deliveries count, so a page
          // that was cut short can still be continued with an offset.
          if (pageOffset === 0 && alreadyDelivered(budget, path, page)) {
            parts.push(`${header}${ALREADY_READ_NOTE}`);
            charCount += separator + header.length + ALREADY_READ_NOTE.length;
            lastPage = page;
            continue;
          }

          parts.push(header + remainingText);
          charCount += separator + header.length + remainingText.length;
          chargeBudget(runGen, remainingText.length);
          if (pageOffset === 0) markDelivered(budget, path, page);
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
              }
            : {}),
          ...(scanLimitReached
            ? {
                scanLimitReached: true,
                unscannedPages: compressPageRanges(unscannedPages),
                scanLimitNote: SCAN_LIMIT_NOTE,
              }
            : {}),
          ...(budgetExceeded ? { budgetExceeded: true, note: BUDGET_NOTE } : {}),
          ...withPageLinks(doc, rangeOf(from, lastPage), runGen, chargeBudget),
          ...withPageMarks(path, rangeOf(from, lastPage), runGen, chargeBudget),
        };
}

/**
 * What the reader marked on the pages a read covered.
 *
 * A marked passage is the strongest signal in the document of what this reader
 * cares about, and it exists nowhere in the page text. Same placement as the
 * links above: beside the text, never inside it.
 */
function withPageMarks(
  path: string,
  pages: readonly number[],
  runGen: number,
  chargeBudget: (runGen: number, chars: number) => void,
): { marks?: { page: number; text: string; note?: string }[] } {
  const marks = pages
    .flatMap((page) => marksOnPage(path, page))
    .map((m) => ({ page: m.page, text: m.text, ...(m.note ? { note: m.note } : {}) }));
  if (marks.length === 0) return {};
  chargeBudget(runGen, JSON.stringify(marks).length);
  return {
    marks,
  };
}

/** Marks listed in the document index, or null when there are too many. */
const MAX_OUTLINE_MARKS = 100;
/** The index is for locating a mark; the page read gives the whole passage. */
const MAX_OUTLINE_MARK_CHARS = 120;

function outlineMarkList(
  path: string,
): { page: number; text: string; note?: string }[] | null {
  const marks = getMarks(path);
  if (marks.length === 0 || marks.length > MAX_OUTLINE_MARKS) return null;
  return marks.map((m) => ({
    page: m.page,
    text:
      m.text.length > MAX_OUTLINE_MARK_CHARS
        ? `${m.text.slice(0, MAX_OUTLINE_MARK_CHARS)}…`
        : m.text,
    ...(m.note ? { note: m.note } : {}),
  }));
}

/** The pages a read actually returned text for. */
function rangeOf(from: number, to: number): number[] {
  const pages: number[] = [];
  for (let page = from; page <= to; page++) pages.push(page);
  return pages;
}

/**
 * The links on the pages a read covered, charged like any other output.
 *
 * The destination of a hyperlink is nowhere in the page text, so without this
 * a read gives the model the anchor's words and nothing else — "See the
 * specification" with no way to learn what it points at.
 */
function withPageLinks(
  doc: LoadedDocument,
  pages: readonly number[],
  runGen: number,
  chargeBudget: (runGen: number, chars: number) => void,
): { links?: PageLink[] } {
  const links = linksOnPages(doc.links, pages);
  if (links.length === 0) return {};
  chargeBudget(runGen, JSON.stringify(links).length);
  return {
    links,
  };
}

export function createDocumentTools(budget: ReadBudget) {
  // Charge chars to the run's budget — unless the charging tool belongs to an
  // earlier aborted run (stale generation), so it can't drain the new run.
  const chargeBudget = (runGen: number, chars: number): void => {
    if (budget.gen === runGen) budget.used += chars;
  };

  return {
    document_outline: tool({
      description:
        "Document overview: the native section/bookmark tree (title → page) when " +
        "the PDF has one, the document's total length, and which pages are " +
        "densest, unreadable, or carry figures, tables, links or the reader's " +
        "marks. Use it to jump to a section or to plan reads of a large " +
        "document. pageStats: true adds every page's character count and " +
        "previews: true adds a text preview per page — both are large, and the " +
        "summary above is usually enough.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Loaded document path; defaults to the active document"),
        previews: z
          .boolean()
          .optional()
          .describe(
            `Include a short text preview per page (first ${MAX_OUTLINE_PAGE_STATS} pages). Off by default.`,
          ),
        pageStats: z
          .boolean()
          .optional()
          .describe(
            "Include the character count of every page. Off by default — the " +
              "totals and the longest/shortest pages are already reported.",
          ),
      }),
      contextSchema: docToolContextSchema,
      execute: bindToolExecute(
        () => ({ message: "Scanning document…", key: "agent.activityIndex" }),
        "tool",
        () => budget.gen,
        async ({ path: inputPath, previews = false, pageStats = false }, options, runGen) => {
          const path = resolvePathInput(inputPath, options);
          const doc = requireLoadedDoc(path);
          if (budget.used >= budget.max) {
            return { budgetExceeded: true, note: BUDGET_NOTE };
          }
          const pages = docCache.getPages(path);
          // Previews are the expensive half of this result: 200 of them measures
          // 19,693 characters — about 4,900 tokens for one call, which the loop
          // then resends on every later step. (An earlier version of this note
          // said 40,000 characters and ten thousand tokens; it was an estimate,
          // and it was double.)
          const allStats = pages.map((p) => ({
            page: p.page,
            chars: p.text.length,
            ...(previews ? { preview: p.text.trim().slice(0, OUTLINE_PREVIEW_CHARS) } : {}),
          }));
          const totalChars = allStats.reduce((sum, p) => sum + p.chars, 0);
          const unindexedPages = pages
            .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
            .map((p) => p.page);
          // A section tree so the agent can jump by section ("summarize chapter
          // 3") instead of scanning per-page previews. Authored bookmarks are
          // authoritative when the PDF carries them; most do not, and for those
          // the headings recovered from the page text are the only structure
          // there is. Image documents have neither.
          const bookmarks = await resolveOutline(doc, path);
          const figurePages = pagesWithFigures(doc.figures);
          const linkPages = pagesWithLinks(doc.links);
          const markPages = pagesWithMarks(path);
          const outlineMarks = outlineMarkList(path);
          // Previews live on the per-page entries, so asking for them implies
          // the list they sit on.
          const includeStats = pageStats || previews;
          const statsOmitted = includeStats
            ? Math.max(0, allStats.length - MAX_OUTLINE_PAGE_STATS)
            : 0;
          const result = {
            totalPages: doc.totalPages || pages.length,
            totalChars,
            suggestedChunkSize: DEFAULT_RANGE_MAX_CHARS,
            needsChunking: totalChars > DEFAULT_RANGE_MAX_CHARS,
            /*
             * The per-page character counts used to be sent in full: 200 pages
             * of {page, chars} measures 5,093 characters, about 1,273 tokens on
             * every survey, and there is nothing a model does with "page 87 has
             * 3,421 characters". What planning needs is already above —
             * totalChars, needsChunking, suggestedChunkSize — and the readers
             * handle chunking themselves through truncated/nextStart/nextOffset.
             *
             * What survives is the part that points somewhere: the densest
             * pages, which is where a dense document's substance tends to be.
             * The full list is still one flag away for anything that needs it.
             */
            densestPages: densest(allStats),
            ...(includeStats
              ? {
                  pages:
                    statsOmitted > 0 ? allStats.slice(0, MAX_OUTLINE_PAGE_STATS) : allStats,
                }
              : {}),
            // The tree is now in the transcript. Saying so here costs one line
            // in the messages; the alternative — withdrawing the tool for the
            // rest of the run — changes the tool block and throws away the
            // cached prefix on every remaining step.
            surveyNote: ONCE_SURVEYED_NOTE,
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
            // Tables must be read whole — a reflowed table merges neighbouring
            // numbers into one wrong number.
            ...(doc.tablePages?.length ? { pagesWithTables: compressPageRanges(doc.tablePages) } : {}),
            // Without this, read_figure could only be reached by guessing that
            // a page has a figure.
            ...(figurePages.length > 0
              ? {
                  pagesWithFigures: compressPageRanges(figurePages),
                }
              : {}),
            // Hyperlink destinations live only in the PDF's annotations, never
            // in the page text — reading a page is the only way to see them.
            ...(linkPages.length > 0
              ? {
                  pagesWithLinks: compressPageRanges(linkPages),
                }
              : {}),
            // What the reader marked says what they care about; it is nowhere in
            // the page text. Carried here in full rather than as page numbers
            // alone: "summarize what I marked" otherwise costs one page read
            // per marked page for text already held in memory.
            ...(markPages.length > 0
              ? {
                  pagesWithMarks: compressPageRanges(markPages),
                  ...(outlineMarks
                    ? { marks: outlineMarks }
                    : { markCount: getMarks(path).length }),
                }
              : {}),
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
        ): Promise<ReadResult> => {
          const path = resolvePathInput(inputPath, options);
          const doc = requireLoadedDoc(path);
          assertPageInBounds(doc, page);

          // Already handed over whole in this run. Answered before readPageText
          // so the repeat costs neither the page's tokens nor — for a page with
          // no text layer — a second billed vision call.
          if (offset === 0 && alreadyDelivered(budget, path, page)) {
            return {
              page,
              text: ALREADY_READ_NOTE,
              truncated: false,
              nextOffset: null,
              charCount: 0,
              alreadyRead: true,
            };
          }

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

          const { text, source, indexFailure, scanLimit } = await readPageText(
            path,
            page,
            budget,
          );
          if (scanLimit) {
            return {
              page,
              text: "",
              source,
              truncated: false,
              nextOffset: null,
              charCount: 0,
              scanLimitReached: true,
              note: SCAN_LIMIT_NOTE,
            };
          }
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
          // A whole page, read from the start: the next request for it is a
          // repeat. A truncated read is deliberately not recorded.
          if (offset === 0 && !truncated) markDelivered(budget, path, page);

          return {
            page,
            text: slice,
            source,
            truncated,
            nextOffset: truncated ? consumedEnd : null,
            charCount: slice.length,
            ...(limitedByBudget ? { budgetExceeded: true, note: BUDGET_NOTE } : {}),
            ...withPageLinks(doc, [page], runGen, chargeBudget),
            ...withPageMarks(path, [page], runGen, chargeBudget),
          };
        },
      ),
    }),

    read_pdf_range: tool({
      description:
        "Read text from a page range (inclusive, 1-based). " +
        `For large documents use maxChars (default ${DEFAULT_RANGE_MAX_CHARS}) and continue when truncated=true: call again ` +
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
          return readPageRange(
            path,
            doc,
            { start, end, offset, maxChars },
            budget,
            runGen,
            chargeBudget,
          );
        },
      ),
    }),

    read_section: tool({
      description:
        "Read a whole section by its heading, instead of guessing which pages it " +
        "spans. Take the heading from document_outline. Continue exactly as with " +
        "read_pdf_range when truncated=true: nextStart/nextOffset say where to " +
        "resume. Section boundaries come from the document's own bookmarks when it " +
        "has them, otherwise from headings recovered from the page text, which on " +
        "a document whose headings are not visually distinct can be approximate — " +
        "fall back to read_pdf_range when the result looks wrong.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Heading text, as document_outline reported it"),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Character offset into the first page to resume from (a previous nextOffset)"),
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
        ({ title }) => ({
          message: `Reading section “${title}”…`,
          key: "agent.activityReadSection",
          params: { title },
        }),
        "read",
        () => budget.gen,
        async ({ title, offset = 0, maxChars = DEFAULT_RANGE_MAX_CHARS }, options, runGen) => {
          const path = resolvePathInput(undefined, options);
          const doc = requireLoadedDoc(path);
          if (budget.used >= budget.max) {
            return { budgetExceeded: true, note: BUDGET_NOTE };
          }

          const outline = await resolveOutline(doc, path);
          const index = findSectionIndex(outline, title);
          const range = sectionRange(outline, index, doc.totalPages);
          if (!range) {
            return {
              note:
                outline.length === 0
                  ? "This document has no section headings; read by page range instead."
                  : `No section matches "${title}". Call document_outline for the headings that exist.`,
            };
          }

          // A resolved section is a page range, and a page range already has one
          // correct reader — including vision indexing for pages with no text
          // layer, the scan allowance, and offset continuation.
          const read = await readPageRange(
            path,
            doc,
            { start: range.startPage, end: range.endPage, offset, maxChars },
            budget,
            runGen,
            chargeBudget,
          );
          return { section: range.title, ...read };
        },
      ),
    }),

    read_figure: tool({
      description:
        "Look at a figure, chart or diagram on a page and describe it. Figures are " +
        "numbered from 1 in order of size on that page; omit index for the largest. " +
        "Use this when a page's text refers to something the text alone does not " +
        "convey. Each call sends one image to the vision model and is billed.",
      inputSchema: z.object({
        page: z.number().int().min(1),
        index: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(`Which figure on the page, largest first (default ${DEFAULT_FIGURE_INDEX})`),
      }),
      contextSchema: docToolContextSchema,
      execute: bindToolExecute(
        ({ page }) => ({
          message: `Looking at the figure on page ${page}…`,
          key: "agent.activityFigure",
          params: { page },
        }),
        "index",
        () => budget.gen,
        async ({ page, index = DEFAULT_FIGURE_INDEX }, options, runGen) => {
          const path = resolvePathInput(undefined, options);
          const doc = requireLoadedDoc(path);
          assertPageInBounds(doc, page);
          if (budget.used >= budget.max) {
            return { budgetExceeded: true, note: BUDGET_NOTE };
          }

          const figures = figuresOnPage(doc.figures, page);
          if (figures.length === 0) {
            return {
              page,
              figureCount: 0,
              note: "This page has no embedded figure to look at. Its content is in the page text.",
            };
          }
          const figure = figures[index - 1];
          if (!figure) {
            return {
              page,
              figureCount: figures.length,
              note: `Page ${page} has ${figures.length} figure(s); index ${index} is out of range.`,
            };
          }

          // A figure costs a billed vision call, so it draws on the same
          // per-question allowance as scanning an unreadable page.
          if (budget.scans >= budget.maxScans) {
            return { page, scanLimitReached: true, note: SCAN_LIMIT_NOTE };
          }
          budget.scans += 1;

          const signal = getAgentRunAbortSignal();
          throwIfAborted(signal);
          const description = await describeFigure(path, page, figure, signal);
          throwIfAborted(signal);

          const result = { page, figureIndex: index, figureCount: figures.length, description };
          chargeBudget(runGen, JSON.stringify(result).length);
          return result;
        },
      ),
    }),

    search_in_document: tool({
      description:
        "Search for a keyword or phrase in the active document. Returns up to " +
        `maxResults hits (page + snippet), ${DEFAULT_SEARCH_HITS} by default; ` +
        "truncated=true means more exist — raise maxResults when you need the long list.",
      inputSchema: z.object({
        query: z.string().min(1),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Max hits to return (default ${DEFAULT_SEARCH_HITS})`),
      }),
      contextSchema: docToolContextSchema,
      execute: bindToolExecute(
        () => ({ message: "Searching document…", key: "agent.activitySearch" }),
        "search",
        () => budget.gen,
        async ({ query, maxResults = DEFAULT_SEARCH_HITS }, options, runGen) => {
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
          // Signal pages search CANNOT match: image/scan pages with little or no
          // extracted text aren't in the search index, so "no hits" there is not
          // evidence the term is absent. The model often searches before reading,
          // so surface this here (not just in document_outline).
          const unindexedPages = pages
            .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
            .map((p) => p.page);
          const result = {
            hits,
            truncated,
            ...(unindexedPages.length > 0
              ? {
                  unindexedPageCount: unindexedPages.length,
                  unindexedPages: compressPageRanges(unindexedPages),
                  unindexedNote: UNINDEXED_NOTE,
                }
              : {}),
          };
          // Search output lands in context like any read — count it.
          chargeBudget(runGen, JSON.stringify(result).length);
          return result;
        },
      ),
    }),
  };
}
