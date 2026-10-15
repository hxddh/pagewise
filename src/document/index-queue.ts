/**
 * Indexing: giving every page usable text, one queue per document.
 *
 * Since 14.0 a page with no text layer is read by local OCR first — free,
 * private, and with word boxes, so the page's citations can be checked. The
 * vision model is the fallback: for a page OCR could not read, or read with
 * low confidence, and it is billed per page, so it sits behind a budget.
 *
 * OCR costs no money, but it is not free: it costs CPU — 2.64s a page for
 * English at 200dpi, measured for the 20.0 review. The automatic sweep is
 * therefore bounded in PAGES as well — `DEFAULT_AUTO_INDEX_PAGES` — for both
 * readers; only an explicit whole-document index reads past it.
 */
import { docCache } from "../lib/doc-cache";
import { ensureProviderCompatibleImage } from "../lib/image-transcode";
import {
  readAuthorizedFileBytes,
  renderPageToJpegBytes,
  VISION_MAX_EDGE,
  VISION_QUALITY,
} from "../lib/pdf";
import { generateVisionText } from "../lib/vision-api";
import { loadVisionSettings } from "../lib/settings";
import { assertApiKeyForAgent, formatLlmError } from "../lib/llm";
import { MIN_INDEX_CHARS } from "../lib/page-text-merge";
import { emitPageIndex } from "../lib/index-events";
import { forgetIndexedPages, rememberIndexedPage } from "../lib/index-store";
import { recordVisionCall } from "../lib/usage-tracker";
import { cachedOcrPage, cancelQueuedOcr, ocrEnabled, ocrPage, ocrQueueState, subscribeOcrQueue } from "../lib/ocr/ocr-service";
import type { LoadedDocument } from "../lib/types";

/**
 * Where a vision call's tokens are booked.
 *
 * `run` — a page the assistant read while answering: the message pays, and the
 * per-question tracker resets with the next question.
 * `document` — the on-view prefetch: there is no message, so the document keeps
 * the total (18.0; before this the tokens went nowhere).
 * `none` — the background sweep: nobody asked for it, and it is already visible
 * as the document's call count.
 */
type VisionUsage = "run" | "document" | "none";

const VISION_TIMEOUT_MS = 60_000;
/**
 * Pages one automatic sweep will read, whatever the vision budget says.
 *
 * This is the CPU bound, and 20.0 is where it exists. OCR costs no money but
 * 2.64s of CPU a page (measured for the 20.0 review), and until this cap a
 * sweep with OCR on read EVERY page with no text: a 300-page scan was about
 * 6.6 minutes of recognition, because the budget only applied when OCR was
 * off. Both readers now read at most this many pages per sweep.
 *
 * The money is bounded separately, by the reader's preference
 * (`autoIndexCap`): that is how many of these pages may go on to the model.
 */
export const DEFAULT_AUTO_INDEX_PAGES = 50;
const CONCURRENCY = 3;

let autoIndexCap = DEFAULT_AUTO_INDEX_PAGES;

/**
 * Set the automatic sweep's vision budget — the most of its pages that may be
 * sent to the model (0 sends none; the sweep still reads locally).
 * Kept as module state rather than read per sweep so page selection stays
 * synchronous; the app applies the stored preference at startup and on change.
 */
export function setAutoIndexCap(pages: number): void {
  autoIndexCap = Number.isFinite(pages) && pages >= 0 ? Math.floor(pages) : DEFAULT_AUTO_INDEX_PAGES;
}

export function getAutoIndexCap(): number {
  return autoIndexCap;
}

/**
 * Pages the assistant may send to the vision model while answering ONE
 * question. The automatic sweep budget above does not govern this path: an
 * agent page read indexes on demand precisely so the page the user asked about
 * is never reported blank. That exemption is correct per page and unbounded per
 * run — a question about a 300-page scan could walk the whole document — so
 * agent-triggered scanning carries its own ceiling.
 */
export const DEFAULT_AGENT_SCAN_PAGES = 20;

let agentScanCap = DEFAULT_AGENT_SCAN_PAGES;

/** Set the per-question agent scan allowance (0 disables agent-triggered scanning). */
export function setAgentScanCap(pages: number): void {
  agentScanCap =
    Number.isFinite(pages) && pages >= 0 ? Math.floor(pages) : DEFAULT_AGENT_SCAN_PAGES;
}

export function getAgentScanCap(): number {
  return agentScanCap;
}

/**
 * Below this mean word confidence a recognised page is offered to vision.
 * Clean print reads at 90+; a page under 70 has enough misread words that a
 * vision transcription is worth its cost where a budget allows one.
 */
export const OCR_TRUSTED_CONFIDENCE = 70;

/** Whether this page's words came from OCR that read it poorly. */
export function isPoorlyRecognised(path: string, page: number): boolean {
  const read = cachedOcrPage(path, page);
  return !!read && read.confidence < OCR_TRUSTED_CONFIDENCE;
}

/**
 * What an indexing pass may do beyond OCR. `takeVision` is asked just before a
 * vision call and says whether one may be made — the budget lives with the
 * caller. `skipOcr` is for a re-scan the reader asked of the vision model.
 */
export interface VisionPolicy {
  takeVision: () => boolean;
  skipOcr?: boolean;
  /** Vision only for a page OCR produced nothing for — never to improve on it. */
  onlyIfUnread?: boolean;
}

const VISION_ALWAYS: VisionPolicy = { takeVision: () => true };

const VISION_PROMPT = `Extract all visible text from this document page. Preserve reading order. Use Markdown headings and lists where appropriate. Output only the extracted content — no commentary.`;

type QueueEntry = {
  abort: AbortController;
  generation: number;
  /** Vision calls this sweep may still make; null for no limit. */
  visionLeft: number | null;
  /** Every page this sweep will read, so the reader can be told the total. */
  pages: number[];
  /** The page of this sweep being read right now, if any. */
  current: number | null;
  /** Pages whose turn through the pool has finished. */
  read: number;
  /** Pages with no text past the sweep's cap: read on demand, not by it. */
  outside: number;
};


const queues = new Map<string, QueueEntry>();
const pathGenerations = new Map<string, number>();

/**
 * Who is watching what is being read (19.0).
 *
 * The preview shows "Reading page 3 of 12" with a Cancel while a sweep runs;
 * before this, a scan being read was invisible, and a reader had no way to know
 * whether the app was working or had stopped, or to stop it. The OCR queue is
 * the page-level source (it knows which page is being recognised), the sweep is
 * the total, and both feed this one subscription.
 */
const progressListeners = new Set<() => void>();
let ocrQueueWatched = false;

function notifyProgress(): void {
  for (const listener of progressListeners) listener();
}

export function subscribeReadingProgress(listener: () => void): () => void {
  if (!ocrQueueWatched) {
    ocrQueueWatched = true;
    subscribeOcrQueue(notifyProgress);
  }
  progressListeners.add(listener);
  return () => {
    progressListeners.delete(listener);
  };
}

/**
 * What the reading line draws: a sweep being read, or how one ended (20.0).
 *
 * A sweep can stop with pages still unread — the reader cancelled it, or the
 * document had more pages than the sweep's cap reads — and the line then says
 * what happened instead of disappearing: `read` of `total` pages were read,
 * and `left` pages wait to be read on demand (when the reader scrolls to one,
 * or the assistant asks about it). A sweep that read everything it had to
 * leaves nothing to say and draws nothing.
 */
export type ReadingProgress =
  | { state: "reading"; page: number; total: number }
  | { state: "stopped"; read: number; total: number; left: number };

/**
 * How a sweep that stopped with pages unread ended.
 *
 * Kept after the sweep's queue entry is gone — that is the point of it: a
 * cancelled sweep must not look like one that never ran. Cleared when a new
 * sweep is scheduled for the document, or when the document is closed.
 */
interface ReadingStop {
  read: number;
  total: number;
  left: number;
}

const readingStops = new Map<string, ReadingStop>();

/**
 * Record how a sweep stopped, for the reading line's terminal state.
 *
 * A sweep that read everything it had to leaves nothing to say — no state —
 * so the line goes away as before. One that stopped with pages left (a
 * cancel, the cap, an end that is neither) keeps the state until the document
 * is closed or another sweep replaces it.
 */
function recordReadingStop(path: string, entry: QueueEntry): void {
  const left = entry.pages.length - entry.read + entry.outside;
  if (left <= 0) return;
  readingStops.set(path, { read: entry.read, total: entry.pages.length, left });
}

/**
 * What this document is being read as, or how its last sweep ended, or null.
 *
 * The page comes from the OCR queue when OCR is the reader — that is the page
 * whose words are arriving — and from the sweep otherwise, so a vision-only
 * pass still shows which page it is on.
 */
export function readingProgress(path: string): ReadingProgress | null {
  const stopped = readingStops.get(path);
  if (stopped) return { state: "stopped", ...stopped };
  const entry = queues.get(path);
  if (!entry || entry.pages.length === 0) return null;
  const page = ocrQueueState(path).current ?? entry.current;
  if (page === null) return null;
  return { state: "reading", page, total: entry.pages.length };
}

/**
 * Stop reading this document's pages: the sweep, and any OCR it queued.
 *
 * One action for the reader, two layers underneath — the sweep's abort signal
 * covers the vision pass, and the OCR queue is told separately because a page
 * already waiting for a worker has no way to hear about the abort. The sweep
 * leaves a terminal state behind (20.0): the line says how many pages it read
 * and how many wait on demand, instead of vanishing as if nothing had
 * happened. The page being recognised still finishes, as before.
 */
export function cancelReading(path: string): void {
  const entry = queues.get(path);
  cancelIndex(path);
  cancelQueuedOcr(path);
  if (entry) recordReadingStop(path, entry);
  notifyProgress();
}
const pageInflight = new Map<
  string,
  { promise: Promise<void>; generation: number; signal: AbortSignal }
>();

function pageKey(path: string, page: number): string {
  return `${path}\0${page}`;
}

/**
 * Last vision-index failure per page, so an agent read can tell the model
 * "indexing failed" instead of handing back an empty string that reads as "this
 * page has no content". Set on a failed attempt, cleared when an attempt starts
 * or succeeds.
 */
const pageIndexFailure = new Map<string, string>();

/** Read and clear the recorded index failure for a page, if any. */
export function consumeIndexFailure(path: string, page: number): string | null {
  const key = pageKey(path, page);
  const reason = pageIndexFailure.get(key) ?? null;
  if (reason !== null) pageIndexFailure.delete(key);
  return reason;
}

function recordIndexFailure(path: string, page: number, reason: string): void {
  pageIndexFailure.set(pageKey(path, page), reason);
}

function clearIndexFailure(path: string, page: number): void {
  pageIndexFailure.delete(pageKey(path, page));
}

function nextGeneration(path: string): number {
  const gen = (pathGenerations.get(path) ?? 0) + 1;
  pathGenerations.set(path, gen);
  return gen;
}

function isCurrentGeneration(path: string, generation: number): boolean {
  return (pathGenerations.get(path) ?? 0) === generation;
}

/**
 * Pages with no usable text yet. `cap` of `null` means "no budget limit".
 *
 * The extractor's own verdict (`needs_vision`) is the union partner rather than
 * the sole judge: a page it left empty is definitely a candidate, and so is one
 * whose text later fell below the threshold.
 */
function sparsePages(doc: LoadedDocument, cap: number | null): number[] {
  const pages = docCache
    .getPages(doc.path)
    .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
    .map((p) => p.page);
  return cap === null ? pages : pages.slice(0, cap);
}

/**
 * The pages one automatic sweep reads, and how many sparse pages its cap
 * leaves past the window.
 *
 * Bounded by `DEFAULT_AUTO_INDEX_PAGES` for both readers: the page count is
 * the CPU bound, and OCR is behind it now as well as vision. The vision budget
 * is applied page by page as the sweep runs (`visionLeft`), so a sweep never
 * makes more billed calls than the reader allowed either. The pages past the
 * cap are not forgotten — they are read on demand — but the reading line says
 * so when the sweep stops (20.0).
 */
function sweepWindow(doc: LoadedDocument): { pages: number[]; outside: number } {
  const all = sparsePages(doc, null);
  const pages = all.slice(0, DEFAULT_AUTO_INDEX_PAGES);
  return { pages, outside: all.length - pages.length };
}

/**
 * The window a re-index may clear and rescan: the reader's vision budget, in
 * pages. Only these pages are thrown away, and only these are paid for again —
 * see `reindexDocument`. A re-index re-scans with vision, so the money bound is
 * the one that matters here, not the sweep's CPU window.
 */
function reindexPages(doc: LoadedDocument): number[] {
  const all = docCache.getPages(doc.path).map((p) => p.page);
  return all.slice(0, autoIndexCap);
}

/** Pages an explicit whole-document index would have to send to vision. */
export function pendingIndexPages(path: string): number[] {
  const doc = docCache.get(path);
  if (!doc) return [];
  return sparsePages(doc, null);
}

function visionMediaType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "tif" || ext === "tiff") return "image/tiff";
  return "image/jpeg";
}

function visionFetchSignal(queueSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([queueSignal, AbortSignal.timeout(VISION_TIMEOUT_MS)]);
}

function emitIdle(path: string, page: number): void {
  emitPageIndex({ path, page, status: "idle" });
}

/**
 * The page render a vision call sends.
 *
 * 1,024px at JPEG quality 80, one path for every page (18.0 lowered it from a
 * 1,568px render; 20.0 deleted the branch that brought the larger one back for
 * a page OCR read poorly). That branch rested on a comment claiming the larger
 * render was three to four times the bytes; re-measured it is 2.0–2.2×, and it
 * buys no better transcription — the same model reads the page at this size.
 * With OCR off, every page takes the same render, as before.
 */
async function visionImageBytes(
  path: string,
  page: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const doc = docCache.get(path);
  if (doc?.kind === "image") {
    // TIFF/BMP must be transcoded — vision endpoints reject those media types.
    return ensureProviderCompatibleImage(
      await readAuthorizedFileBytes(path, signal),
      visionMediaType(path),
    );
  }
  return {
    bytes: await renderPageToJpegBytes(
      path,
      page,
      VISION_MAX_EDGE,
      VISION_QUALITY,
      signal,
    ),
    mediaType: "image/jpeg",
  };
}

/**
 * Read one page with local OCR and keep what it read. Returns the recognised
 * page when it produced usable text.
 */
async function recognisePage(
  path: string,
  page: number,
  signal: AbortSignal,
  background: boolean,
): Promise<{ text: string; confidence: number } | null> {
  const read = await ocrPage(path, page, { signal, background });
  if (!read || read.text.trim().length < MIN_INDEX_CHARS) return null;
  docCache.upsertPageText(path, page, read.text.trim(), "ocr");
  return read;
}

async function indexPage(
  path: string,
  page: number,
  signal: AbortSignal,
  generation: number,
  usage: VisionUsage = "none",
  enforceGeneration = true,
  policy: VisionPolicy = VISION_ALWAYS,
): Promise<void> {
  // Background sweeps are cancelled when a newer generation supersedes them.
  // An explicit read (agent tool / preview on-demand) must NOT be gated on the
  // sweep generation, or a reindex firing mid-read would return empty text and
  // the caller would wrongly see a blank page.
  const current = () => !enforceGeneration || isCurrentGeneration(path, generation);
  if (signal.aborted || !docCache.has(path) || !current()) return;

  const cached = docCache.getPages(path).find((p) => p.page === page);
  const usable = !!cached && cached.text.trim().length >= MIN_INDEX_CHARS;
  // A page OCR read poorly is still worth a vision call when the caller can
  // afford one; any other page with text is done.
  if (usable && (policy.onlyIfUnread || !(cached.source === "ocr" && isPoorlyRecognised(path, page)))) {
    emitPageIndex({ path, page, status: "done", source: "cache" });
    return;
  }

  clearIndexFailure(path, page);

  // Local OCR first. What it reads stays as the page's text even if vision is
  // tried after: a vision failure then leaves the page readable.
  let recognised = usable;
  if (!usable && ocrEnabled() && !policy.skipOcr) {
    emitPageIndex({ path, page, status: "indexing", source: "ocr" });
    try {
      const read = await recognisePage(path, page, signal, enforceGeneration);
      if (signal.aborted || !current()) {
        emitIdle(path, page);
        return;
      }
      if (read) {
        recognised = true;
        if (read.confidence >= OCR_TRUSTED_CONFIDENCE) {
          emitPageIndex({ path, page, status: "done", source: "ocr" });
          return;
        }
      }
    } catch {
      // OCR never throws by contract; if it did, vision is still the fallback.
    }
  }

  /** The page keeps what OCR read; say so and stop. */
  const settleOnOcr = (): boolean => {
    if (!recognised) return false;
    emitPageIndex({ path, page, status: "done", source: "ocr" });
    return true;
  };

  if ((policy.onlyIfUnread && recognised) || !policy.takeVision()) {
    if (settleOnOcr()) return;
    emitIdle(path, page);
    return;
  }

  emitPageIndex({ path, page, status: "indexing", source: "vision" });

  try {
    const settings = await loadVisionSettings();
    if (signal.aborted || !current()) {
      emitIdle(path, page);
      return;
    }

    try {
      assertApiKeyForAgent(settings);
    } catch (keyErr) {
      // No key: the page keeps what OCR read, if anything. A BACKGROUND sweep
      // then stops asking for vision — once, instead of marking every
      // remaining page "failed" one by one — but keeps reading pages locally.
      // An explicit agent read (enforceGeneration=false) falls through to the
      // normal failed emit so it isn't silently cancelled.
      if (enforceGeneration) {
        stopVisionForQueue(path);
        if (!settleOnOcr()) emitIdle(path, page);
        return;
      }
      if (settleOnOcr()) return;
      throw keyErr;
    }
    const { bytes, mediaType } = await visionImageBytes(path, page, signal);
    if (signal.aborted || !current()) {
      emitIdle(path, page);
      return;
    }

    recordVisionCall(path);
    const text = await generateVisionText(settings, VISION_PROMPT, bytes, {
      signal: visionFetchSignal(signal),
      mediaType,
      attributeUsage: usage === "run",
      ...(usage === "document" ? { attributeToDocument: path } : {}),
    });

    if (signal.aborted || !current()) {
      emitIdle(path, page);
      return;
    }

    if (text.trim().length >= MIN_INDEX_CHARS) {
      docCache.upsertPageText(path, page, text.trim(), "vision");
      clearIndexFailure(path, page);
      // This page cost a vision call — persist it so reopening the document
      // doesn't pay for it again.
      const indexed = docCache.get(path);
      if (indexed?.stamp) {
        rememberIndexedPage(path, indexed.stamp, indexed.totalPages, page, text.trim());
      }
      emitPageIndex({ path, page, status: "done", source: "vision" });
    } else if (!settleOnOcr()) {
      recordIndexFailure(path, page, "insufficient_text");
      emitPageIndex({
        path,
        page,
        status: "failed",
        source: "vision",
        failureReason: "insufficient_text",
      });
    }
  } catch (err) {
    if (signal.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      emitIdle(path, page);
      return;
    }
    if (!current()) {
      emitIdle(path, page);
      return;
    }
    if (settleOnOcr()) return;
    const detail = formatLlmError(err, undefined, "scan");
    if (import.meta.env.DEV) {
      console.warn(`[index] page ${page}:`, detail);
    }
    recordIndexFailure(path, page, detail);
    emitPageIndex({
      path,
      page,
      status: "failed",
      source: "vision",
      error: detail,
      failureReason: "vision_failed",
    });
  }
}

async function runIndexPage(
  path: string,
  page: number,
  signal: AbortSignal,
  generation: number,
  usage: VisionUsage = "none",
  enforceGeneration = true,
  policy: VisionPolicy = VISION_ALWAYS,
): Promise<void> {
  const key = pageKey(path, page);
  const existing = pageInflight.get(key);
  // Only piggyback on an in-flight task that hasn't been aborted — a task
  // started by a background sweep dies silently when reindex/cancel fires.
  if (existing?.generation === generation && !existing.signal.aborted) {
    await existing.promise;
    const cached = docCache.getPages(path).find((p) => p.page === page);
    const indexed = !!cached && cached.text.trim().length >= MIN_INDEX_CHARS;
    // Fall through to run our own pass whenever the piggybacked task left the
    // page un-indexed and we're still live — whether it was aborted OR FAILED
    // (vision error/timeout). Returning here would report the page as blank to
    // an explicit agent read. Only skip when it genuinely succeeded, we're
    // aborted, or the doc is gone. This runs at most one fresh pass (no loop).
    if (indexed || signal.aborted || !docCache.has(path)) {
      return;
    }
  }

  const promise = indexPage(
    path,
    page,
    signal,
    generation,
    usage,
    enforceGeneration,
    policy,
  ).finally(() => {
    const cur = pageInflight.get(key);
    if (cur?.promise === promise) {
      pageInflight.delete(key);
    }
  });
  pageInflight.set(key, { promise, generation, signal });
  await promise;
}

async function runPool(
  path: string,
  pages: number[],
  signal: AbortSignal,
  generation: number,
  policy: VisionPolicy,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (!signal.aborted && isCurrentGeneration(path, generation)) {
      const i = cursor++;
      if (i >= pages.length) break;
      // Tell the reader's reading line which page this is; the OCR queue will
      // refine it to the page actually being recognised a moment later.
      const entry = queues.get(path);
      if (entry && entry.abort.signal === signal) {
        entry.current = pages[i]!;
        notifyProgress();
      }
      // A sweep is nobody's question and nobody's page view: its calls are
      // counted, its tokens are not booked to a message or a document.
      await runIndexPage(path, pages[i]!, signal, generation, "none", true, policy);
      // The page's turn is over, whatever it read — that is the "read n of N"
      // the line reports when the sweep stops before its end (20.0).
      if (entry && entry.abort.signal === signal) entry.read += 1;
    }
  });
  await Promise.all(workers);
}

export async function ensurePageIndexed(
  path: string,
  page: number,
  signal?: AbortSignal,
  usage: VisionUsage = "none",
  policy: VisionPolicy = VISION_ALWAYS,
): Promise<void> {
  if (signal?.aborted) return;

  const cached = docCache.getPages(path).find((p) => p.page === page);
  const improvable = cached?.source === "ocr" && !policy.onlyIfUnread && isPoorlyRecognised(path, page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS && !improvable) return;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) return;
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const generation = pathGenerations.get(path) ?? 0;
    // Explicit reads must complete even if a background reindex bumps the
    // generation mid-flight — pass enforceGeneration=false.
    await runIndexPage(path, page, controller.signal, generation, usage, false, policy);
  } finally {
    // A long-lived agent-run signal accumulates one listener per page read
    // without this.
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Index one page the reader is looking at. Read locally when OCR is on, and
 * sent to vision only when OCR is off or read nothing — looking at a page is
 * not a request to pay for a better transcription of it.
 */
export function indexPageInBackground(path: string, page: number): void {
  // "document", not "none": this call happens because the reader scrolled onto
  // the page, and no message is being written to charge it to (18.0).
  void ensurePageIndexed(path, page, undefined, "document", {
    takeVision: () => true,
    onlyIfUnread: true,
  });
}

/** Stop a background sweep from asking for vision; it keeps reading pages locally. */
function stopVisionForQueue(path: string): void {
  const entry = queues.get(path);
  if (entry) entry.visionLeft = 0;
}

/**
 * Cancel any in-flight queue for this path and start a new sweep.
 *
 * The sweep reads at most `DEFAULT_AUTO_INDEX_PAGES` pages — the CPU bound,
 * for OCR and vision alike — and the reader's cloud preference
 * (`autoIndexCap`) bounds how many of those go on to the model, which is the
 * money. An explicit whole-document action — `indexWholeDocument`,
 * `reindexDocument` — reads past the window by handing in its own `pages`: it
 * names the pages up front and the reader agrees to the count before any of it
 * runs.
 */
export function scheduleIndex(
  doc: LoadedDocument,
  options?: {
    pages?: number[];
    visionBudget?: number | null;
    skipOcr?: boolean;
  },
): void {
  queues.get(doc.path)?.abort.abort();
  const generation = nextGeneration(doc.path);
  const controller = new AbortController();
  const entry: QueueEntry = {
    abort: controller,
    generation,
    visionLeft: options?.visionBudget === undefined ? autoIndexCap : options.visionBudget,
    pages: [],
    current: null,
    read: 0,
    outside: 0,
  };
  queues.set(doc.path, entry);
  // A new sweep replaces what the line said about the last one.
  readingStops.delete(doc.path);

  const planned = options?.pages ? { pages: options.pages, outside: 0 } : sweepWindow(doc);
  if (planned.pages.length === 0) return;
  entry.pages = planned.pages;
  entry.outside = planned.outside;
  notifyProgress();

  const policy: VisionPolicy = {
    skipOcr: options?.skipOcr,
    takeVision: () => {
      if (entry.visionLeft === null) return true;
      if (entry.visionLeft <= 0) return false;
      entry.visionLeft -= 1;
      return true;
    },
  };

  void runPool(doc.path, planned.pages, controller.signal, generation, policy).finally(() => {
    const cur = queues.get(doc.path);
    if (cur?.abort === controller) {
      queues.delete(doc.path);
      // A sweep that ran into the cap leaves pages the line must name: they
      // are read on demand, and stopping at the cap must not look like the
      // reader's own cancel or like a sweep that is still pending (20.0).
      // A sweep that read everything it had to records nothing.
      recordReadingStop(doc.path, entry);
      notifyProgress();
    }
  });
}

export function cancelIndex(path: string): void {
  queues.get(path)?.abort.abort();
  queues.delete(path);
  nextGeneration(path);
  // The terminal state belongs to the sweep it describes: a document being
  // closed (or a re-index replacing the queue) takes it along.
  readingStops.delete(path);
}

/**
 * Re-scan this document's vision pages, returning how many pages were scheduled.
 *
 * The window is bounded by the automatic sweep budget on purpose: a re-index
 * only throws away text it will pay to replace. The count comes back so the
 * caller can say what actually happened — with the budget set to 0 this
 * schedules nothing at all, and reporting "re-indexing…" would be a lie.
 */
export function reindexDocument(path: string): number {
  const fresh = docCache.get(path);
  if (!fresh) return 0;
  const pages = reindexPages(fresh);
  if (pages.length === 0) return 0;
  // The persisted copy of the pages being discarded goes with them, or the next
  // open would restore exactly what the user asked to re-scan. Only those pages:
  // dropping the whole document threw away the persisted text of every page
  // outside the window — pages that keep their text and are never re-scanned, so
  // nothing looked wrong until the next open re-billed them.
  void forgetIndexedPages(path, pages);
  // Only the vision-indexed pages are actually cleared; a page whose words came
  // from the PDF's own text layer keeps them. Scheduling every page is still
  // correct — indexPage returns early for any page that still has usable text,
  // before it reaches the vision call — so the ones that kept their text cost
  // nothing but a queue slot.
  docCache.invalidateIndexedPageText(path, pages);
  // A re-scan is asked of the vision model: it does not stop at what OCR reads.
  scheduleIndex(fresh, { pages, visionBudget: null, skipOcr: true });
  return pages.length;
}

/**
 * Index every page that still has no usable text, ignoring the automatic sweep
 * budget. Explicit only: the caller shows the page count (i.e. the most vision
 * calls this can make) first. OCR still reads each page first, so a page it
 * reads well costs nothing. Results persist, so the cost is paid once per file.
 */
export function indexWholeDocument(path: string): number {
  const doc = docCache.get(path);
  if (!doc) return 0;
  const pages = sparsePages(doc, null);
  if (pages.length === 0) return 0;
  scheduleIndex(doc, { pages, visionBudget: null });
  return pages.length;
}
