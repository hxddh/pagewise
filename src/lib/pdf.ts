import type { PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import {
  getPdfJs,
  pdfCMapUrl,
  pdfStandardFontUrl,
  type PDFDocumentProxy,
} from "./pdf-loader";
import type { PreviewQuality } from "./types";
import type { PdfExtractResult } from "./types";
import { raceWithAbort, throwIfAborted } from "./abort-utils";
import { isTauriRuntime } from "./runtime";

const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const RASTER_TEXT_THRESHOLD = 48;
const WIDTH_QUANTUM = 32;
const MAX_OUTPUT_SCALE = 2.5;

const QUALITY_RANK: Record<PreviewQuality, number> = {
  performance: 0,
  auto: 1,
  crisp: 2,
};

let pdfDocCache: { path: string; doc: PDFDocumentProxy } | null = null;
const pdfBytesCache = new Map<string, Uint8Array>();
const inFlightDocs = new Map<string, Promise<PDFDocumentProxy>>();
let renderEpoch = 0;
let pageCacheBytes = 0;

// "thumb" is a dedicated lower-priority lane for sidebar thumbnails. Unlike
// "low", it is NOT purged by page navigation/zoom/resize, so a thumbnail render
// that is in-flight during a page turn still completes instead of silently
// cancelling and leaving the thumbnail permanently blank.
type RenderPriority = "high" | "low" | "thumb";
type RenderIntent = "display" | "print";

interface QueueItem {
  priority: RenderPriority;
  epoch: number;
  run: () => Promise<void>;
  cancel: () => void;
}

interface PageRenderSnapshot {
  pixelWidth: number;
  pixelHeight: number;
  cssWidth: number;
  cssHeight: number;
  bitmap: ImageBitmap;
  bytes: number;
}

interface PaintResult {
  cssWidth: number;
  cssHeight: number;
  cancel: () => void;
  cancelled?: boolean;
}

const pageCache = new Map<string, PageRenderSnapshot>();
const fitScaleCache = new Map<string, number>();
const textLayerCache = new Map<string, unknown>();

const renderQueue: QueueItem[] = [];
let queueRunning = false;

/** Active render tasks keyed by canvas element (for cancellation). */
const activeRenderTasks = new WeakMap<HTMLCanvasElement, RenderTask>();

export function quantizeWidth(width: number): number {
  return Math.max(WIDTH_QUANTUM, Math.round(width / WIDTH_QUANTUM) * WIDTH_QUANTUM);
}

export function buildScaleKey(
  zoom: "fit-width" | number,
  containerWidth: number,
  resolvedScale: number,
): string {
  const qWidth = quantizeWidth(containerWidth);
  if (zoom === "fit-width") return `fit:${qWidth}`;
  return `fixed:${resolvedScale.toFixed(4)}`;
}

function cacheKey(
  path: string,
  page: number,
  scaleKey: string,
  quality: PreviewQuality,
): string {
  return `${path}|${page}|${scaleKey}|${quality}|${getOutputScale(quality)}`;
}

export function qualityMultiplier(quality: PreviewQuality): number {
  switch (quality) {
    case "crisp":
      return 1.25;
    case "performance":
      return 1;
    default:
      return 1.15;
  }
}

export function effectiveDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const reported = window.devicePixelRatio || 1;
  return Math.min(2, Math.max(1, reported));
}

export function effectiveRenderQuality(
  userQuality: PreviewQuality,
  rasterHeavy: boolean,
): PreviewQuality {
  if (rasterHeavy) return "performance";
  return userQuality;
}

export function getOutputScale(quality: PreviewQuality = "crisp"): number {
  const raw = effectiveDevicePixelRatio() * qualityMultiplier(quality);
  return Math.min(MAX_OUTPUT_SCALE, raw);
}

export function isRasterHeavyPage(textLength: number): boolean {
  return textLength < RASTER_TEXT_THRESHOLD;
}

function findCachedPageKey(
  path: string,
  page: number,
  scaleKey: string,
  minQuality: PreviewQuality,
): string | undefined {
  const minRank = QUALITY_RANK[minQuality];
  let bestKey: string | undefined;
  let bestRank = -1;

  for (const key of pageCache.keys()) {
    const parts = key.split("|");
    if (parts.length < 5) continue;
    if (parts[0] !== path || parts[1] !== String(page) || parts[2] !== scaleKey) continue;
    const q = parts[3] as PreviewQuality;
    // Honor the outputScale part: a cached bitmap was rendered for a specific
    // device pixel ratio, so a DPR change must not reuse a stale-DPR bitmap.
    if (parts[4] !== String(getOutputScale(q))) continue;
    const rank = QUALITY_RANK[q] ?? 0;
    if (rank >= minRank && rank > bestRank) {
      bestRank = rank;
      bestKey = key;
    }
  }
  return bestKey;
}

function purgeLowPriorityQueue(): void {
  for (let i = renderQueue.length - 1; i >= 0; i--) {
    const item = renderQueue[i]!;
    if (item.priority === "low") {
      renderQueue.splice(i, 1);
      item.cancel();
    }
  }
}

function getCachedPage(key: string): PageRenderSnapshot | undefined {
  const snap = pageCache.get(key);
  if (snap) {
    pageCache.delete(key);
    pageCache.set(key, snap);
  }
  return snap;
}

function evictPageCache(): void {
  while (pageCacheBytes > MAX_CACHE_BYTES && pageCache.size > 0) {
    const key = pageCache.keys().next().value;
    if (!key) break;
    const snap = pageCache.get(key);
    if (snap) {
      pageCacheBytes -= snap.bytes;
      snap.bitmap.close();
    }
    pageCache.delete(key);
  }
}

function storePageCache(key: string, snap: PageRenderSnapshot): void {
  const prev = pageCache.get(key);
  if (prev) {
    pageCacheBytes -= prev.bytes;
    prev.bitmap.close();
  }
  pageCache.set(key, snap);
  pageCacheBytes += snap.bytes;
  evictPageCache();
}

function enqueueRender(priority: RenderPriority, run: () => Promise<void>): Promise<void> {
  const epoch = renderEpoch;
  return new Promise((resolve, reject) => {
    let settled = false;
    const item: QueueItem = {
      priority,
      epoch,
      run: async () => {
        if (settled) return;
        if (item.epoch !== renderEpoch) {
          settled = true;
          resolve();
          return;
        }
        try {
          await run();
          settled = true;
          resolve();
        } catch (e) {
          settled = true;
          reject(e);
        }
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        resolve();
      },
    };

    if (priority === "high") {
      purgeLowPriorityQueue();
      // Insert ahead of any lower-priority ("low"/"thumb") work.
      const idx = renderQueue.findIndex((q) => q.priority !== "high");
      if (idx >= 0) renderQueue.splice(idx, 0, item);
      else renderQueue.unshift(item);
    } else {
      renderQueue.push(item);
    }

    void drainQueue();
  });
}

async function drainQueue(): Promise<void> {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (renderQueue.length > 0) {
      const item = renderQueue.shift()!;
      await item.run();
    }
  } finally {
    queueRunning = false;
    if (renderQueue.length > 0) void drainQueue();
  }
}

export function isPdfExtractCancelledError(err: unknown): boolean {
  return err instanceof Error && /cancelled/i.test(err.message);
}

export type PdfExtractScope = "load" | "agent";

/** Bump the Rust PDF extract generation for one scope (load vs agent tools). */
export async function cancelPdfExtract(scope: PdfExtractScope = "load"): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("cancel_pdf_extract_cmd", { scope });
}

async function invokePdfExtract<T>(
  run: () => Promise<T>,
  signal?: AbortSignal,
  scope: PdfExtractScope = "agent",
): Promise<T> {
  if (!signal) return run();
  throwIfAborted(signal);
  const onAbort = () => {
    void cancelPdfExtract(scope);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await raceWithAbort(run(), signal);
  } catch (err) {
    if (signal.aborted || isPdfExtractCancelledError(err)) {
      throw new DOMException("Operation aborted", "AbortError");
    }
    throw err;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

export async function extractPdfFromRust(
  path: string,
  signal?: AbortSignal,
): Promise<PdfExtractResult> {
  return invokePdfExtract(
    () =>
      invoke<PdfExtractResult>("extract_pdf_text_cmd", {
        path,
        page: null,
        scope: "load",
      }),
    signal,
    "load",
  );
}

export async function extractPageTextFromRust(
  path: string,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<string> {
  const result = await invokePdfExtract(
    () =>
      invoke<PdfExtractResult>("extract_pdf_text_cmd", {
        path,
        page: pageNumber,
        scope: "agent",
      }),
    signal,
    "agent",
  );
  return result.pages[0]?.text?.trim() ?? "";
}

// `read_file_bytes` now returns raw bytes via tauri::ipc::Response, which the
// webview receives as an ArrayBuffer (or Uint8Array). Older/other callers may
// still hand back a number[] — accept all forms so every path keeps working.
function coerceInvokeBytes(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(raw)) return new Uint8Array(raw);
  throw new Error("read_file_bytes returned unexpected payload");
}

function pdfDocumentInit(data: Uint8Array) {
  return {
    data,
    useSystemFonts: true,
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    cMapUrl: pdfCMapUrl(),
    cMapPacked: true,
    standardFontDataUrl: pdfStandardFontUrl(),
  };
}

async function loadPdfBytesViaAsset(path: string): Promise<Uint8Array> {
  const url = convertFileSrc(path);
  const buf = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to load PDF (${r.status})`);
    return r.arrayBuffer();
  });
  const data = new Uint8Array(buf);
  if (data.byteLength === 0) throw new Error("Empty PDF file");
  return data;
}

async function loadPdfBytesViaIpc(path: string): Promise<Uint8Array> {
  const raw = await invoke<unknown>("read_file_bytes", { path });
  return coerceInvokeBytes(raw);
}

async function loadPdfBytes(path: string): Promise<Uint8Array> {
  const cached = pdfBytesCache.get(path);
  if (cached) return cached;

  // Prefer IPC in Tauri — asset:// fetch can lack ReadableStream / iterator support.
  let data: Uint8Array;
  try {
    data = await loadPdfBytesViaIpc(path);
  } catch {
    data = await loadPdfBytesViaAsset(path);
  }

  if (data.byteLength === 0) throw new Error("Empty PDF file");
  pdfBytesCache.set(path, data);
  return data;
}

export async function getPdfDocument(path: string): Promise<PDFDocumentProxy> {
  if (pdfDocCache?.path === path) return pdfDocCache.doc;

  const inFlight = inFlightDocs.get(path);
  if (inFlight) return inFlight;

  const load = (async () => {
    const pdfjs = await getPdfJs();
    const data = await loadPdfBytes(path);
    const doc = await pdfjs.getDocument(pdfDocumentInit(data)).promise;

    if (pdfDocCache && pdfDocCache.path !== path) {
      void pdfDocCache.doc.loadingTask.destroy();
    }
    pdfDocCache = { path, doc };
    return doc;
  })();

  inFlightDocs.set(path, load);
  try {
    return await load;
  } finally {
    inFlightDocs.delete(path);
  }
}

export async function getPdfPageCount(path: string, signal?: AbortSignal): Promise<number> {
  if (pdfDocCache?.path === path) return pdfDocCache.doc.numPages;
  return invokePdfExtract(
    () => invoke<number>("pdf_page_count_cmd", { path, scope: "load" }),
    signal,
    "load",
  );
}

/** Extract plain text for one page — Rust pdf-extract (reliable in Tauri). */
export async function extractPageText(
  path: string,
  pageNumber: number,
  signal?: AbortSignal,
): Promise<string> {
  return extractPageTextFromRust(path, pageNumber, signal);
}

/** Background-fill sparse page texts after open. */
export async function extractAllPageTexts(
  path: string,
  onPage?: (page: number, text: string) => void,
): Promise<{ page: number; text: string }[]> {
  const doc = await getPdfDocument(path);
  const out: { page: number; text: string }[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const text = await extractPageText(path, p);
    out.push({ page: p, text });
    onPage?.(p, text);
  }
  return out;
}

async function paintPage(
  page: PDFPageProxy,
  scale: number,
  quality: PreviewQuality,
  canvas: HTMLCanvasElement,
  intent: RenderIntent = "display",
): Promise<PaintResult> {
  const outputScale = getOutputScale(quality);
  const renderScale = scale * outputScale;
  const viewport = page.getViewport({ scale: renderScale });

  const cssWidth = Math.round(viewport.width / outputScale);
  const cssHeight = Math.round(viewport.height / outputScale);
  const pixelWidth = Math.max(1, Math.round(viewport.width));
  const pixelHeight = Math.max(1, Math.round(viewport.height));

  canvas.width = pixelWidth;
  canvas.height = pixelHeight;
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;
  canvas.style.maxWidth = "none";
  canvas.style.maxHeight = "none";

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas not supported");

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, pixelWidth, pixelHeight);

  const prev = activeRenderTasks.get(canvas);
  prev?.cancel();

  const task = page.render({
    canvasContext: ctx,
    viewport,
    canvas,
    intent,
  });

  activeRenderTasks.set(canvas, task);

  try {
    await task.promise;
  } catch (e) {
    if ((e as { name?: string })?.name === "RenderingCancelledException") {
      return { cssWidth, cssHeight, cancel: () => task.cancel(), cancelled: true };
    }
    throw e;
  } finally {
    activeRenderTasks.delete(canvas);
  }

  return { cssWidth, cssHeight, cancel: () => task.cancel() };
}

function applySnapshot(canvas: HTMLCanvasElement, snap: PageRenderSnapshot): void {
  canvas.width = snap.pixelWidth;
  canvas.height = snap.pixelHeight;
  canvas.style.width = `${snap.cssWidth}px`;
  canvas.style.height = `${snap.cssHeight}px`;
  canvas.style.maxWidth = "none";
  canvas.style.maxHeight = "none";

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas not supported");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, snap.pixelWidth, snap.pixelHeight);
  ctx.drawImage(snap.bitmap, 0, 0);
}

export function tryApplyCachedPage(
  path: string,
  pageNumber: number,
  scaleKey: string,
  quality: PreviewQuality,
  canvas: HTMLCanvasElement,
): boolean {
  const key = findCachedPageKey(path, pageNumber, scaleKey, quality);
  if (!key) return false;
  const cached = getCachedPage(key);
  if (!cached) return false;
  applySnapshot(canvas, cached);
  return true;
}

export function hasPageCache(
  path: string,
  pageNumber: number,
  scaleKey: string,
  quality: PreviewQuality,
): boolean {
  return findCachedPageKey(path, pageNumber, scaleKey, quality) !== undefined;
}

async function renderAndCache(
  path: string,
  pageNumber: number,
  scale: number,
  scaleKey: string,
  quality: PreviewQuality,
  canvas: HTMLCanvasElement,
  intent: RenderIntent,
  isStale: () => boolean,
): Promise<RenderResult> {
  const existingKey = findCachedPageKey(path, pageNumber, scaleKey, quality);
  if (existingKey) {
    const cached = getCachedPage(existingKey);
    if (cached && !isStale()) {
      applySnapshot(canvas, cached);
      const doc = await getPdfDocument(path);
      return { totalPages: doc.numPages, cacheHit: true };
    }
  }

  if (isStale()) {
    const doc = await getPdfDocument(path);
    return { totalPages: doc.numPages, cacheHit: false };
  }

  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const paint = await paintPage(page, scale, quality, canvas, intent);

  if (paint.cancelled || isStale()) {
    paint.cancel();
    return { totalPages: doc.numPages, cacheHit: false, cancelled: true };
  }

  const bitmap = await createImageBitmap(canvas);
  const key = cacheKey(path, pageNumber, scaleKey, quality);
  const bytes = canvas.width * canvas.height * 4;
  storePageCache(key, {
    bitmap,
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    cssWidth: paint.cssWidth,
    cssHeight: paint.cssHeight,
    bytes,
  });

  return { totalPages: doc.numPages, cacheHit: false };
}

export interface RenderResult {
  totalPages: number;
  cacheHit: boolean;
  cancelled?: boolean;
}

export async function renderPageToCanvas(
  path: string,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.25,
  priority: RenderPriority = "high",
  quality: PreviewQuality = "crisp",
  scaleKey?: string,
  isStale?: () => boolean,
): Promise<RenderResult> {
  const key = scaleKey ?? `fixed:${scale.toFixed(4)}`;
  const stale = isStale ?? (() => false);
  let result: RenderResult = { totalPages: 0, cacheHit: false, cancelled: true };

  await enqueueRender(priority, async () => {
    if (stale()) return;
    result = await renderAndCache(
      path,
      pageNumber,
      scale,
      key,
      quality,
      canvas,
      "display",
      stale,
    );
  });

  return result;
}

export function prefetchPage(
  path: string,
  pageNumber: number,
  scale: number,
  quality: PreviewQuality = "crisp",
  scaleKey?: string,
): void {
  const key = scaleKey ?? `fixed:${scale.toFixed(4)}`;
  if (hasPageCache(path, pageNumber, key, quality)) return;

  void enqueueRender("low", async () => {
    const offscreen = document.createElement("canvas");
    await renderAndCache(
      path,
      pageNumber,
      scale,
      key,
      quality,
      offscreen,
      "display",
      () => false,
    );
  });
}

export async function renderTextLayer(
  path: string,
  pageNumber: number,
  scale: number,
  container: HTMLElement,
): Promise<() => void> {
  const layerKey = `${path}|${pageNumber}|${scale.toFixed(4)}`;
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });

  let textContent = textLayerCache.get(layerKey);
  if (!textContent) {
    textContent = await page.getTextContent();
    textLayerCache.set(layerKey, textContent);
  }

  container.innerHTML = "";
  container.style.width = `${Math.round(viewport.width)}px`;
  container.style.height = `${Math.round(viewport.height)}px`;

  const { TextLayer } = await getPdfJs();
  const layer = new TextLayer({
    textContentSource: textContent as Awaited<ReturnType<PDFPageProxy["getTextContent"]>>,
    container,
    viewport,
  });

  await layer.render();

  return () => {
    layer.cancel();
    container.innerHTML = "";
  };
}

/**
 * Clear ONLY the rendered page bitmap cache, keeping the loaded pdf.js document
 * and the raw PDF byte cache intact. Used when the render quality changes: the
 * cached bitmaps are quality-specific and must be re-rendered, but there is no
 * need to re-read the file or re-parse the document.
 */
export function clearPageBitmapCache(): void {
  for (const snap of pageCache.values()) snap.bitmap.close();
  pageCache.clear();
  pageCacheBytes = 0;
}

export function clearPdfCache(): void {
  renderEpoch += 1;
  for (const item of renderQueue) item.cancel();
  renderQueue.length = 0;
  if (pdfDocCache) {
    void pdfDocCache.doc.loadingTask.destroy();
    pdfDocCache = null;
  }
  pdfBytesCache.clear();
  fitScaleCache.clear();
  textLayerCache.clear();
  for (const snap of pageCache.values()) snap.bitmap.close();
  pageCache.clear();
  pageCacheBytes = 0;
}

export async function resolveFitWidthScale(
  path: string,
  pageNumber: number,
  containerWidth: number,
  padding = 4,
): Promise<number> {
  const qWidth = quantizeWidth(containerWidth);
  const cacheId = `${path}|${pageNumber}|${qWidth}`;
  const cached = fitScaleCache.get(cacheId);
  if (cached !== undefined) return cached;
  const scale = await computeFitWidthScale(path, pageNumber, qWidth, padding);
  fitScaleCache.set(cacheId, scale);
  return scale;
}

export async function computeFitWidthScale(
  path: string,
  pageNumber: number,
  containerWidth: number,
  padding = 4,
): Promise<number> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const available = Math.max(120, containerWidth - padding * 2);
  return available / base.width;
}

/** OCR target ~300 DPI (72 PDF points × ~4.17). */
const OCR_RENDER_SCALE = 300 / 72;

export async function renderThumbnail(
  path: string,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  maxWidth = 96,
): Promise<void> {
  // Use the dedicated "thumb" lane so a page turn/zoom/resize (which purges the
  // "low" lane) does not cancel this render and leave the thumbnail blank.
  await enqueueRender("thumb", async () => {
    const doc = await getPdfDocument(path);
    const page = await doc.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = maxWidth / base.width;
    await paintPage(page, scale, "performance", canvas, "display");
  });
}

export async function renderPageToJpegBytes(
  path: string,
  pageNumber: number,
  maxEdge = 1568,
  quality = 0.85,
): Promise<Uint8Array> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const edge = Math.max(base.width, base.height);
  const scale = edge > maxEdge ? maxEdge / edge : OCR_RENDER_SCALE;

  const offscreen = document.createElement("canvas");
  await paintPage(page, scale, "performance", offscreen, "print");

  const blob = await new Promise<Blob>((resolve, reject) => {
    offscreen.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      quality,
    );
  });

  return new Uint8Array(await blob.arrayBuffer());
}

export async function renderPageToPngBytes(
  path: string,
  pageNumber: number,
  maxEdge = 1568,
): Promise<Uint8Array> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const edge = Math.max(base.width, base.height);
  const scale = edge > maxEdge ? maxEdge / edge : OCR_RENDER_SCALE;

  const offscreen = document.createElement("canvas");
  await paintPage(page, scale, "performance", offscreen, "print");

  const blob = await new Promise<Blob>((resolve, reject) => {
    offscreen.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });

  return new Uint8Array(await blob.arrayBuffer());
}

export async function ocrPdfPage(path: string, pageNumber: number): Promise<string> {
  const bytes = await renderPageToPngBytes(path, pageNumber);
  return invoke<string>("ocr_bytes", { data: bytes });
}

export async function getPageViewport(path: string, pageNumber: number, scale: number) {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  return page.getViewport({ scale });
}

/** Capture the current document page as a multimodal `FileUIPart` for AI SDK messages. */
export async function capturePageFilePart(
  path: string,
  page: number,
  kind: "pdf" | "image",
): Promise<{ type: "file"; mediaType: string; url: string } | null> {
  if (kind === "image") {
    return { type: "file", mediaType: "image/png", url: convertFileSrc(path) };
  }
  const canvas = document.createElement("canvas");
  try {
    const result = await renderPageToCanvas(path, page, canvas, 1, "high", "performance");
    if (result.cancelled || canvas.width === 0) return null;
    return {
      type: "file",
      mediaType: "image/png",
      url: canvas.toDataURL("image/png", 0.85),
    };
  } catch {
    return null;
  }
}
