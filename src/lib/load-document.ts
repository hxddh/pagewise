import { docCache } from "./doc-cache";
import { extractAllPageTexts, getPdfPageCount } from "./pdf";
import { report, type LoadProgressCallback } from "./load-progress";
import type { LoadedDocument } from "./types";
import { indexPageInBackground, MIN_INDEX_CHARS } from "./vision-index";
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

    const pageCount = await getPdfPageCount(path);

    report(onProgress, {
      stage: "extracting",
      message: "load.extractedPages",
      messageParams: { count: pageCount },
      percent: 40,
    });

    // Fast path: open with page 1 empty, fill text in background via pdf.js.
    doc = {
      path,
      name,
      kind: "pdf",
      pages: Array.from({ length: pageCount }, (_, i) => ({ page: i + 1, text: "" })),
      totalPages: pageCount,
    };

    docCache.set(doc);

    report(onProgress, { stage: "indexing", message: "load.indexing", percent: 55 });

    void extractAllPageTexts(path, (page, text) => {
      docCache.upsertPageText(path, page, text);
    }).then((pages) => {
      const cached = docCache.get(path);
      if (cached) {
        docCache.set({
          ...cached,
          pages: pages.length ? pages : cached.pages,
        });
      }
    });

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
    docCache.set(doc);
  }

  const first = doc.pages[0];
  if (first && first.text.trim().length < MIN_INDEX_CHARS) {
    indexPageInBackground(path, 1, doc.kind);
  }

  report(onProgress, { stage: "done", message: "load.ready", percent: 100 });
  return docCache.get(path) ?? doc;
}
