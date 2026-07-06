import { docCache } from "./doc-cache";
import { extractPdfFromRust } from "./pdf";
import { throwIfAborted } from "./abort-utils";
import { report, type LoadProgressCallback } from "./load-progress";
import type { LoadedDocument } from "./types";
import { allowPath } from "./fs-access";
import { scheduleIndex } from "../document/index-queue";

export function isSupportedDocument(path: string): boolean {
  return path.toLowerCase().endsWith(".pdf");
}

export async function loadDocument(
  path: string,
  onProgress?: LoadProgressCallback,
  signal?: AbortSignal,
): Promise<LoadedDocument> {
  if (!isSupportedDocument(path)) {
    throw new Error("errors.unsupportedFile");
  }

  const name = path.split(/[/\\]/).pop() ?? path;
  await allowPath(path);

  report(onProgress, { stage: "opening", message: "load.openingFile", percent: 5 });
  throwIfAborted(signal);

  report(onProgress, { stage: "extracting", message: "load.extracting", percent: 20 });
  const extracted = await extractPdfFromRust(path, signal);
  throwIfAborted(signal);

  report(onProgress, {
    stage: "extracting",
    message: "load.extractedPages",
    messageParams: { count: extracted.total_pages },
    percent: 55,
  });

  const doc: LoadedDocument = {
    path,
    name,
    kind: "pdf",
    pages: extracted.pages,
    totalPages: extracted.total_pages,
  };

  docCache.set(doc);
  throwIfAborted(signal);
  scheduleIndex(docCache.get(path) ?? doc);

  report(onProgress, { stage: "done", message: "load.ready", percent: 100 });
  return docCache.get(path) ?? doc;
}
