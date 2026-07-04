import { docCache } from "./doc-cache";
import { extractPdfFromRust, getPdfPageCount } from "./pdf";
import { report, type LoadProgressCallback } from "./load-progress";
import type { LoadedDocument } from "./types";
import { indexPageInBackground, MIN_INDEX_CHARS } from "./vision-index";

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

  report(onProgress, { stage: "opening", message: "load.openingFile", percent: 5 });

  let doc: LoadedDocument;

  if (ext === "pdf") {
    report(onProgress, { stage: "extracting", message: "load.extracting", percent: 15 });

    const pageCountPromise = getPdfPageCount(path).catch(() => null);
    const result = await extractPdfFromRust(path);
    const pageCount = result.total_pages || (await pageCountPromise) || result.pages.length;

    report(onProgress, {
      stage: "extracting",
      message: "load.extractedPages",
      messageParams: { count: pageCount },
      percent: 70,
    });

    report(onProgress, { stage: "indexing", message: "load.indexing", percent: 85 });

    doc = {
      path,
      name,
      kind: "pdf",
      pages: result.pages.map((p) => ({ page: p.page, text: p.text })),
      totalPages: result.total_pages,
    };

    await new Promise((r) => setTimeout(r, 0));
  } else {
    report(onProgress, { stage: "opening", message: "load.loadingImage", percent: 60 });
    doc = {
      path,
      name,
      kind: "image",
      pages: [{ page: 1, text: "" }],
      totalPages: 1,
    };
  }

  docCache.set(doc);

  const first = doc.pages[0];
  if (first && first.text.trim().length < MIN_INDEX_CHARS) {
    indexPageInBackground(path, 1, doc.kind);
  }

  report(onProgress, { stage: "done", message: "load.ready", percent: 100 });
  return doc;
}
