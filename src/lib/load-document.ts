import { invoke } from "@tauri-apps/api/core";
import { docCache } from "./doc-cache";
import { extractPdfFromRust, getPdfPageCount } from "./pdf";
import { report, type LoadProgressCallback } from "./load-progress";
import type { LoadedDocument } from "./types";

const SUPPORTED_EXT = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "tiff",
  "bmp",
  "gif",
]);

export function isSupportedDocument(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXT.has(ext);
}

export async function loadDocument(
  path: string,
  onProgress?: LoadProgressCallback,
): Promise<LoadedDocument> {
  if (!isSupportedDocument(path)) {
    throw new Error("Unsupported file type. Use PDF or image files.");
  }

  const name = path.split(/[/\\]/).pop() ?? path;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";

  report(onProgress, { stage: "opening", message: "Opening file…", percent: 5 });

  let doc: LoadedDocument;

  if (ext === "pdf") {
    report(onProgress, { stage: "extracting", message: "Extracting text…", percent: 15 });

    const pageCountPromise = getPdfPageCount(path).catch(() => null);
    const result = await extractPdfFromRust(path);
    const pageCount = result.total_pages || (await pageCountPromise) || result.pages.length;

    report(onProgress, {
      stage: "extracting",
      message: `Extracted ${pageCount} page${pageCount === 1 ? "" : "s"}`,
      percent: 70,
    });

    report(onProgress, { stage: "indexing", message: "Indexing for search…", percent: 85 });

    doc = {
      path,
      name,
      kind: "pdf",
      pages: result.pages.map((p) => ({ page: p.page, text: p.text })),
      totalPages: result.total_pages,
    };

    // Yield so UI can paint progress
    await new Promise((r) => setTimeout(r, 0));
  } else {
    report(onProgress, { stage: "ocr", message: "Running OCR…", percent: 30 });
    const text = await invoke<string>("ocr_image", { path });
    report(onProgress, { stage: "indexing", message: "Indexing for search…", percent: 85 });
    doc = {
      path,
      name,
      kind: "image",
      pages: [{ page: 1, text }],
      totalPages: 1,
    };
  }

  docCache.set(doc);
  report(onProgress, { stage: "done", message: "Ready", percent: 100 });
  return doc;
}
