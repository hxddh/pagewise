/**
 * v3 indexing: vision-only, single queue per document. No OCR.
 */
import { docCache } from "../lib/doc-cache";
import { readAuthorizedFileBytes, renderPageToJpegBytes } from "../lib/pdf";
import { generateVisionText } from "../lib/vision-api";
import { loadVisionSettings } from "../lib/settings";
import { assertApiKeyForAgent, formatLlmError } from "../lib/llm";
import { MIN_INDEX_CHARS } from "../lib/page-text-merge";
import { emitPageIndex } from "../lib/index-events";
import type { LoadedDocument } from "../lib/types";

const VISION_TIMEOUT_MS = 60_000;
const MAX_INDEX_PAGES = 50;
const CONCURRENCY = 3;

const VISION_PROMPT = `Extract all visible text from this document page. Preserve reading order. Use Markdown headings and lists where appropriate. Output only the extracted content — no commentary.`;

type QueueEntry = { abort: AbortController };

const queues = new Map<string, QueueEntry>();
const pageInflight = new Map<string, Promise<void>>();

function pageKey(path: string, page: number): string {
  return `${path}\0${page}`;
}

function sparsePages(doc: LoadedDocument): number[] {
  const pages = docCache.getPages(doc.path);
  return pages
    .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
    .map((p) => p.page)
    .slice(0, MAX_INDEX_PAGES);
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

async function visionImageBytes(
  path: string,
  page: number,
  signal: AbortSignal,
): Promise<{ bytes: Uint8Array; mediaType: string }> {
  const doc = docCache.get(path);
  if (doc?.kind === "image") {
    return {
      bytes: await readAuthorizedFileBytes(path, signal),
      mediaType: visionMediaType(path),
    };
  }
  return {
    bytes: await renderPageToJpegBytes(path, page, 1568, 0.85, signal),
    mediaType: "image/jpeg",
  };
}

async function indexPage(path: string, page: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || !docCache.has(path)) return;

  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) {
    emitPageIndex({ path, page, status: "done", source: "cache" });
    return;
  }

  emitPageIndex({ path, page, status: "indexing", source: "vision" });

  try {
    const settings = await loadVisionSettings();
    assertApiKeyForAgent(settings);
    const { bytes, mediaType } = await visionImageBytes(path, page, signal);
    if (signal.aborted) {
      emitPageIndex({ path, page, status: "idle" });
      return;
    }

    const text = await generateVisionText(settings, VISION_PROMPT, bytes, {
      signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
      mediaType,
    });

    if (text.trim().length >= MIN_INDEX_CHARS) {
      docCache.upsertPageText(path, page, text.trim());
      emitPageIndex({ path, page, status: "done", source: "vision" });
    } else {
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
      emitPageIndex({ path, page, status: "idle" });
      return;
    }
    const detail = formatLlmError(err, undefined, "scan");
    if (import.meta.env.DEV) {
      console.warn(`[index] page ${page}:`, detail);
    }
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

async function runIndexPage(path: string, page: number, signal: AbortSignal): Promise<void> {
  const key = pageKey(path, page);
  const existing = pageInflight.get(key);
  if (existing) {
    await existing;
    return;
  }

  const promise = indexPage(path, page, signal).finally(() => {
    if (pageInflight.get(key) === promise) {
      pageInflight.delete(key);
    }
  });
  pageInflight.set(key, promise);
  await promise;
}

async function runPool(path: string, pages: number[], signal: AbortSignal): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (!signal.aborted) {
      const i = cursor++;
      if (i >= pages.length) break;
      await runIndexPage(path, pages[i]!, signal);
    }
  });
  await Promise.all(workers);
}

export async function ensurePageIndexed(
  path: string,
  page: number,
  signal?: AbortSignal,
): Promise<void> {
  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) return;

  const controller = new AbortController();
  if (signal) {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  await runIndexPage(path, page, controller.signal);
}

/** Index one page in the background (preview on-demand). */
export function indexPageInBackground(path: string, page: number): void {
  void ensurePageIndexed(path, page);
}

/** Cancel any in-flight queue for this path and start a new sweep. */
export function scheduleIndex(doc: LoadedDocument, options?: { allPages?: boolean }): void {
  queues.get(doc.path)?.abort.abort();
  const controller = new AbortController();
  queues.set(doc.path, { abort: controller });

  const pages = options?.allPages
    ? docCache.getPages(doc.path).map((p) => p.page).slice(0, MAX_INDEX_PAGES)
    : sparsePages(doc);

  if (pages.length === 0) return;

  void runPool(doc.path, pages, controller.signal).finally(() => {
    if (queues.get(doc.path)?.abort === controller) {
      queues.delete(doc.path);
    }
  });
}

export function cancelIndex(path: string): void {
  queues.get(path)?.abort.abort();
  queues.delete(path);
}

export function reindexDocument(path: string): void {
  docCache.invalidateIndexedPageText(path);
  const fresh = docCache.get(path);
  if (fresh) scheduleIndex(fresh, { allPages: true });
}
