import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

/** Lazy-loaded pdf.js module (code-split from app entry). */
let pdfjsModule: typeof import("pdfjs-dist/legacy/build/pdf.mjs") | null = null;

export async function getPdfJs() {
  if (!pdfjsModule) {
    pdfjsModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
    pdfjsModule.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/legacy/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  }
  return pdfjsModule;
}

export type { PDFDocumentProxy };

export const PDF_CMAP_URL = new URL("pdfjs-dist/cmaps/", import.meta.url).href;
export const PDF_STANDARD_FONT_URL = new URL(
  "pdfjs-dist/standard_fonts/",
  import.meta.url,
).href;
