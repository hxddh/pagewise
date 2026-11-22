import { docCache, mergeTablePages } from "./doc-cache";
import {
  disposeDocumentResources,
  documentKind,
  getInitialPageSize,
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
  /** Initial target page so Page 1 / resume page dimensions are pre-seeded on Render 1 (29.0). */
  initialPage?: number;
  /** Fired right after preflight resolves `(kind, stamp, identity)` so store reads can run in parallel (29.0). */
  onPreflight?: (meta: { kind: "pdf" | "image"; stamp: string; identity: string }) => void;
  /** Fired if pdf.js finishes Page 1 geometry before full Rust extraction completes on large PDFs (29.0). */
  onFastShell?: (doc: LoadedDocument) => void;
  /** Scan PDF annotations in the background after first paint instead of blocking open (29.0). */
  deferAnnotations?: boolean;
  /** Skip `scheduleIndex` inside `commitLoadedDocument` so caller can start it after paint (29.0). */
  deferScheduleIndex?: boolean;
}

const pendingExtractions = new Map<string, Promise<void>>();

/** Wait for an in-flight progressive extraction on `path`, if any, before agent tools read `docCache`. */
export async function waitForDocumentExtraction(path: string): Promise<void> {
  const pending = pendingExtractions.get(path);
  if (pending) await pending.catch(() => {});
}

/** Commit a staged document after chat hydration succeeds. */
export function commitLoadedDocument(
  doc: LoadedDocument,
  options?: { deferScheduleIndex?: boolean },
): LoadedDocument {
  docCache.set(doc);
  const current = docCache.get(doc.path) ?? doc;
  if (!options?.deferScheduleIndex && !current.extracting) {
    scheduleIndex(current);
  }
  return current;
}

export async function loadDocument(
  path: string,
  onProgress?: LoadProgressCallback,
  signal?: AbortSignal,
  options?: LoadDocumentOptions,
): Promise<LoadedDocument> {
  const name = path.split(/[/\\]/).pop() ?? path;

  // Run allowlist check and single-IPC preflight concurrently (29.0).
  const [, preflight] = await Promise.all([requireGrantedPath(path), preflightDocument(path)]);
  let kind: "pdf" | "image";
  let stamp: string;
  let identity: string;
  if (preflight) {
    kind = preflight.kind;
    stamp = preflight.stamp;
    identity = preflight.identity;
  } else {
    kind = await documentKind(path);
    [stamp, identity] = await Promise.all([fileStamp(path), fileIdentity(path)]);
  }
  options?.onPreflight?.({ kind, stamp, identity });

  report(onProgress, { stage: "opening", message: "load.openingFile", percent: 5 });
  throwIfAborted(signal);

  // Start reading cached vision & OCR pages immediately in parallel with PDF open (29.0).
  const storedPagesPromise = Promise.all([
    stamp ? loadIndexedPages(path, stamp, identity) : Promise.resolve([]),
    restoreOcr(path, identity),
  ]);

  let doc: LoadedDocument;

  if (kind === "pdf") {
    preparePdfSwitch(path);
    let resolveExtraction!: () => void;
    const extractionBarrier = new Promise<void>((r) => {
      resolveExtraction = r;
    });
    pendingExtractions.set(path, extractionBarrier);

    try {
      report(onProgress, { stage: "extracting", message: "load.extracting", percent: 20 });

      const targetPage = Math.max(1, options?.initialPage ?? 1);
      let extractionDone = false;
      const modelPromise = openDocument(path, signal).finally(() => {
        extractionDone = true;
      });

      // Kick off pdf.js visual fast-track concurrently with Rust `openDocument`!
      const fastPdfPromise = (async () => {
        const firstSize = await getInitialPageSize(path, targetPage);
        const page1Size =
          firstSize && firstSize.page !== 1 ? await getInitialPageSize(path, 1) : firstSize;
        const [rawOutline, rawLabels] = await Promise.all([
          getPdfOutline(path),
          firstSize ? getPdfPageLabels(path, firstSize.numPages) : Promise.resolve(null),
        ]);
        const seededSizes: Array<{ page: number; size: { width: number; height: number } }> = [];
        if (page1Size) seededSizes.push({ page: page1Size.page, size: page1Size.size });
        if (firstSize && firstSize.page !== 1) {
          seededSizes.push({ page: firstSize.page, size: firstSize.size });
        }

        if (
          options?.onFastShell &&
          !extractionDone &&
          !signal?.aborted &&
          firstSize &&
          firstSize.numPages > 0
        ) {
          const fastOutline = usableOutline(
            rawOutline.filter(
              (b): b is { title: string; page: number; level: number } => b.page !== null,
            ),
            firstSize.numPages,
          );
          options.onFastShell({
            path,
            name,
            kind: "pdf",
            pages: Array.from({ length: firstSize.numPages }, (_, i) => ({
              page: i + 1,
              text: "",
              source: "native" as const,
            })),
            totalPages: firstSize.numPages,
            stamp,
            ...(identity ? { identity } : {}),
            outline: fastOutline,
            pageLabels: rawLabels ?? undefined,
            initialPageSizes: seededSizes.length > 0 ? seededSizes : undefined,
            extracting: true,
          });
        }
        return { firstSize, rawOutline, rawLabels, seededSizes };
      })();

      const [model, fastPdf] = await Promise.all([modelPromise, fastPdfPromise]);
      throwIfAborted(signal);

      report(onProgress, {
        stage: "extracting",
        message: "load.extractedPages",
        messageParams: { count: model.page_count },
        percent: 55,
      });

      const rawLabels =
        fastPdf.rawLabels ?? (await getPdfPageLabels(path, model.page_count));
      const annotations = options?.deferAnnotations
        ? []
        : await getPdfAnnotations(path, model.page_count, undefined, signal);
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
            fastPdf.rawOutline.filter(
              (b): b is { title: string; page: number; level: number } => b.page !== null,
            ),
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
        ...(fastPdf.seededSizes.length > 0 ? { initialPageSizes: fastPdf.seededSizes } : {}),
      };

      if (options?.deferAnnotations) {
        void getPdfAnnotations(path, model.page_count, undefined, signal)
          .then((loadedNotes) => {
            if (signal?.aborted || loadedNotes.length === 0) return;
            const current = docCache.get(path);
            if (!current || current.stamp !== stamp) return;
            docCache.set({ ...current, annotations: loadedNotes });
          })
          .catch(() => {});
      }
    } catch (err) {
      if (!(options?.isReload && classifyOpenError(err)?.kind === "encrypted")) {
        disposeDocumentResources(path);
      }
      throw err;
    } finally {
      resolveExtraction();
      if (pendingExtractions.get(path) === extractionBarrier) {
        pendingExtractions.delete(path);
      }
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

  const [cached, recognised] = await storedPagesPromise;
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

  return commitLoadedDocument(doc, { deferScheduleIndex: options?.deferScheduleIndex });
}
