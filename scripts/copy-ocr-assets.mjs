import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stage the local-OCR engine and its language data under public/ocr/ (14.0).
 *
 * Only what PageWise loads is copied: the LSTM-only engine in two builds —
 * with and without WebAssembly SIMD, since macOS 12's WebKit has no SIMD —
 * each as a small loader plus a separate .wasm (the `.wasm.js` builds inline
 * the binary as base64 and are a third larger); the worker script; and the
 * `best_int` English and Simplified Chinese models, gzipped. About 10 MB.
 * The language models come from devDependencies: they are data, shipped as
 * files, never imported by code.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nm = join(root, "node_modules");
const dest = join(root, "public", "ocr");

const FILES = [
  ["tesseract.js/dist/worker.min.js", "worker.min.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.js", "tesseract-core-simd-lstm.js"],
  ["tesseract.js-core/tesseract-core-simd-lstm.wasm", "tesseract-core-simd-lstm.wasm"],
  ["tesseract.js-core/tesseract-core-lstm.js", "tesseract-core-lstm.js"],
  ["tesseract.js-core/tesseract-core-lstm.wasm", "tesseract-core-lstm.wasm"],
  ["@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz", "lang/eng.traineddata.gz"],
  ["@tesseract.js-data/chi_sim/4.0.0_best_int/chi_sim.traineddata.gz", "lang/chi_sim.traineddata.gz"],
];

if (!existsSync(join(nm, "tesseract.js"))) {
  console.warn("[copy-ocr-assets] tesseract.js not installed — skipping");
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
for (const [from, to] of FILES) {
  const src = join(nm, from);
  if (!existsSync(src)) {
    console.error(`[copy-ocr-assets] missing ${from}`);
    process.exit(1);
  }
  mkdirSync(dirname(join(dest, to)), { recursive: true });
  copyFileSync(src, join(dest, to));
}
console.log(`[copy-ocr-assets] copied ${FILES.length} files to public/ocr/`);
