import type { PDFPageProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { invokeCmd } from "./invoke-cmd";
import {
  getPdfJs,
  pdfCMapUrl,
  pdfStandardFontUrl,
  type PDFDocumentProxy,
} from "./pdf-loader";
import type { PreviewQuality } from "./types";
import type { DocumentModel, PdfRect, RegionText, TextItemRect } from "./types";
import { raceWithAbort, throwIfAborted } from "./abort-utils";
import { ensureProviderCompatibleImage } from "./image-transcode";
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
const pdfBytesCacheOrder: string[] = [];
const MAX_PDF_BYTES_CACHE = 3;
const inFlightDocs = new Map<string, Promise<PDFDocumentProxy>>();
let renderEpoch = 0;
let pageCacheBytes = 0;
/** Bumped on doc switch / clearPdfCache — stale loads must not destroy the active document. */
let pdfDocEpoch = 0;
/** Path the UI is currently viewing; late loads for other paths are discarded. */
let pdfActivePath: string | null = null;

export function setActivePdfPath(path: string | null): void {
  pdfActivePath = path;
}

function touchPdfBytesCache(path: string): void {
  const idx = pdfBytesCacheOrder.indexOf(path);
  if (idx >= 0) pdfBytesCacheOrder.splice(idx, 1);
  pdfBytesCacheOrder.push(path);
  while (pdfBytesCacheOrder.length > MAX_PDF_BYTES_CACHE) {
    const evict = pdfBytesCacheOrder.shift();
    if (evict) pdfBytesCache.delete(evict);
  }
}

function shouldCommitPdfLoad(path: string, epochAtStart: number): boolean {
  return epochAtStart === pdfDocEpoch && (pdfActivePath === null || pdfActivePath === path);
}

export class StalePdfLoadError extends Error {
  constructor(path: string) {
    super(`PDF load superseded: ${path}`);
    this.name = "StalePdfLoadError";
  }
}

/** Bumped on doc switch — stale IPC byte reads are discarded on the JS side. */
let fileReadGen = 0;

function bumpFileReadGeneration(): void {
  fileReadGen += 1;
  if (isTauriRuntime()) {
    void invoke("cancel_file_read_cmd").catch(() => {});
  }
}

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
/**
 * TextContent per page (scale-independent), LRU-bounded: dense pages run
 * 100KB+ each, so an unbounded cache browsing a large document accumulates
 * tens of MB for pages long scrolled past.
 */
const textLayerCache = new Map<string, unknown>();
const MAX_TEXT_LAYER_CACHE = 40;

function setTextLayerCache(key: string, value: unknown): void {
  textLayerCache.delete(key);
  textLayerCache.set(key, value);
  while (textLayerCache.size > MAX_TEXT_LAYER_CACHE) {
    const oldest = textLayerCache.keys().next().value;
    if (oldest === undefined) break;
    textLayerCache.delete(oldest);
  }
}

function getTextLayerCache(key: string): unknown {
  const value = textLayerCache.get(key);
  if (value !== undefined) {
    // Refresh insertion order so the Map doubles as a real LRU.
    textLayerCache.delete(key);
    textLayerCache.set(key, value);
  }
  return value;
}

const renderQueue: QueueItem[] = [];
let queueRunning = false;

/** In-flight paint operations — cancelled on clearPdfCache. */
const activePaints = new Set<{ cancel: () => void }>();

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


/**
 * Parse a document once. Everything downstream reads the returned model — text,
 * outline, links and figure boxes — so a PDF is interpreted in exactly one
 * place.
 *
 * There is no cancellation: the extractor offers no cancel token, so an
 * in-flight parse always runs to completion. A superseded load is discarded by
 * the caller instead, which is what `AbortSignal` means here.
 */
export async function openDocument(
  path: string,
  signal?: AbortSignal,
): Promise<DocumentModel> {
  const run = invokeCmd<DocumentModel>("open_document_cmd", { path });
  if (!signal) return run;
  throwIfAborted(signal);
  return raceWithAbort(run, signal);
}

/**
 * Read the text under a selection rectangle.
 *
 * `rect` is in PDF points with a **top-left** origin — which is exactly what a
 * pdf.js viewport rectangle already is, so a selection needs no conversion.
 */
export async function extractRegion(
  path: string,
  page: number,
  rect: PdfRect,
): Promise<RegionText> {
  return invokeCmd<RegionText>("extract_region_cmd", { path, page, rect });
}

/**
 * Every text run on one page, with its position in PDF points (bottom-left
 * origin). Fetched per page: a long document holds tens of thousands of runs.
 */
export async function pageTextItems(
  path: string,
  page: number,
): Promise<TextItemRect[]> {
  return invokeCmd<TextItemRect[]>("page_text_items_cmd", { path, page });
}

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

async function loadPdfBytesViaIpc(path: string, readGen: number): Promise<Uint8Array> {
  const raw = await invokeCmd<unknown>("read_file_bytes", { path });
  if (readGen !== fileReadGen) throw new StalePdfLoadError(path);
  return coerceInvokeBytes(raw);
}

/** Read an allowlisted file via IPC with stale-read discard (vision / images). */
export async function readAuthorizedFileBytes(
  path: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const readGen = fileReadGen;
  try {
    const data = await loadPdfBytesViaIpc(path, readGen);
    throwIfAborted(signal);
    return data;
  } catch (e) {
    if (e instanceof StalePdfLoadError) throw e;
    throw e;
  }
}

async function loadPdfBytes(path: string, readGen: number): Promise<Uint8Array> {
  const cached = pdfBytesCache.get(path);
  // A detached buffer (byteLength 0 after transfer to the pdf.js worker) is a
  // cache miss, not a hit — returning it would fail every retry for this path.
  if (cached && cached.buffer.byteLength > 0) {
    touchPdfBytesCache(path); // mark as most-recently-used so the LRU is a real LRU
    return cached;
  }

  let data: Uint8Array;
  try {
    data = await loadPdfBytesViaIpc(path, readGen);
  } catch (e) {
    if (e instanceof StalePdfLoadError) throw e;
    // The 256 MiB cap is a deliberate guard — falling back to the asset
    // protocol here would fetch the whole oversized file into webview memory
    // anyway, bypassing the cap.
    if (e instanceof Error || typeof e === "string") {
      const msg = e instanceof Error ? e.message : e;
      if (msg.includes("File too large")) throw e;
    }
    data = await loadPdfBytesViaAsset(path);
    if (readGen !== fileReadGen) throw new StalePdfLoadError(path);
  }

  if (data.byteLength === 0) throw new Error("Empty PDF file");
  pdfBytesCache.set(path, data);
  touchPdfBytesCache(path);
  return data;
}

async function loadPdfDocumentOnce(path: string, epochAtStart: number): Promise<PDFDocumentProxy> {
  const readGen = fileReadGen;
  const pdfjs = await getPdfJs();
  const data = await loadPdfBytes(path, readGen);
  // getDocument TRANSFERS the buffer to the pdf.js worker, detaching it. Hand
  // pdf.js a copy so the pdfBytesCache entry stays usable for retries
  // (stale-load loop, parse-failure re-renders) instead of throwing
  // DataCloneError on every subsequent attempt.
  const doc = await pdfjs.getDocument(pdfDocumentInit(data.slice())).promise;

  if (!shouldCommitPdfLoad(path, epochAtStart)) {
    void doc.loadingTask.destroy();
    throw new StalePdfLoadError(path);
  }
  if (pdfDocCache && pdfDocCache.path !== path) {
    void pdfDocCache.doc.loadingTask.destroy();
  }
  pdfDocCache = { path, doc };
  return doc;
}

export async function getPdfDocument(path: string): Promise<PDFDocumentProxy> {
  if (pdfDocCache?.path === path) return pdfDocCache.doc;

  const inFlight = inFlightDocs.get(path);
  if (inFlight) return inFlight;

  const load = (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const epochAtStart = pdfDocEpoch;
      try {
        return await loadPdfDocumentOnce(path, epochAtStart);
      } catch (e) {
        if (e instanceof StalePdfLoadError) {
          if (pdfDocCache?.path === path) return pdfDocCache.doc;
          continue;
        }
        throw e;
      }
    }
    return loadPdfDocumentOnce(path, pdfDocEpoch);
  })();

  inFlightDocs.set(path, load);
  try {
    return await load;
  } finally {
    inFlightDocs.delete(path);
  }
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
  const paintHandle = { cancel: () => task.cancel() };
  activePaints.add(paintHandle);

  try {
    await task.promise;
  } catch (e) {
    if ((e as { name?: string })?.name === "RenderingCancelledException") {
      return { cssWidth, cssHeight, cancel: () => task.cancel(), cancelled: true };
    }
    throw e;
  } finally {
    activePaints.delete(paintHandle);
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
  if (isStale()) {
    return { totalPages: doc.numPages, cacheHit: false, cancelled: true };
  }
  const page = await doc.getPage(pageNumber);
  if (isStale()) {
    return { totalPages: doc.numPages, cacheHit: false, cancelled: true };
  }
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
  if (pdfActivePath !== null && pdfActivePath !== path) return;

  void enqueueRender("low", async () => {
    if (pdfActivePath !== null && pdfActivePath !== path) return;
    const offscreen = document.createElement("canvas");
    await renderAndCache(
      path,
      pageNumber,
      scale,
      key,
      quality,
      offscreen,
      "display",
      () => pdfActivePath !== null && pdfActivePath !== path,
    );
  });
}

export interface PdfBookmark {
  title: string;
  /** 1-based page the bookmark points to, or null if it couldn't be resolved. */
  page: number | null;
  /** Nesting depth (0 = top level). */
  level: number;
}

async function outlineDestToPage(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    let explicit: unknown = dest;
    if (typeof dest === "string") explicit = await doc.getDestination(dest);
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    if (!ref || typeof ref !== "object") return null;
    const index = await doc.getPageIndex(ref as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
    return index + 1;
  } catch {
    return null;
  }
}

/**
 * Flatten a PDF's native bookmark/outline tree (pdf.js getOutline) into a
 * bounded list of { title, page, level }, so the agent can navigate by section
 * instead of scanning per-page previews. Returns [] when the PDF has no outline
 * or on any failure (e.g. an image document).
 */
export async function getPdfOutline(path: string, maxEntries = 100): Promise<PdfBookmark[]> {
  try {
    const doc = await getPdfDocument(path);
    const tree = await doc.getOutline();
    if (!tree || tree.length === 0) return [];
    const out: PdfBookmark[] = [];
    const walk = async (
      nodes: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>,
      level: number,
    ): Promise<void> => {
      if (!nodes) return;
      for (const node of nodes) {
        if (out.length >= maxEntries) return;
        const title = (node.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
        if (title) {
          const page = node.dest != null ? await outlineDestToPage(doc, node.dest) : null;
          out.push({ title, page, level });
        }
        if (node.items?.length) await walk(node.items, level + 1);
      }
    };
    await walk(tree, 0);
    return out;
  } catch {
    return [];
  }
}

/**
 * Monotonic token stamped on the shared text-layer container so an older
 * in-flight render (rapid page flips) can never clear or overwrite the DOM
 * that a newer render has populated.
 */
let textLayerRunSeq = 0;

export async function renderTextLayer(
  path: string,
  pageNumber: number,
  scale: number,
  container: HTMLElement,
  isStale?: () => boolean,
): Promise<() => void> {
  const runId = String(++textLayerRunSeq);
  container.dataset.pwTextLayerRun = runId;
  const ownsContainer = () => container.dataset.pwTextLayerRun === runId;

  // TextContent is scale-independent — keying by scale would re-fetch the
  // same page's text at every zoom level.
  const layerKey = `${path}|${pageNumber}`;
  const doc = await getPdfDocument(path);
  if (isStale?.() || !ownsContainer()) return () => {};
  const page = await doc.getPage(pageNumber);
  if (isStale?.() || !ownsContainer()) return () => {};
  const viewport = page.getViewport({ scale });

  let textContent = getTextLayerCache(layerKey);
  if (!textContent) {
    textContent = await page.getTextContent();
    if (isStale?.() || !ownsContainer()) return () => {};
    setTextLayerCache(layerKey, textContent);
  }

  const { TextLayer } = await getPdfJs();
  if (isStale?.() || !ownsContainer()) return () => {};

  // Render into an off-DOM staging element and commit atomically: two
  // overlapping runs (rapid page flips) must never interleave appends into the
  // shared container, and a stale run must never wipe a newer run's output.
  const staging = document.createElement("div");
  const layer = new TextLayer({
    textContentSource: textContent as Awaited<ReturnType<PDFPageProxy["getTextContent"]>>,
    container: staging,
    viewport,
  });

  await layer.render();
  if (isStale?.() || !ownsContainer()) {
    layer.cancel();
    return () => {};
  }

  // Commit: adopt the spans plus the inline sizing/vars pdf.js set on staging.
  // Explicit px size is the fallback for engines without CSS round() —
  // setLayerDimensions' round()-based values are used where supported (an
  // invalid assignment is simply ignored by CSSOM).
  container.style.width = `${Math.round(viewport.width)}px`;
  container.style.height = `${Math.round(viewport.height)}px`;
  if (staging.style.width) container.style.width = staging.style.width;
  if (staging.style.height) container.style.height = staging.style.height;
  // pdf.js v6 positions text spans through CSS custom properties; the layer
  // contract requires --total-scale-factor (CSS px per PDF unit) plus the
  // span rules in App.css (.pdf-text-layer) consuming --font-height /
  // --scale-x / --rotate. Without this, spans render at the inherited font
  // size and selection geometry is wrong at every zoom.
  container.style.setProperty("--total-scale-factor", String(viewport.scale));
  const minFontSize = staging.style.getPropertyValue("--min-font-size");
  if (minFontSize) container.style.setProperty("--min-font-size", minFontSize);
  // Carry the page's intrinsic rotation (pdf.js sets data-main-rotation from
  // viewport.rotation): the canvas is painted rotated, and the .pdf-text-layer
  // CSS rotates the span layer to match. Without this a /Rotate 90/180/270
  // page's selection highlights land in the wrong place.
  container.setAttribute(
    "data-main-rotation",
    staging.getAttribute("data-main-rotation") ?? "0",
  );
  container.replaceChildren(...staging.childNodes);

  return () => {
    layer.cancel();
    if (ownsContainer()) container.innerHTML = "";
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
  pdfDocEpoch += 1;
  bumpFileReadGeneration();
  for (const item of renderQueue) item.cancel();
  renderQueue.length = 0;
  for (const paint of activePaints) paint.cancel();
  activePaints.clear();
  if (pdfDocCache) {
    void pdfDocCache.doc.loadingTask.destroy();
    pdfDocCache = null;
  }
  pdfBytesCache.clear();
  pdfBytesCacheOrder.length = 0;
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

/**
 * Scale to hand to {@link paintPage} for an off-screen byte render (vision index)
 * so the encoded long edge lands at `min(edge * OCR_RENDER_SCALE, maxEdge)` pixels
 * regardless of display DPR. paintPage multiplies the scale by `getOutputScale`,
 * so we divide that back out here; otherwise a retina display (outputScale 2)
 * would encode ~2x the pixels for no quality gain — the vision provider downscales
 * to maxEdge server-side anyway.
 */
export function visionRenderScale(
  edge: number,
  maxEdge: number,
  outputScale: number,
): number {
  const targetScale = Math.min(OCR_RENDER_SCALE, maxEdge / edge);
  return outputScale > 0 ? targetScale / outputScale : targetScale;
}

export async function renderThumbnail(
  path: string,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  maxWidth = 96,
  isStale?: () => boolean,
): Promise<void> {
  // Use the dedicated "thumb" lane so a page turn/zoom/resize (which purges the
  // "low" lane) does not cancel this render and leave the thumbnail blank.
  await enqueueRender("thumb", async () => {
    if (isStale?.()) return;
    const doc = await getPdfDocument(path);
    if (isStale?.()) return;
    const page = await doc.getPage(pageNumber);
    if (isStale?.()) return;
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
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const doc = await getPdfDocument(path);
  throwIfAborted(signal);
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const edge = Math.max(base.width, base.height);
  const scale = visionRenderScale(edge, maxEdge, getOutputScale("performance"));

  const offscreen = document.createElement("canvas");
  const paint = await paintPage(page, scale, "performance", offscreen, "print");
  throwIfAborted(signal);
  if (paint.cancelled) {
    // A cancelled paint leaves the canvas partially painted — encoding it
    // would feed a half-rendered page to the vision model and persist its OCR
    // as the page's text.
    throw new DOMException("Page render cancelled", "AbortError");
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    offscreen.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg",
      quality,
    );
  });

  return new Uint8Array(await blob.arrayBuffer());
}


/**
 * What is needed to turn a point on screen into a point on the PDF page.
 *
 * `convertToPdfPoint` carries the page's intrinsic rotation, so callers must
 * not assume the rendered axes line up with the page's own — a `/Rotate 90`
 * page is painted turned, and its text layer with it.
 */
export interface PageGeometry {
  /** Page size in viewport units at scale 1, i.e. after rotation. */
  viewportWidth: number;
  viewportHeight: number;
  /** Viewport point → PDF user space (bottom-left origin, unrotated). */
  toPdfPoint: (x: number, y: number) => [number, number];
  /** PDF user space → viewport point (top-left origin, rotation applied). */
  toViewportPoint: (x: number, y: number) => [number, number];
  /** The page box in PDF user space: `[x0, y0, x1, y1]`. */
  view: [number, number, number, number];
}

export async function getPageGeometry(
  path: string,
  pageNumber: number,
): Promise<PageGeometry> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const view = page.view as [number, number, number, number];
  return {
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    toPdfPoint: (x, y) => {
      const [px, py] = viewport.convertToPdfPoint(x, y);
      return [px, py];
    },
    toViewportPoint: (x, y) => {
      const [vx, vy] = viewport.convertToViewportPoint(x, y);
      return [vx, vy];
    },
    view,
  };
}

/** Capture the current document page as a multimodal `FileUIPart` for AI SDK messages. */
function imageMediaType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "bmp") return "image/bmp";
  if (ext === "tif" || ext === "tiff") return "image/tiff";
  return "image/jpeg";
}

function bytesToDataUrl(bytes: Uint8Array, mediaType: string): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:${mediaType};base64,${btoa(binary)}`;
}

export async function capturePageFilePart(
  path: string,
  page: number,
  kind: "pdf" | "image",
): Promise<{ type: "file"; mediaType: string; url: string } | null> {
  if (kind === "image") {
    try {
      // TIFF/BMP must be transcoded — chat providers reject those media types
      // in image parts.
      const { bytes, mediaType } = await ensureProviderCompatibleImage(
        await readAuthorizedFileBytes(path),
        imageMediaType(path),
      );
      return { type: "file", mediaType, url: bytesToDataUrl(bytes, mediaType) };
    } catch {
      return null;
    }
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
