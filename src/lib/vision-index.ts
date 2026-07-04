import { invoke } from "@tauri-apps/api/core";
import { generateText } from "ai";
import { docCache } from "./doc-cache";
import { clearPageIndexState, emitPageIndex, type IndexFailureReason } from "./index-events";
import { resolveModel } from "./llm";
import { isVisionModel } from "./model-capabilities";
import { ocrPdfPage, renderPageToPngBytes } from "./pdf";
import { loadSettings } from "./settings";
import type { LoadedDocument } from "./types";
import type { LlmSettings } from "./types";

export const MIN_INDEX_CHARS = 20;

const VISION_MAX_EDGE = 1568;
const VISION_JPEG_QUALITY = 0.85;

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
): Promise<{ text: string }> {
  if (!isVisionModel(settings.provider, settings.model)) {
    throw new VisionNotSupportedError(settings.model);
  }

  const raw = await loadPageImageBytes(input.path, input.page, input.kind);
  const image = await compressImageForVision(raw);
  const focus = input.focus ?? (input.kind === "image" ? "structure" : "text");

  const { text } = await generateText({
    model: resolveModel(settings),
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
    return await invoke<boolean>("check_tesseract");
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
): Promise<{ text: string; source: "vision" | "ocr" | "cache" }> {
  const cached = docCache.getPages(path).find((p) => p.page === page);
  if (cached && cached.text.trim().length >= MIN_INDEX_CHARS) {
    return { text: cached.text, source: "cache" };
  }

  emitPageIndex({ path, page, status: "indexing" });

  const settings = await loadSettings();
  const hasVision = isVisionModel(settings.provider, settings.model);
  let visionAttempted = false;
  let visionFailed = false;
  let ocrFailed = false;

  if (hasVision) {
    visionAttempted = true;
    try {
      const focus: VisionFocus = kind === "image" ? "structure" : "text";
      const { text } = await visionExtractPage(settings, { path, page, kind, focus });
      if (text.trim().length > 0) {
        docCache.upsertPageText(path, page, text);
        emitPageIndex({ path, page, status: "done", source: "vision" });
        return { text, source: "vision" };
      }
      visionFailed = true;
    } catch {
      visionFailed = true;
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
}

export function indexPageInBackground(
  path: string,
  page: number,
  kind: "pdf" | "image",
): void {
  void indexPageText(path, page, kind);
}

export function indexSparsePages(doc: LoadedDocument, pages?: number[]): void {
  const targets =
    pages ??
    doc.pages
      .filter((p) => p.text.trim().length < MIN_INDEX_CHARS)
      .map((p) => p.page);

  for (const page of targets) {
    clearPageIndexState(doc.path, page);
    indexPageInBackground(doc.path, page, doc.kind);
  }
}
