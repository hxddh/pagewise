import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { docCache } from "./doc-cache";
import {
  clearPageIndexState,
  emitPageIndex,
  getPageIndexState,
  type IndexFailureReason,
} from "./index-events";
import { assertApiKeyForAgent, formatLlmError } from "./llm";
import { generateVisionText } from "./vision-api";
import { isVisionModel, canAttemptVisionIndexing } from "./model-capabilities";
import { ocrPdfPage, renderPageToJpegBytes } from "./pdf";
import { loadVisionSettings } from "./settings";
import type { LoadedDocument } from "./types";
import type { LlmSettings } from "./types";
import { MIN_INDEX_CHARS } from "./page-text-merge";

export { MIN_INDEX_CHARS } from "./page-text-merge";

const VISION_MAX_EDGE = 1568;
const VISION_JPEG_QUALITY = 0.85;

/** Hard timeout for a single vision extraction call. */
const VISION_TIMEOUT_MS = 60_000;

/** Default worker-pool width for background sparse-page indexing. */
const DEFAULT_INDEX_CONCURRENCY = 3;

/** Cap on how many pages one background sweep will index (cost control). */
const DEFAULT_MAX_INDEX_PAGES = 50;

/** Shared abort for preview / single-page background indexing (document switch). */
let backgroundIndexController: AbortController | null = null;

/** Abort signal from the active agent stream (Stop / document switch). */
let agentRunAbortSignal: AbortSignal | undefined;

/** In-flight dedupe: one index run per path+page at a time. */
interface InflightIndexEntry {
  promise: Promise<{ text: string; source: "vision" | "ocr" | "cache" }>;
  localAbort: AbortController;
}

const inflightIndex = new Map<string, InflightIndexEntry>();

export interface IndexPageOptions {
  /** Abort in-flight work (e.g. when the active document switches). */
  signal?: AbortSignal;
  /** Per-call vision timeout (ms). */
  timeoutMs?: number;
  /** When true, a rate-limit (429) is re-thrown so a caller can back off. */
  throwOnRateLimit?: boolean;
}

export interface IndexSparsePagesOptions {
  signal?: AbortSignal;
  concurrency?: number;
  maxPages?: number;
}

export interface IndexSparsePagesResult {
  /** Pages that ended with sufficient indexed text. */
  indexed: number;
  /** Pages scheduled in this sweep (may include failures). */
  scheduled: number;
  skipped: number;
  capped: boolean;
}

/** Replace the shared background-index abort controller (aborts the prior one). */
export function setBackgroundIndexAbortController(controller: AbortController | null): void {
  backgroundIndexController?.abort();
  backgroundIndexController = controller;
}

export function getBackgroundIndexSignal(): AbortSignal | undefined {
  return backgroundIndexController?.signal;
}

/** Wire the active chat stream abort signal so tool-time indexing honors Stop. */
export function setAgentRunAbortSignal(signal: AbortSignal | undefined): void {
  agentRunAbortSignal = signal;
}

export function clearAgentRunAbortSignal(): void {
  agentRunAbortSignal = undefined;
}

export function getAgentRunAbortSignal(): AbortSignal | undefined {
  return agentRunAbortSignal;
}

function inflightKey(path: string, page: number): string {
  return `${path}:${page}`;
}

function resolveIndexSignal(options: IndexPageOptions): AbortSignal | undefined {
  const parts = [options.signal, agentRunAbortSignal, getBackgroundIndexSignal()].filter(
    Boolean,
  ) as AbortSignal[];
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return AbortSignal.any(parts);
}

/** Combine an optional caller signal with a timeout signal. */
function withTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Best-effort detection of provider rate-limit (HTTP 429) errors. */
function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const anyErr = err as { statusCode?: number; status?: number; message?: unknown };
  if (anyErr.statusCode === 429 || anyErr.status === 429) return true;
  const message = typeof anyErr.message === "string" ? anyErr.message : String(err);
  return /\b429\b|rate.?limit|too many requests/i.test(message);
}

function handleIndexAbort(
  path: string,
  page: number,
  cached: { text: string } | undefined,
): { text: string; source: "vision" | "ocr" | "cache" } {
  clearPageIndexState(path, page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) {
    return { text: cached.text, source: "cache" };
  }
  return { text: cached?.text ?? "", source: "ocr" };
}

const VISION_PROMPTS = {
  text: `Extract all visible text from this document page. Preserve reading order. Use Markdown headings and lists where appropriate. Output only the extracted content — no commentary.`,
  structure: `Extract all visible text and structure from this image (mind map, diagram, poster, or screenshot). Output Markdown with clear hierarchy: main topic, branches, and key points. Include every readable label. No commentary.`,
} as const;

export type VisionFocus = keyof typeof VISION_PROMPTS;

export class VisionNotSupportedError extends Error {
  constructor(model: string) {
    super(`Model "${model}" does not support image input`);
    this.name = "VisionNotSupportedError";
  }
}

async function readImageBytes(path: string): Promise<Uint8Array> {
  try {
    const raw = await invoke<unknown>("read_file_bytes", { path });
    if (raw instanceof Uint8Array) return raw;
    if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
    if (ArrayBuffer.isView(raw)) {
      const view = raw as ArrayBufferView;
      return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
    if (Array.isArray(raw)) return new Uint8Array(raw);
  } catch {
    /* fall through */
  }
  const url = convertFileSrc(path);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to read image: ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

export async function compressImageForVision(bytes: Uint8Array): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  const bitmap = await createImageBitmap(blob);
  const maxEdge = Math.max(bitmap.width, bitmap.height);
  const scale = maxEdge > VISION_MAX_EDGE ? VISION_MAX_EDGE / maxEdge : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Failed to prepare image for vision");
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const compressed = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Image compression failed"))),
      "image/jpeg",
      VISION_JPEG_QUALITY,
    );
  });
  return new Uint8Array(await compressed.arrayBuffer());
}

async function loadPageImageBytes(
  path: string,
  page: number,
  kind: "pdf" | "image",
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (kind === "image") return readImageBytes(path);
  return renderPageToJpegBytes(path, page, 1568, 0.85, signal);
}

export async function visionExtractPage(
  settings: LlmSettings,
  input: {
    path: string;
    page: number;
    kind: "pdf" | "image";
    focus?: VisionFocus;
  },
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ text: string }> {
  if (!isVisionModel(settings.provider, settings.model)) {
    throw new VisionNotSupportedError(settings.model);
  }

  const raw = await loadPageImageBytes(input.path, input.page, input.kind, options.signal);
  const image = await compressImageForVision(raw);
  const focus = input.focus ?? (input.kind === "image" ? "structure" : "text");

  const text = await generateVisionText(
    settings,
    VISION_PROMPTS[focus],
    image,
    { signal: withTimeoutSignal(options.signal, options.timeoutMs ?? VISION_TIMEOUT_MS) },
  );

  return { text: text.trim() };
}

async function localOcrPage(
  path: string,
  page: number,
  kind: "pdf" | "image",
  signal?: AbortSignal,
): Promise<string> {
  if (kind === "pdf") return ocrPdfPage(path, page, signal);
  return invoke<string>("ocr_image", { path });
}

async function isTesseractAvailable(): Promise<boolean> {
  try {
    const status = await invoke<{ installed: boolean; chi_sim: boolean }>("check_tesseract");
    return status.installed;
  } catch {
    return false;
  }
}

export function resolveIndexFailureReason(
  settings: LlmSettings,
  visionAttempted: boolean,
  visionFailed: boolean,
  ocrFailed: boolean,
  tesseractAvailable: boolean,
  pdfTextPending: boolean,
): IndexFailureReason {
  if (pdfTextPending) return "unknown";

  const hasVision = isVisionModel(settings.provider, settings.model);

  if (hasVision && visionAttempted && visionFailed && ocrFailed) {
    return "insufficient_text";
  }

  if (hasVision && visionAttempted && visionFailed) {
    return "vision_failed";
  }

  if (!hasVision) {
    if (!tesseractAvailable) return "need_vision";
    return "unknown";
  }

  if (!tesseractAvailable && ocrFailed) return "ocr_unavailable";
  return "unknown";
}

function assertIndexContinues(path: string, signal?: AbortSignal): void {
  if (signal?.aborted || !docCache.has(path)) {
    const err = new DOMException("Index aborted", "AbortError");
    throw err;
  }
}

async function indexPageTextInner(
  path: string,
  page: number,
  kind: "pdf" | "image",
  options: IndexPageOptions = {},
): Promise<{ text: string; source: "vision" | "ocr" | "cache" }> {
  const { signal, timeoutMs, throwOnRateLimit = false } = options;

  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) {
    return { text: cached.text, source: "cache" };
  }

  const priorState = getPageIndexState(path, page);
  if (priorState?.status === "done") {
    if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) {
      return { text: cached.text, source: "cache" };
    }
    clearPageIndexState(path, page);
  }
  if (priorState?.status === "failed") {
    clearPageIndexState(path, page);
  }

  if (signal?.aborted) {
    return handleIndexAbort(path, page, cached);
  }

  emitPageIndex({ path, page, status: "indexing" });

  try {
    const settings = await loadVisionSettings();
    assertIndexContinues(path, signal);
    const hasVision = canAttemptVisionIndexing(settings.provider, settings.model);
    let visionAttempted = false;
    let visionFailed = false;
    let visionError: string | undefined;
    let ocrFailed = false;

    if (hasVision) {
      visionAttempted = true;
      try {
        assertApiKeyForAgent(settings);
        const focus: VisionFocus = kind === "image" ? "structure" : "text";
        const { text } = await visionExtractPage(
          settings,
          { path, page, kind, focus },
          { signal, timeoutMs },
        );
        assertIndexContinues(path, signal);
        if (text.trim().length >= MIN_INDEX_CHARS) {
          docCache.upsertPageText(path, page, text);
          emitPageIndex({ path, page, status: "done", source: "vision" });
          return { text, source: "vision" };
        }
        visionFailed = true;
        visionError = `Scan model returned too little text (${text.trim().length} chars)`;
      } catch (err) {
        visionFailed = true;
        visionError = formatLlmError(err, undefined, "scan");
        console.warn("[vision-index] vision extraction failed:", visionError);
        if (isRateLimitError(err)) {
          if (throwOnRateLimit) {
            emitPageIndex({
              path,
              page,
              status: "failed",
              failureReason: "vision_failed",
              error: "rate_limited",
            });
            throw err;
          }
          // Non-pool path: fall through to local OCR instead of failing immediately.
          console.warn("[vision-index] rate limited (429); trying local OCR fallback.");
        }
        // Non-rate-limit vision error: fall through to local OCR.
      }
    }

    if (signal?.aborted) {
      return handleIndexAbort(path, page, cached);
    }

    try {
      const text = await localOcrPage(path, page, kind, signal);
      if (text.trim().length >= MIN_INDEX_CHARS) {
        docCache.upsertPageText(path, page, text);
        emitPageIndex({ path, page, status: "done", source: "ocr" });
        return { text, source: "ocr" };
      }
      ocrFailed = true;
    } catch {
      ocrFailed = true;
    }

    const tesseractAvailable = await isTesseractAvailable();
    const failureReason = resolveIndexFailureReason(
      settings,
      visionAttempted,
      visionFailed,
      ocrFailed,
      tesseractAvailable,
      false,
    );

    emitPageIndex({
      path,
      page,
      status: "failed",
      failureReason,
      error: visionError ?? failureReason,
    });
    return { text: "", source: "ocr" };
  } catch (err) {
    if (signal?.aborted) {
      return handleIndexAbort(path, page, cached);
    }

    // Rate-limit that a pool wants to propagate: state already emitted above.
    if (isRateLimitError(err) && throwOnRateLimit) throw err;

    // Any other unexpected throw (e.g. loadSettings rejecting) must still land
    // a terminal `failed` event so the status never sticks at "indexing".
    emitPageIndex({
      path,
      page,
      status: "failed",
      failureReason: "unknown",
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: "", source: "ocr" };
  }
}

/** Index one page: cache → vision (current model) → local OCR. */
export async function indexPageText(
  path: string,
  page: number,
  kind: "pdf" | "image",
  options: IndexPageOptions = {},
): Promise<{ text: string; source: "vision" | "ocr" | "cache" }> {
  const key = inflightKey(path, page);
  const existing = inflightIndex.get(key);
  if (existing) {
    if (options.signal) {
      options.signal.addEventListener("abort", () => existing.localAbort.abort(), {
        once: true,
      });
    }
    if (agentRunAbortSignal && !agentRunAbortSignal.aborted) {
      agentRunAbortSignal.addEventListener("abort", () => existing.localAbort.abort(), {
        once: true,
      });
    }
    return existing.promise;
  }

  const localAbort = new AbortController();
  const parts = [options.signal, localAbort.signal].filter(Boolean) as AbortSignal[];
  const combined =
    parts.length === 0
      ? undefined
      : parts.length === 1
        ? parts[0]
        : AbortSignal.any(parts);
  const resolvedOptions = { ...options, signal: resolveIndexSignal({ ...options, signal: combined }) };

  const work = indexPageTextInner(path, page, kind, resolvedOptions).finally(() => {
    inflightIndex.delete(key);
  });

  inflightIndex.set(key, { promise: work, localAbort });
  return work;
}

export function indexPageInBackground(
  path: string,
  page: number,
  kind: "pdf" | "image",
  options?: IndexPageOptions,
): void {
  void indexPageText(path, page, kind, options);
}

/**
 * Index every sparse page of a document through a bounded worker pool.
 *
 * - Runs at most `concurrency` (default 3) vision calls at once instead of
 *   fire-and-forgetting the whole document.
 * - Honors an `AbortSignal` so a document switch cancels in-flight work.
 * - Caps the sweep at `maxPages` (default 50) pages and logs when it clamps.
 * - Stops scheduling further work on a 429 rate-limit response.
 *
 * Returns a promise that resolves when the sweep finishes (or is aborted).
 */
export function indexSparsePages(
  doc: LoadedDocument,
  pages?: number[],
  options: IndexSparsePagesOptions = {},
): Promise<IndexSparsePagesResult> {
  const {
    signal,
    concurrency = DEFAULT_INDEX_CONCURRENCY,
    maxPages = DEFAULT_MAX_INDEX_PAGES,
  } = options;

  const targets =
    pages ??
    doc.pages
      .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
      .map((p) => p.page);

  const limited = targets.slice(0, Math.max(0, maxPages));
  const capped = limited.length < targets.length;
  if (capped) {
    console.warn(
      `[vision-index] page cap reached: indexing ${limited.length} of ${targets.length} sparse pages for ${doc.path}; remaining pages skipped this sweep.`,
    );
  }

  for (const page of limited) {
    clearPageIndexState(doc.path, page);
  }

  let succeeded = 0;
  return runIndexPool(limited, Math.max(1, concurrency), signal, async (page) => {
    const result = await indexPageText(doc.path, page, doc.kind, {
      signal,
      throwOnRateLimit: true,
    });
    if (result.text.trim().length >= MIN_INDEX_CHARS) succeeded++;
  }).then(() => ({
    indexed: succeeded,
    scheduled: limited.length,
    skipped: targets.length - limited.length,
    capped,
  }));
}

/** Minimal bounded worker pool that stops the whole sweep on a 429. */
async function runIndexPool(
  pages: number[],
  concurrency: number,
  signal: AbortSignal | undefined,
  worker: (page: number) => Promise<unknown>,
): Promise<void> {
  let cursor = 0;
  let stopped = false;

  const runOne = async (): Promise<void> => {
    while (!stopped) {
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= pages.length) return;
      try {
        await worker(pages[index]);
      } catch (err) {
        if (isRateLimitError(err)) {
          stopped = true;
          console.warn(
            "[vision-index] rate limited (429); halting further background indexing this sweep.",
          );
          return;
        }
        // Per-page failures already emit a `failed` event; keep the pool going.
      }
    }
  };

  const width = Math.min(concurrency, pages.length);
  await Promise.all(Array.from({ length: width }, () => runOne()));
}
