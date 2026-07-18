/**
 * v3 indexing: vision-only, single queue per document. No OCR.
 */
import { docCache } from "../lib/doc-cache";
import { ensureProviderCompatibleImage } from "../lib/image-transcode";
import { readAuthorizedFileBytes, renderPageToJpegBytes } from "../lib/pdf";
import { generateVisionText } from "../lib/vision-api";
import { loadVisionSettings } from "../lib/settings";
import { assertApiKeyForAgent, formatLlmError } from "../lib/llm";
import { MIN_INDEX_CHARS } from "../lib/page-text-merge";
import { emitPageIndex } from "../lib/index-events";
import type { LoadedDocument } from "../lib/types";

const VISION_TIMEOUT_MS = 60_000;
export const MAX_INDEX_PAGES = 50;
const CONCURRENCY = 3;

const VISION_PROMPT = `Extract all visible text from this document page. Preserve reading order. Use Markdown headings and lists where appropriate. Output only the extracted content — no commentary.`;

type QueueEntry = { abort: AbortController; generation: number };

const queues = new Map<string, QueueEntry>();
const pathGenerations = new Map<string, number>();
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

function sparsePages(doc: LoadedDocument): number[] {
  const pages = docCache.getPages(doc.path);
  return pages
    .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
    .map((p) => p.page)
    .slice(0, MAX_INDEX_PAGES);
}

function sweepPages(doc: LoadedDocument, allPages?: boolean): number[] {
  if (allPages) {
    return docCache.getPages(doc.path).map((p) => p.page).slice(0, MAX_INDEX_PAGES);
  }
  return sparsePages(doc);
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
    bytes: await renderPageToJpegBytes(path, page, 1568, 0.85, signal),
    mediaType: "image/jpeg",
  };
}

async function indexPage(
  path: string,
  page: number,
  signal: AbortSignal,
  generation: number,
  attributeUsage = false,
  enforceGeneration = true,
): Promise<void> {
  // Background sweeps are cancelled when a newer generation supersedes them.
  // An explicit read (agent tool / preview on-demand) must NOT be gated on the
  // sweep generation, or a reindex firing mid-read would return empty text and
  // the caller would wrongly see a blank page.
  const current = () => !enforceGeneration || isCurrentGeneration(path, generation);
  if (signal.aborted || !docCache.has(path) || !current()) return;

  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) {
    emitPageIndex({ path, page, status: "done", source: "cache" });
    return;
  }

  emitPageIndex({ path, page, status: "indexing", source: "vision" });
  clearIndexFailure(path, page);

  try {
    const settings = await loadVisionSettings();
    if (signal.aborted || !current()) {
      emitIdle(path, page);
      return;
    }

    try {
      assertApiKeyForAgent(settings);
    } catch (keyErr) {
      // Key removed mid-sweep: abort the whole BACKGROUND queue once instead of
      // marking every remaining page "failed" one-by-one (50 redundant store
      // reads). An explicit agent read (enforceGeneration=false) falls through
      // to the normal failed emit so it isn't silently cancelled.
      if (enforceGeneration) {
        emitIdle(path, page);
        cancelIndex(path);
        return;
      }
      throw keyErr;
    }
    const { bytes, mediaType } = await visionImageBytes(path, page, signal);
    if (signal.aborted || !current()) {
      emitIdle(path, page);
      return;
    }

    const text = await generateVisionText(settings, VISION_PROMPT, bytes, {
      signal: visionFetchSignal(signal),
      mediaType,
      attributeUsage,
    });

    if (signal.aborted || !current()) {
      emitIdle(path, page);
      return;
    }

    if (text.trim().length >= MIN_INDEX_CHARS) {
      docCache.upsertPageText(path, page, text.trim());
      clearIndexFailure(path, page);
      emitPageIndex({ path, page, status: "done", source: "vision" });
    } else {
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
  attributeUsage = false,
  enforceGeneration = true,
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
    attributeUsage,
    enforceGeneration,
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
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (!signal.aborted && isCurrentGeneration(path, generation)) {
      const i = cursor++;
      if (i >= pages.length) break;
      await runIndexPage(path, pages[i]!, signal, generation);
    }
  });
  await Promise.all(workers);
}

export async function ensurePageIndexed(
  path: string,
  page: number,
  signal?: AbortSignal,
  attributeUsage = false,
): Promise<void> {
  if (signal?.aborted) return;

  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) return;

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
    await runIndexPage(path, page, controller.signal, generation, attributeUsage, false);
  } finally {
    // A long-lived agent-run signal accumulates one listener per page read
    // without this.
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Index one page in the background (preview on-demand). */
export function indexPageInBackground(path: string, page: number): void {
  void ensurePageIndexed(path, page);
}

/** Cancel any in-flight queue for this path and start a new sweep. */
export function scheduleIndex(
  doc: LoadedDocument,
  options?: { allPages?: boolean; pages?: number[] },
): void {
  queues.get(doc.path)?.abort.abort();
  const generation = nextGeneration(doc.path);
  const controller = new AbortController();
  queues.set(doc.path, { abort: controller, generation });

  const pages = options?.pages ?? sweepPages(doc, options?.allPages);
  if (pages.length === 0) return;

  void runPool(doc.path, pages, controller.signal, generation).finally(() => {
    const entry = queues.get(doc.path);
    if (entry?.abort === controller) {
      queues.delete(doc.path);
    }
  });
}

export function cancelIndex(path: string): void {
  queues.get(path)?.abort.abort();
  queues.delete(path);
  nextGeneration(path);
}

export function reindexDocument(path: string): void {
  const fresh = docCache.get(path);
  if (!fresh) return;
  const pages = sweepPages(fresh, true);
  if (pages.length === 0) return;
  docCache.invalidateIndexedPageText(path, pages);
  scheduleIndex(fresh, { pages });
}
