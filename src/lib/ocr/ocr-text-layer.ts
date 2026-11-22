import type { PageGeometry } from "../pdf";
import type { TextItemRect } from "../types";

export interface OcrWordBox {
  text: string;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

export type OcrWordInput = OcrWordBox | TextItemRect;

export interface PopulateOcrTextLayerOptions {
  /** Pixel dimensions of the source OCR image when `bbox` is not normalized 0..1. */
  imageSize?: { width: number; height: number };
  /** Page geometry at scale 1 (handles `/Rotate 90/180/270` for `TextItemRect` words). */
  geometry?: Pick<PageGeometry, "viewportWidth" | "viewportHeight" | "toViewportPoint">;
  /** Fallback PDF `[x0, y0, x1, y1]` box for unrotated `TextItemRect` words. */
  view?: readonly [number, number, number, number];
}

interface PxBox {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** True when `container` already has native pdf.js text spans (excluding synthesized OCR spans). */
export function hasNativeTextSpans(container: HTMLElement): boolean {
  for (const el of Array.from(container.querySelectorAll("span"))) {
    if (el.hasAttribute("data-ocr-word")) continue;
    if ((el.textContent ?? "").trim().length > 0) return true;
  }
  return false;
}

function isPdfItem(word: OcrWordInput): word is TextItemRect {
  return "rect" in word;
}

const CJK_END = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]$/;
const CJK_START = /^[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

function toPxBox(
  word: OcrWordInput,
  pageWidthPx: number,
  pageHeightPx: number,
  options?: PopulateOcrTextLayerOptions,
  fallbackPdfSize?: { width: number; height: number },
): PxBox | null {
  const text = word.text.trim();
  if (!text) return null;

  if (isPdfItem(word)) {
    const { rect } = word;
    if (!(rect.width > 0 && rect.height > 0)) return null;
    if (options?.geometry) {
      const { viewportWidth, viewportHeight, toViewportPoint } = options.geometry;
      if (!(viewportWidth > 0 && viewportHeight > 0)) return null;
      const sx = pageWidthPx / viewportWidth;
      const sy = pageHeightPx / viewportHeight;
      const [ax, ay] = toViewportPoint(rect.x, rect.y);
      const [bx, by] = toViewportPoint(rect.x + rect.width, rect.y + rect.height);
      const left = Math.min(ax, bx) * sx;
      const top = Math.min(ay, by) * sy;
      const width = Math.abs(bx - ax) * sx;
      const height = Math.abs(by - ay) * sy;
      return width > 0 && height > 0 ? { text, left, top, width, height } : null;
    }
    if (options?.view) {
      const [vx0, vy0, vx1, vy1] = options.view;
      const vw = vx1 - vx0;
      const vh = vy1 - vy0;
      if (!(vw > 0 && vh > 0)) return null;
      const left = ((rect.x - vx0) / vw) * pageWidthPx;
      const top = ((vy1 - (rect.y + rect.height)) / vh) * pageHeightPx;
      const width = (rect.width / vw) * pageWidthPx;
      const height = (rect.height / vh) * pageHeightPx;
      return width > 0 && height > 0 ? { text, left, top, width, height } : null;
    }
    // Fallback when neither `geometry` nor `view` was supplied: map against
    // a single page-wide box (Letter 612x792 or A4 595.28x841.89 / content extent).
    const vw = fallbackPdfSize?.width ?? Math.max(612, rect.x + rect.width);
    const vh = fallbackPdfSize?.height ?? Math.max(792, rect.y + rect.height);
    const left = (rect.x / vw) * pageWidthPx;
    const top = ((vh - (rect.y + rect.height)) / vh) * pageHeightPx;
    const width = (rect.width / vw) * pageWidthPx;
    const height = (rect.height / vh) * pageHeightPx;
    return width > 0 && height > 0 ? { text, left, top, width, height } : null;
  }

  const { x0, y0, x1, y1 } = word.bbox;
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  if (!(maxX > minX && maxY > minY)) return null;

  const imgW = options?.imageSize?.width;
  const imgH = options?.imageSize?.height;
  const normalized =
    !imgW && !imgH && maxX <= 1.0001 && maxY <= 1.0001 && minX >= -0.0001 && minY >= -0.0001;
  const denomW = normalized ? 1 : imgW && imgW > 0 ? imgW : pageWidthPx;
  const denomH = normalized ? 1 : imgH && imgH > 0 ? imgH : pageHeightPx;

  return {
    text,
    left: (minX / denomW) * pageWidthPx,
    top: (minY / denomH) * pageHeightPx,
    width: ((maxX - minX) / denomW) * pageWidthPx,
    height: ((maxY - minY) / denomH) * pageHeightPx,
  };
}

function sortReadingOrder(boxes: PxBox[]): PxBox[][] {
  const ordered = [...boxes].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: PxBox[][] = [];
  for (const box of ordered) {
    const midY = box.top + box.height / 2;
    const line = lines.find((l) => {
      const f = l[0]!;
      return Math.abs(f.top + f.height / 2 - midY) <= Math.max(f.height, box.height) * 0.55;
    });
    if (line) line.push(box);
    else lines.push([box]);
  }
  for (const line of lines) line.sort((a, b) => a.left - b.left);
  return lines;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) return measureCtx;
  if (typeof document === "undefined") {
    measureCtx = null;
    return null;
  }
  try {
    measureCtx = document.createElement("canvas").getContext("2d");
  } catch {
    measureCtx = null;
  }
  return measureCtx;
}

function measureScaleX(text: string, fontPx: number, targetWidth: number): number | null {
  const ctx = getMeasureContext();
  if (!ctx || !(targetWidth > 0) || !text) return null;
  ctx.font = `${fontPx.toFixed(2)}px sans-serif`;
  const natural = ctx.measureText(text).width;
  if (!(natural > 0)) return null;
  return Math.min(4, Math.max(0.25, targetWidth / natural));
}

/**
 * Inject selectable transparent `<span role="presentation">` elements into
 * `.pdf-text-layer` ONLY when the native PDF text layer has zero text spans.
 */
export function populateOcrTextLayer(
  container: HTMLElement,
  ocrWords: readonly OcrWordInput[],
  pageWidthPx: number,
  pageHeightPx: number,
  options?: PopulateOcrTextLayerOptions,
): number {
  if (!(pageWidthPx > 0 && pageHeightPx > 0)) return 0;
  if (hasNativeTextSpans(container)) return 0;

  for (const prev of Array.from(container.querySelectorAll("[data-ocr-word]"))) {
    prev.remove();
  }
  if (ocrWords.length === 0) return 0;

  let fallbackPdfSize: { width: number; height: number } | undefined;
  if (!options?.geometry && !options?.view) {
    let maxRight = 0;
    let maxTop = 0;
    for (const w of ocrWords) {
      if (isPdfItem(w)) {
        maxRight = Math.max(maxRight, w.rect.x + w.rect.width);
        maxTop = Math.max(maxTop, w.rect.y + w.rect.height);
      }
    }
    if (maxRight > 0 || maxTop > 0) {
      const a4Like = maxTop > 792 && maxTop <= 842 && maxRight <= 600;
      fallbackPdfSize = {
        width: a4Like ? Math.max(595.28, maxRight) : Math.max(612, maxRight),
        height: a4Like ? Math.max(841.89, maxTop) : Math.max(792, maxTop),
      };
    }
  }

  const boxes: PxBox[] = [];
  for (const w of ocrWords) {
    const px = toPxBox(w, pageWidthPx, pageHeightPx, options, fallbackPdfSize);
    if (px) boxes.push(px);
  }
  if (boxes.length === 0) return 0;

  container.style.width = `${Math.round(pageWidthPx)}px`;
  container.style.height = `${Math.round(pageHeightPx)}px`;
  container.style.setProperty("--total-scale-factor", "1");
  container.setAttribute("data-main-rotation", "0");

  const lines = sortReadingOrder(boxes);
  const frag = document.createDocumentFragment();
  let count = 0;

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li]!;
    for (let wi = 0; wi < line.length; wi += 1) {
      const b = line[wi]!;
      const span = document.createElement("span");
      span.setAttribute("role", "presentation");
      span.setAttribute("data-ocr-word", "1");
      const fontPx = Math.max(4, b.height * 0.85);
      const scaleX = measureScaleX(b.text, fontPx, b.width);
      span.style.left = `${b.left.toFixed(2)}px`;
      span.style.top = `${b.top.toFixed(2)}px`;
      span.style.width = `${b.width.toFixed(2)}px`;
      span.style.height = `${b.height.toFixed(2)}px`;
      span.style.fontSize = `${fontPx.toFixed(2)}px`;
      span.style.lineHeight = `${b.height.toFixed(2)}px`;
      span.style.color = "transparent";
      span.style.setProperty("--font-height", `${fontPx.toFixed(2)}px`);
      if (scaleX !== null) {
        span.style.transformOrigin = "0% 0%";
        span.style.transform = `scaleX(${scaleX.toFixed(4)})`;
      }
      const nextWord = wi < line.length - 1 ? line[wi + 1]! : null;
      const joinWithoutSpace =
        nextWord !== null && CJK_END.test(b.text) && CJK_START.test(nextWord.text);
      span.textContent = nextWord && !joinWithoutSpace ? `${b.text} ` : b.text;
      frag.appendChild(span);
      count += 1;
    }
    if (li < lines.length - 1) {
      const br = document.createElement("br");
      br.setAttribute("role", "presentation");
      br.setAttribute("data-ocr-word", "1");
      frag.appendChild(br);
    }
  }

  container.appendChild(frag);
  return count;
}
