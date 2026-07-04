import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { PreviewQuality } from "./types";
import type { PdfExtractResult } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

const MAX_PAGE_CACHE = 24;
const RASTER_TEXT_THRESHOLD = 48;

let pdfDocCache: { path: string; doc: pdfjs.PDFDocumentProxy } | null = null;
const pdfBytesCache = new Map<string, Uint8Array>();
/** De-dupes concurrent getDocument loads for the same path. */
const inFlightDocs = new Map<string, Promise<pdfjs.PDFDocumentProxy>>();
let renderEpoch = 0;

type RenderPriority = "high" | "low";

interface QueueItem {
  priority: RenderPriority;
  epoch: number;
  run: () => Promise<void>;
  /** Settle the awaited promise without running (used when the item is dropped). */
  cancel: () => void;
}

interface PageRenderSnapshot {
  pixelWidth: number;
  pixelHeight: number;
  cssWidth: number;
  cssHeight: number;
  bitmap: ImageBitmap;
}

const pageCache = new Map<string, PageRenderSnapshot>();
const fitScaleCache = new Map<string, number>();

const renderQueue: QueueItem[] = [];
let queueRunning = false;

export function buildScaleKey(
  zoom: "fit-width" | number,
  containerWidth: number,
  resolvedScale: number,
): string {
  if (zoom === "fit-width") return `fit:${containerWidth}`;
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
      return 2;
    case "performance":
      return 1;
    default:
      return 1.5;
  }
}

/**
 * Use the browser-reported device pixel ratio directly, clamped to a sane range.
 * Inferring DPR from screen.width / innerWidth over-scaled non-maximized windows on
 * 1x displays (rendering ~4x the pixels), so that heuristic has been removed.
 */
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
  return effectiveDevicePixelRatio() * qualityMultiplier(quality);
}

export function isRasterHeavyPage(textLength: number): boolean {
  return textLength < RASTER_TEXT_THRESHOLD;
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

/** LRU read: on a hit, re-insert the key so it becomes most-recently-used. */
function getCachedPage(key: string): PageRenderSnapshot | undefined {
  const snap = pageCache.get(key);
  if (snap) {
    pageCache.delete(key);
    pageCache.set(key, snap);
  }
  return snap;
}

function evictPageCache(): void {
  while (pageCache.size > MAX_PAGE_CACHE) {
    const key = pageCache.keys().next().value;
    if (!key) break;
    pageCache.get(key)?.bitmap.close();
    pageCache.delete(key);
  }
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
        // Stale after a cache clear / epoch bump: settle (resolve) instead of
        // silently dropping the promise, so awaiters never hang.
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
      const idx = renderQueue.findIndex((q) => q.priority === "low");
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
      // item.run() settles stale items as cancelled internally.
      await item.run();
    }
  } finally {
    queueRunning = false;
    if (renderQueue.length > 0) void drainQueue();
  }
}

export async function extractPdfFromRust(path: string): Promise<PdfExtractResult> {
  return invoke<PdfExtractResult>("extract_pdf_text_cmd", { path, page: null });
}

async function loadPdfBytes(path: string): Promise<Uint8Array> {
  const cached = pdfBytesCache.get(path);
  if (cached) return cached;

  try {
    const raw = await invoke<number[] | Uint8Array>("read_file_bytes", { path });
    const data =
      raw instanceof Uint8Array ? raw : new Uint8Array(Array.isArray(raw) ? raw : []);
    if (data.byteLength === 0) throw new Error("Empty PDF file");
    pdfBytesCache.set(path, data);
    return data;
  } catch {
    const url = convertFileSrc(path);
    const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.responseType = "arraybuffer";
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300 && xhr.response) {
          resolve(xhr.response as ArrayBuffer);
        } else {
          reject(new Error(`Failed to load PDF (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error("Failed to load PDF"));
      xhr.send();
    });
    const data = new Uint8Array(buf);
    pdfBytesCache.set(path, data);
    return data;
  }
}

export async function getPdfDocument(path: string): Promise<pdfjs.PDFDocumentProxy> {
  if (pdfDocCache?.path === path) {
    return pdfDocCache.doc;
  }
  const inFlight = inFlightDocs.get(path);
  if (inFlight) return inFlight;

  const load = (async () => {
    const data = await loadPdfBytes(path);
    const doc = await pdfjs.getDocument({
      data,
      useSystemFonts: true,
      disableStream: true,
      disableAutoFetch: true,
      disableRange: true,
    }).promise;
    // Destroy the previously cached document before replacing it, otherwise the
    // parsed doc leaks inside the pdf.js worker.
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

export async function getPageViewport(path: string, pageNumber: number, scale: number) {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  return page.getViewport({ scale });
}

/** Direct viewport render — one pass, integer pixel dimensions. */
async function paintPage(
  page: pdfjs.PDFPageProxy,
  scale: number,
  quality: PreviewQuality,
  canvas: HTMLCanvasElement,
): Promise<{ cssWidth: number; cssHeight: number }> {
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

  await page.render({
    canvasContext: ctx,
    viewport,
    canvas,
    intent: "print",
  }).promise;

  return { cssWidth, cssHeight };
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
  const key = cacheKey(path, pageNumber, scaleKey, quality);
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
  return pageCache.has(cacheKey(path, pageNumber, scaleKey, quality));
}

async function renderAndCache(
  path: string,
  pageNumber: number,
  scale: number,
  scaleKey: string,
  quality: PreviewQuality,
  canvas: HTMLCanvasElement,
): Promise<{ totalPages: number; cacheHit: boolean }> {
  const key = cacheKey(path, pageNumber, scaleKey, quality);
  const cached = getCachedPage(key);
  if (cached) {
    applySnapshot(canvas, cached);
    const doc = await getPdfDocument(path);
    return { totalPages: doc.numPages, cacheHit: true };
  }

  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const dims = await paintPage(page, scale, quality, canvas);

  const bitmap = await createImageBitmap(canvas);
  pageCache.set(key, {
    bitmap,
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    cssWidth: dims.cssWidth,
    cssHeight: dims.cssHeight,
  });
  evictPageCache();

  return { totalPages: doc.numPages, cacheHit: false };
}

export interface RenderResult {
  totalPages: number;
  cacheHit: boolean;
  /** True when the render was cancelled (cache cleared / epoch bumped) before running. */
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
): Promise<RenderResult> {
  const key = scaleKey ?? `fixed:${scale.toFixed(4)}`;
  // Default to a cancelled marker; the callback below overwrites it only if it runs.
  let result: RenderResult = { totalPages: 0, cacheHit: false, cancelled: true };

  await enqueueRender(priority, async () => {
    result = await renderAndCache(path, pageNumber, scale, key, quality, canvas);
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
  if (pageCache.has(cacheKey(path, pageNumber, key, quality))) return;

  void enqueueRender("low", async () => {
    const offscreen = document.createElement("canvas");
    const doc = await getPdfDocument(path);
    const page = await doc.getPage(pageNumber);
    const dims = await paintPage(page, scale, quality, offscreen);
    const bitmap = await createImageBitmap(offscreen);
    pageCache.set(cacheKey(path, pageNumber, key, quality), {
      bitmap,
      pixelWidth: offscreen.width,
      pixelHeight: offscreen.height,
      cssWidth: dims.cssWidth,
      cssHeight: dims.cssHeight,
    });
    evictPageCache();
  });
}

export async function renderTextLayer(
  path: string,
  pageNumber: number,
  scale: number,
  container: HTMLElement,
): Promise<() => void> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const textContent = await page.getTextContent();

  container.innerHTML = "";
  container.style.width = `${Math.round(viewport.width)}px`;
  container.style.height = `${Math.round(viewport.height)}px`;

  const layer = new TextLayer({
    textContentSource: textContent,
    container,
    viewport,
  });

  await layer.render();

  return () => {
    layer.cancel();
    container.innerHTML = "";
  };
}

export function clearPdfCache(): void {
  renderEpoch += 1;
  // Settle any queued renders so their awaiters resolve instead of hanging forever.
  for (const item of renderQueue) item.cancel();
  renderQueue.length = 0;
  if (pdfDocCache) {
    void pdfDocCache.doc.loadingTask.destroy();
    pdfDocCache = null;
  }
  pdfBytesCache.clear();
  fitScaleCache.clear();
  for (const snap of pageCache.values()) snap.bitmap.close();
  pageCache.clear();
}

export async function resolveFitWidthScale(
  path: string,
  pageNumber: number,
  containerWidth: number,
  padding = 4,
): Promise<number> {
  const cacheId = `${path}|${pageNumber}|${containerWidth}`;
  const cached = fitScaleCache.get(cacheId);
  if (cached !== undefined) return cached;
  const scale = await computeFitWidthScale(path, pageNumber, containerWidth, padding);
  fitScaleCache.set(cacheId, scale);
  return scale;
}

export async function getPdfPageCount(path: string): Promise<number> {
  const doc = await getPdfDocument(path);
  return doc.numPages;
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

export async function renderThumbnail(
  path: string,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  maxWidth = 96,
): Promise<void> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = maxWidth / base.width;
  await paintPage(page, scale, "performance", canvas);
}

export async function renderPageToPngBytes(
  path: string,
  pageNumber: number,
  scale = 2,
): Promise<Uint8Array> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const offscreen = document.createElement("canvas");
  await paintPage(page, scale, "crisp", offscreen);

  const blob = await new Promise<Blob>((resolve, reject) => {
    offscreen.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });

  return new Uint8Array(await blob.arrayBuffer());
}

export async function ocrPdfPage(path: string, pageNumber: number): Promise<string> {
  const bytes = await renderPageToPngBytes(path, pageNumber);
  return invoke<string>("ocr_bytes", { data: Array.from(bytes) });
}
