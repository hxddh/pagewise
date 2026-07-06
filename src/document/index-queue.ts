/**
 * v3 indexing: vision-only, single queue per document. No OCR.
 */
import { docCache } from "../lib/doc-cache";
import { renderPageToJpegBytes } from "../lib/pdf";
import { generateVisionText } from "../lib/vision-api";
import { loadSettings } from "../lib/settings";
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

function sparsePages(doc: LoadedDocument): number[] {
  return doc.pages
    .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
    .map((p) => p.page)
    .slice(0, MAX_INDEX_PAGES);
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
    const settings = await loadSettings();
    assertApiKeyForAgent(settings);
    const visionModel = settings.model;
    const jpeg = await renderPageToJpegBytes(path, page, 1568, 0.85, signal);
    if (signal.aborted) return;

    const text = await generateVisionText(
      { ...settings, model: visionModel },
      VISION_PROMPT,
      jpeg,
      { signal: AbortSignal.timeout(VISION_TIMEOUT_MS) },
    );

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

async function runPool(
  path: string,
  pages: number[],
  signal: AbortSignal,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (!signal.aborted) {
      const i = cursor++;
      if (i >= pages.length) break;
      await indexPage(path, pages[i]!, signal);
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
  await indexPage(path, page, controller.signal);
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
    ? doc.pages.map((p) => p.page).slice(0, MAX_INDEX_PAGES)
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

export function reindexDocument(doc: LoadedDocument): void {
  const path = doc.path;
  for (const p of doc.pages) {
    if (p.text.trim().length >= MIN_INDEX_CHARS) {
      docCache.upsertPageText(path, p.page, "");
    }
  }
  const fresh = docCache.get(path);
  if (fresh) scheduleIndex(fresh, { allPages: true });
}
