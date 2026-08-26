/**
 * The reading layer every document tool shares.
 *
 * 7.4 moved the tools out of `agent.ts` and into one 1,106-line file, which
 * shrank the agent and left the pile intact. What made that a real problem
 * rather than an untidy one: the range reader and the page reader each carried
 * their own idea of what a page ships, two hundred lines apart, and they
 * disagreed — a deduplicated page kept resending its marks. Everything both
 * readers must agree on lives here now, and each tool is its own file.
 */
import { z } from "zod";
import { throwIfAborted } from "./../abort-utils";
import {
  resolveDocPath,
  type PageWiseDocToolContext,
} from "./../agent-runtime-context";
import { emitAgentProgress } from "./../agent-progress";
import { docCache } from "./../doc-cache";
import {
  consumeIndexFailure,
  DEFAULT_AGENT_SCAN_PAGES,
  ensurePageIndexed,
} from "./../../document/index-queue";
import type { LoadedDocument, DocHeading } from "./../types";
import { MIN_INDEX_CHARS } from "./../page-text-merge";
import { getMarks } from "./../mark-store";
import { usableOutline } from "./../outline-nav";
import { getAgentRunAbortSignal } from "./../agent-abort";
import { yieldToUi } from "./../yield-to-ui";
import { labelForPage } from "./../page-labels";
import { describeAnnotations } from "./../pdf-annotations";
import type { ReadAttachments, ReadResult } from "./result";

/** Re-exported so a tool file needs one import path for the reading layer. */
export type ReadResultLike = ReadResult;
import { attachmentCost, attachmentsFor } from "./attachments";

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

export const docToolContextSchema = z.object({
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
export function alreadyDelivered(budget: ReadBudget, path: string, page: number): boolean {
  return budget.delivered.has(`${path}#${page}`);
}

export function markDelivered(budget: ReadBudget, path: string, page: number): void {
  budget.delivered.add(`${path}#${page}`);
}

/** How many of the longest pages a survey names. Enough to point, not to list. */
export const DENSEST_PAGE_COUNT = 5;

/**
 * The densest pages of a document, as page numbers.
 *
 * Replaces sending every page's character count. A model cannot act on "page 87
 * has 3,421 characters", but "the substance is around pages 12, 40 and 63" is a
 * place to start reading.
 */
export function densest(stats: ReadonlyArray<{ page: number; chars: number }>): string {
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
export function requireLoadedDoc(path: string): LoadedDocument {
  const doc = docCache.get(path);
  if (!doc) {
    throw new Error(
      `path not in loaded documents: "${path}". Open the document first.`,
    );
  }
  return doc;
}

/**
 * What this page is printed as, when that differs from where it sits.
 *
 * Returned alongside a read so a citation can quote the number the reader can
 * actually see on the paper. Absent on the great majority of documents.
 */
export function printedLabel(doc: LoadedDocument, page: number): string | null {
  return labelForPage(doc.pageLabels ?? null, page);
}

/**
 * The notes already on the document, for the survey's output.
 *
 * Bounded like everything that reaches a request: a heavily reviewed PDF can
 * carry hundreds of comments, and sending them all would cost more than the
 * pages the question is about. What is left out is said, so the model knows the
 * list is partial rather than assuming it is all there is.
 */
export function documentNotes(doc: LoadedDocument): {
  notesInDocument?: string[];
  notesOmitted?: number;
} {
  const notes = doc.annotations ?? [];
  if (notes.length === 0) return {};
  const { lines, omitted } = describeAnnotations(notes);
  if (lines.length === 0) return {};
  return { notesInDocument: lines, ...(omitted > 0 ? { notesOmitted: omitted } : {}) };
}

/** Validate a 1-based page against the document's page count. */
export function assertPageInBounds(doc: LoadedDocument, page: number): void {
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

export async function readPageText(path: string, page: number, budget?: ReadBudget) {
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

export const SCAN_LIMIT_NOTE =
  "This page has no extracted text and the scan allowance for this question is used up, " +
  "so it cannot be read. Do not retry it. Answer from the pages you could read and tell the " +
  "user plainly that some pages are unscanned — they can scan the rest from the command " +
  "palette (\"Scan all unscanned pages\") or raise the limit in Settings.";

/**
 * Stands in for a page this run already returned in full. Short by design: the
 * text it replaces is a few messages above, and repeating it buys nothing.
 */
export const ALREADY_READ_NOTE = "[already returned in full earlier in this turn]";

/** Said once, by the outline itself, instead of withdrawing the tool. */
export const ONCE_SURVEYED_NOTE =
  "This structure is now in the conversation above; consult it there rather than surveying again.";

export const BUDGET_NOTE =
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
export function bindToolExecute<T, R>(
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

export function resolvePathInput(
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
export const UNINDEXED_NOTE = "See the note on unindexed pages.";

/**
 * Cap on per-page stat entries in a document_outline result. Each entry is
 * ~200 chars of JSON, so an uncapped 1,000-page document would emit a single
 * tool result larger than the whole run budget.
 */
export const MAX_OUTLINE_PAGE_STATS = 200;

/** Preview length when previews are asked for. Enough to name a page's subject. */
export const OUTLINE_PREVIEW_CHARS = 60;

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
export function resolveOutline(doc: LoadedDocument): DocHeading[] {
  return usableOutline(doc.outline, doc.totalPages);
}

export async function readPageRange(
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
        // Pages whose text this result actually carries. Attachments hang on
        // these, not on the range that was asked for — a page pointed at rather
        // than shown had its links and marks in the earlier result.
        const deliveredPages: number[] = [];

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
            deliveredPages.push(page);
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
          deliveredPages.push(page);
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
          ...chargedAttachments(doc, path, deliveredPages, runGen, chargeBudget),
        };
}

/** Marks listed in the document index, or null when there are too many. */
export const MAX_OUTLINE_MARKS = 100;
/** The index is for locating a mark; the page read gives the whole passage. */
export const MAX_OUTLINE_MARK_CHARS = 120;

export function outlineMarkList(
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
/**
 * Attachments for the pages a result carried, charged to the run's budget.
 *
 * Assembly lives in ./attachments so both readers cannot each grow their own
 * idea of what a page ships — which is exactly what happened, and how a
 * deduplicated page came to resend all of its marks.
 */
export function chargedAttachments(
  doc: LoadedDocument,
  path: string,
  deliveredPages: readonly number[],
  runGen: number,
  chargeBudget: (runGen: number, chars: number) => void,
): ReadAttachments {
  const attachments = attachmentsFor(doc, path, deliveredPages);
  chargeBudget(runGen, attachmentCost(attachments));
  return attachments;
}

