import { docCache } from "./doc-cache";
import { getPdfAnnotations, getPdfOutline, getPdfPageLabels, openDocument } from "./pdf";
import { preferAuthoredOutline, usableOutline } from "./outline-nav";
import { throwIfAborted } from "./abort-utils";
import { report, type LoadProgressCallback } from "./load-progress";
import type { LoadedDocument } from "./types";
import { allowPath } from "./fs-access";
import { fileStamp } from "./file-stamp";
import { fileIdentity } from "./file-identity";
import { loadIndexedPages } from "./index-store";
import { mergePageTextsOnReload } from "./page-text-merge";
import { scheduleIndex } from "../document/index-queue";

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

export function inferDocumentKind(path: string): "pdf" | "image" {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext === "pdf" ? "pdf" : "image";
}

export interface LoadDocumentOptions {
  /** When true, build the document without touching docCache or the index queue. */
  deferCache?: boolean;
}

/** Commit a staged document after chat hydration succeeds. */
export function commitLoadedDocument(doc: LoadedDocument): LoadedDocument {
  docCache.set(doc);
  scheduleIndex(docCache.get(doc.path) ?? doc);
  return docCache.get(doc.path) ?? doc;
}

export async function loadDocument(
  path: string,
  onProgress?: LoadProgressCallback,
  signal?: AbortSignal,
  options?: LoadDocumentOptions,
): Promise<LoadedDocument> {
  if (!isSupportedDocument(path)) {
    throw new Error("errors.unsupportedFile");
  }

  const name = path.split(/[/\\]/).pop() ?? path;
  const kind = inferDocumentKind(path);

  await allowPath(path);

  // Stamped after authorization (the command requires it) and before extraction,
  // so a rewrite during the parse advances the real stamp and the next open
  // misses the cache instead of being served text from the older contents.
  const stamp = await fileStamp(path);
  // And what the file is, so a rename does not lose what was written on it.
  const identity = await fileIdentity(path);

  report(onProgress, { stage: "opening", message: "load.openingFile", percent: 5 });
  throwIfAborted(signal);

  let doc: LoadedDocument;

  if (kind === "pdf") {
    report(onProgress, { stage: "extracting", message: "load.extracting", percent: 20 });
    const model = await openDocument(path, signal);
    throwIfAborted(signal);

    report(onProgress, {
      stage: "extracting",
      message: "load.extractedPages",
      messageParams: { count: model.page_count },
      percent: 55,
    });

    doc = {
      path,
      name,
      kind: "pdf",
      pages: model.pages.map((p) => ({ page: p.page, text: p.text, source: "native" as const })),
      totalPages: model.page_count,
      stamp,
      ...(identity ? { identity } : {}),
      title: model.title ?? undefined,
      // Arbitrated here, once, rather than by each consumer remembering to.
      outline: preferAuthoredOutline(
        usableOutline(
          (await getPdfOutline(path))
            .filter((b): b is { title: string; page: number; level: number } => b.page !== null),
          model.page_count,
        ),
        usableOutline(model.structure_outline, model.page_count),
        usableOutline(model.outline, model.page_count),
      ),
      links: model.links,
      figures: model.figures,
      tablePages: model.pages.filter((p) => p.has_table).map((p) => p.page),
      // pdf.js, not Rust: `/PageLabels` is a document-level table and the
      // extractor does not surface it. Undefined for the common case.
      pageLabels: (await getPdfPageLabels(path, model.page_count)) ?? undefined,
      annotations: await getPdfAnnotations(path, model.page_count),
    };
  } else {
    report(onProgress, { stage: "opening", message: "load.loadingImage", percent: 60 });
    doc = {
      path,
      name,
      kind: "image",
      pages: [{ page: 1, text: "" }],
      totalPages: 1,
      stamp,
      ...(identity ? { identity } : {}),
    };
  }

  // Fold in page text that previously cost a vision call. Without this every
  // scanned page is re-indexed — and re-billed — on each launch.
  if (stamp) {
    const cached = await loadIndexedPages(path, stamp);
    if (cached.length > 0) {
      doc = { ...doc, pages: mergePageTextsOnReload(cached, doc.pages) };
    }
  }
  throwIfAborted(signal);

  if (options?.deferCache) {
    report(onProgress, { stage: "done", message: "load.ready", percent: 100 });
    return doc;
  }

  return commitLoadedDocument(doc);
}
