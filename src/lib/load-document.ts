import { docCache } from "./doc-cache";
import { extractPdfFromRust } from "./pdf";
import { report, type LoadProgressCallback } from "./load-progress";
import type { LoadedDocument } from "./types";
import { ensureSemanticIndex } from "./semantic-index";
import { allowPath } from "./fs-access";

const SUPPORTED_EXT = new Set([
  "pdf",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "tif",
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
    throw new Error("errors.unsupportedFile");
  }

  const name = path.split(/[/\\]/).pop() ?? path;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";

  await allowPath(path);

  report(onProgress, { stage: "opening", message: "load.openingFile", percent: 5 });

  let doc: LoadedDocument;

  if (ext === "pdf") {
    report(onProgress, { stage: "extracting", message: "load.extracting", percent: 20 });

    // Rust extract on open — pdf.js text layer is unreliable in Tauri WebView.
    const extracted = await extractPdfFromRust(path);

    report(onProgress, {
      stage: "extracting",
      message: "load.extractedPages",
      messageParams: { count: extracted.total_pages },
      percent: 55,
    });

    doc = {
      path,
      name,
      kind: "pdf",
      pages: extracted.pages,
      totalPages: extracted.total_pages,
    };

    docCache.set(doc);
    void ensureSemanticIndex(path, doc.pages);
  } else {
    report(onProgress, { stage: "opening", message: "load.loadingImage", percent: 60 });
    doc = {
      path,
      name,
      kind: "image",
      pages: [{ page: 1, text: "" }],
      totalPages: 1,
    };
    docCache.set(doc);
    void ensureSemanticIndex(path, doc.pages);
  }

  report(onProgress, { stage: "done", message: "load.ready", percent: 100 });
  return docCache.get(path) ?? doc;
}
