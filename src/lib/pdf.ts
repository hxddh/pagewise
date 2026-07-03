import * as pdfjs from "pdfjs-dist";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { PdfExtractResult } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url,
).toString();

export async function extractPdfFromRust(path: string): Promise<PdfExtractResult> {
  return invoke<PdfExtractResult>("extract_pdf_text_cmd", { path, page: null });
}

let pdfDocCache: { path: string; doc: pdfjs.PDFDocumentProxy } | null = null;

async function getPdfDocument(path: string): Promise<pdfjs.PDFDocumentProxy> {
  if (pdfDocCache?.path === path) {
    return pdfDocCache.doc;
  }
  const doc = await pdfjs.getDocument({ url: convertFileSrc(path) }).promise;
  pdfDocCache = { path, doc };
  return doc;
}

export async function renderPageToCanvas(
  path: string,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  scale = 1.5,
): Promise<{ totalPages: number }> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  return { totalPages: doc.numPages };
}

export function clearPdfCache(): void {
  pdfDocCache = null;
}

export async function getPdfPageCount(path: string): Promise<number> {
  const doc = await getPdfDocument(path);
  return doc.numPages;
}

export async function computeFitWidthScale(
  path: string,
  pageNumber: number,
  containerWidth: number,
  padding = 32,
): Promise<number> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const available = Math.max(120, containerWidth - padding);
  return available / base.width;
}

export async function renderThumbnail(
  path: string,
  pageNumber: number,
  canvas: HTMLCanvasElement,
  maxWidth = 112,
): Promise<void> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const scale = maxWidth / base.width;
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
}

export async function renderPageToPngBytes(
  path: string,
  pageNumber: number,
  scale = 2,
): Promise<Uint8Array> {
  const doc = await getPdfDocument(path);
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  await page.render({ canvasContext: ctx, viewport, canvas }).promise;

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
  });

  return new Uint8Array(await blob.arrayBuffer());
}

export async function ocrPdfPage(path: string, pageNumber: number): Promise<string> {
  const bytes = await renderPageToPngBytes(path, pageNumber);
  return invoke<string>("ocr_bytes", { data: Array.from(bytes) });
}
