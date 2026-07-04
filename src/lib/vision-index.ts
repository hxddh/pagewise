import { invoke } from "@tauri-apps/api/core";
import { generateText } from "ai";
import { docCache } from "./doc-cache";
import {
  clearPageIndexState,
  emitPageIndex,
  getPageIndexState,
  type IndexFailureReason,
} from "./index-events";
import { resolveModel } from "./llm";
import { isVisionModel } from "./model-capabilities";
import { ocrPdfPage, renderPageToPngBytes } from "./pdf";
import { loadSettings } from "./settings";
import type { LoadedDocument } from "./types";
import type { LlmSettings } from "./types";

export const MIN_INDEX_CHARS = 20;

const VISION_MAX_EDGE = 1568;
const VISION_JPEG_QUALITY = 0.85;

/** Hard timeout for a single vision extraction call. */
const VISION_TIMEOUT_MS = 60_000;

/** Default worker-pool width for background sparse-page indexing. */
const DEFAULT_INDEX_CONCURRENCY = 3;

/** Cap on how many pages one background sweep will index (cost control). */
const DEFAULT_MAX_INDEX_PAGES = 50;

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
  const data = await invoke<number[]>("read_file_bytes", { path });
  return Uint8Array.from(data);
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
): Promise<Uint8Array> {
  if (kind === "image") return readImageBytes(path);
  return renderPageToPngBytes(path, page, 1.5);
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

  const raw = await loadPageImageBytes(input.path, input.page, input.kind);
  const image = await compressImageForVision(raw);
  const focus = input.focus ?? (input.kind === "image" ? "structure" : "text");

  const { text } = await generateText({
    model: resolveModel(settings),
    abortSignal: withTimeoutSignal(options.signal, options.timeoutMs ?? VISION_TIMEOUT_MS),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPTS[focus] },
          { type: "file", data: image, mediaType: "image/jpeg" },
        ],
      },
    ],
  });

  return { text: text.trim() };
}

async function localOcrPage(
  path: string,
  page: number,
  kind: "pdf" | "image",
): Promise<string> {
  if (kind === "pdf") return ocrPdfPage(path, page);
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

function resolveFailureReason(
  settings: LlmSettings,
  visionAttempted: boolean,
  visionFailed: boolean,
  ocrFailed: boolean,
  tesseractAvailable: boolean,
): IndexFailureReason {
  const hasVision = isVisionModel(settings.provider, settings.model);

  if (hasVision && visionAttempted && visionFailed) {
    return ocrFailed && !tesseractAvailable ? "ocr_unavailable" : "vision_failed";
  }

  if (!hasVision) {
    if (!tesseractAvailable) return "need_vision";
    return "unknown";
  }

  if (!tesseractAvailable && ocrFailed) return "ocr_unavailable";
  return "unknown";
}

/** Index one page: cache → vision (current model) → local OCR. */
export async function indexPageText(
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

  // Consult the per-page index state so genuinely-short pages (blank, "7", a
  // logo) that were already processed are not re-billed on every read.
  const priorState = getPageIndexState(path, page);
  if (priorState?.status === "done") {
    return { text: cached?.text ?? "", source: "cache" };
  }
  if (priorState?.status === "failed") {
    // Already attempted and failed; don't spend another paid call until the
    // state is explicitly cleared (e.g. via a user-triggered reindex).
    return { text: cached?.text ?? "", source: "ocr" };
  }

  if (signal?.aborted) {
    return { text: cached?.text ?? "", source: "ocr" };
  }

  emitPageIndex({ path, page, status: "indexing" });

  try {
    const settings = await loadSettings();
    const hasVision = isVisionModel(settings.provider, settings.model);
    let visionAttempted = false;
    let visionFailed = false;
    let ocrFailed = false;

    if (hasVision) {
      visionAttempted = true;
      try {
        const focus: VisionFocus = kind === "image" ? "structure" : "text";
        const { text } = await visionExtractPage(
          settings,
          { path, page, kind, focus },
          { signal, timeoutMs },
        );
        if (text.trim().length > 0) {
          docCache.upsertPageText(path, page, text);
          emitPageIndex({ path, page, status: "done", source: "vision" });
          return { text, source: "vision" };
        }
        visionFailed = true;
      } catch (err) {
        visionFailed = true;
        if (isRateLimitError(err)) {
          emitPageIndex({
            path,
            page,
            status: "failed",
            failureReason: "vision_failed",
            error: "rate_limited",
          });
          if (throwOnRateLimit) throw err;
          return { text: "", source: "vision" };
        }
        // Non-rate-limit vision error: fall through to local OCR.
      }
    }

    try {
      const text = await localOcrPage(path, page, kind);
      if (text.trim().length > 0) {
        docCache.upsertPageText(path, page, text);
        emitPageIndex({ path, page, status: "done", source: "ocr" });
        return { text, source: "ocr" };
      }
      ocrFailed = true;
    } catch {
      ocrFailed = true;
    }

    const tesseractAvailable = await isTesseractAvailable();
    const failureReason = resolveFailureReason(
      settings,
      visionAttempted,
      visionFailed,
      ocrFailed,
      tesseractAvailable,
    );

    emitPageIndex({
      path,
      page,
      status: "failed",
      failureReason,
      error: failureReason,
    });
    return { text: "", source: "ocr" };
  } catch (err) {
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
): Promise<void> {
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
  if (limited.length < targets.length) {
    console.warn(
      `[vision-index] page cap reached: indexing ${limited.length} of ${targets.length} sparse pages for ${doc.path}; remaining pages skipped this sweep.`,
    );
  }

  for (const page of limited) {
    clearPageIndexState(doc.path, page);
  }

  return runIndexPool(limited, Math.max(1, concurrency), signal, (page) =>
    indexPageText(doc.path, page, doc.kind, { signal, throwOnRateLimit: true }),
  );
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
