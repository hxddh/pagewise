import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

/** Lazy-loaded pdf.js module (code-split from app entry). */
let pdfjsModule: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null = null;

export async function getPdfJs() {
  if (!pdfjsModule) {
    pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsModule.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjsModule;
}

export type { PDFDocumentProxy };

/** Resolve bundled pdf.js support files against the live webview origin (Tauri-safe). */
export function pdfAssetUrl(relativePath: string): string {
  const base =
    typeof window !== "undefined" && window.location?.href
      ? window.location.href
      : import.meta.env.BASE_URL;
  return new URL(relativePath, base).href;
}

export function pdfCMapUrl(): string {
  return pdfAssetUrl("pdfjs/cmaps/");
}

export function pdfStandardFontUrl(): string {
  return pdfAssetUrl("pdfjs/standard_fonts/");
}

/** The JPEG 2000 / JBIG2 decoders and colour module (see copy-pdfjs-assets.mjs). */
export function pdfWasmUrl(): string {
  return pdfAssetUrl("pdfjs/wasm/");
}

/** Predefined ICC profiles, for colour-managed images. */
export function pdfIccUrl(): string {
  return pdfAssetUrl("pdfjs/iccs/");
}
