import { docCache, mergeTablePages } from "./doc-cache";
import {
  disposeDocumentResources,
  documentKind,
  getPdfAnnotations,
  getPdfOutline,
  getPdfPageLabels,
  openDocument,
  preparePdfSwitch,
} from "./pdf";
import { preflightDocument } from "./preflight-document";
import { classifyOpenError } from "./open-error";
import { preferAuthoredOutline, usableOutline } from "./outline-nav";
import { throwIfAborted } from "./abort-utils";
import { report, type LoadProgressCallback } from "./load-progress";
import type { LoadedDocument } from "./types";
import { requireGrantedPath } from "./allowed-paths";
import { fileStamp } from "./file-stamp";
import { fileIdentity } from "./file-identity";
import { loadIndexedPages } from "./index-store";
import { mergePageTextsOnReload } from "./page-text-merge";
import { scheduleIndex } from "../document/index-queue";
import { restoreOcr } from "./ocr/ocr-service";

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

/**
 * Whether a remembered path looks like a document, by its name. Only for
 * tidying lists of paths (the library); whether a file opens, and as what, is
 * decided by its content in Rust when it is opened (24.0, `documentKind`).
 */
export function isSupportedDocument(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXT.has(ext);
}

export interface LoadDocumentOptions {
  /** When true, build the document without touching docCache or the index queue. */
  deferCache?: boolean;
  /** True when reloading the currently open document in place (preserves session state on encrypted prompt). */
  isReload?: boolean;
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
  const name = path.split(/[/\\]/).pop() ?? path;

  await requireGrantedPath(path);
  // Single-IPC preflight (27.0) reads kind, stamp and fingerprint in one open;
  // unit tests that mock `documentKind`/`fileStamp` individually fall back cleanly.
  let kind: "pdf" | "image";
  let stamp: string;
  let identity: string;
  const preflight = await preflightDocument(path);
  if (preflight) {
    kind = preflight.kind;
    stamp = preflight.stamp;
    identity = preflight.identity;
  } else {
    kind = await documentKind(path);
    [stamp, identity] = await Promise.all([fileStamp(path), fileIdentity(path)]);
  }

  report(onProgress, { stage: "opening", message: "load.openingFile", percent: 5 });
  throwIfAborted(signal);

  let doc: LoadedDocument;

  if (kind === "pdf") {
    preparePdfSwitch(path);
    try {
      report(onProgress, { stage: "extracting", message: "load.extracting", percent: 20 });
      const model = await openDocument(path, signal);
      throwIfAborted(signal);

      report(onProgress, {
        stage: "extracting",
        message: "load.extractedPages",
        messageParams: { count: model.page_count },
        percent: 55,
      });

      const [rawOutline, rawLabels, annotations] = await Promise.all([
        getPdfOutline(path),
        getPdfPageLabels(path, model.page_count),
        getPdfAnnotations(path, model.page_count, undefined, signal),
      ]);
      throwIfAborted(signal);

      doc = {
        path,
        name,
        kind: "pdf",
        pages: model.pages.map((p) => ({ page: p.page, text: p.text, source: "native" as const })),
        totalPages: model.page_count,
        stamp,
        ...(identity ? { identity } : {}),
        title: model.title ?? undefined,
        outline: preferAuthoredOutline(
          usableOutline(
            rawOutline.filter((b): b is { title: string; page: number; level: number } => b.page !== null),
            model.page_count,
          ),
          usableOutline(model.structure_outline, model.page_count),
          usableOutline(model.outline, model.page_count),
        ),
        links: model.links,
        figures: model.figures,
        tablePages: model.pages.filter((p) => p.has_table).map((p) => p.page),
        pageLabels: rawLabels ?? undefined,
        annotations,
      };
    } catch (err) {
      if (!(options?.isReload && classifyOpenError(err)?.kind === "encrypted")) {
        disposeDocumentResources(path);
      }
      throw err;
    }
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

  // Fold in cached vision text and local OCR text in parallel (27.0).
  const [cached, recognised] = await Promise.all([
    stamp ? loadIndexedPages(path, stamp, identity) : Promise.resolve([]),
    restoreOcr(path, identity),
  ]);
  if (cached.length > 0) {
    doc = { ...doc, pages: mergePageTextsOnReload(cached, doc.pages) };
  }
  if (recognised.length > 0) {
    doc = { ...doc, pages: mergePageTextsOnReload(recognised, doc.pages) };
  }
  const tablePages = mergeTablePages(doc.tablePages, doc.pages);
  if (tablePages !== undefined) {
    doc = { ...doc, tablePages };
  }
  throwIfAborted(signal);

  if (options?.deferCache) {
    report(onProgress, { stage: "done", message: "load.ready", percent: 100 });
    return doc;
  }

  return commitLoadedDocument(doc);
}
