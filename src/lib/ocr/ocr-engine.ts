/**
 * The local OCR engine: tesseract.js, running in a Web Worker, entirely from
 * files the app ships (14.0).
 *
 * Nothing is fetched from the network. tesseract.js defaults to a CDN for its
 * core and language data and to a `blob:` URL for its worker; the first would
 * send nothing personal but would make scans depend on a connection, and the
 * second is refused by the app's CSP. So every path points at `public/ocr/`
 * (staged by `scripts/copy-ocr-assets.mjs`), the worker is loaded from the
 * app's own origin, and the language models are read gzipped with no
 * IndexedDB copy — they are already on disk.
 *
 * The core build is chosen here rather than by tesseract.js: it would ask for
 * the relaxed-SIMD build on engines that support it, which is not shipped, and
 * macOS 12's WebKit has no SIMD at all. Two builds ship; this picks one.
 * They sit beside the worker, not in a folder of their own: the core looks
 * for its `.wasm` next to the script that loaded it, which is the worker.
 */
import { createWorker, OEM, type Worker } from "tesseract.js";
import { simd } from "wasm-feature-detect";
import { pdfAssetUrl } from "../pdf-loader";
import { ocrPageFrom, type OcrPage, type OcrPageIn, type PixelToPdf } from "./ocr-result";

/** Languages PageWise ships models for. */
export type OcrLanguages = "eng" | "chi_sim+eng";

let corePath: Promise<string> | null = null;
function resolveCorePath(): Promise<string> {
  corePath ??= simd().then(
    (yes) => pdfAssetUrl(`ocr/tesseract-core-${yes ? "simd-" : ""}lstm.js`),
    () => pdfAssetUrl("ocr/tesseract-core-lstm.js"),
  );
  return corePath;
}

/**
 * Workers run one page at a time each, so parallelism is one worker per slot.
 * The service decides how many slots there are.
 */
const workers = new Map<string, Promise<Worker>>();

function workerFor(langs: OcrLanguages, slot: number): Promise<Worker> {
  const key = `${langs}#${slot}`;
  let w = workers.get(key);
  if (!w) {
    w = resolveCorePath().then((core) =>
      createWorker(langs, OEM.LSTM_ONLY, {
        workerPath: pdfAssetUrl("ocr/worker.min.js"),
        corePath: core,
        langPath: pdfAssetUrl("ocr/lang"),
        workerBlobURL: false,
        gzip: true,
        cacheMethod: "none",
      }),
    );
    // A worker that failed to start must not poison every later request.
    w.catch(() => workers.delete(key));
    workers.set(key, w);
  }
  return w;
}

/** Recognise one rendered page. `toPdf` maps its pixels into PDF user space. */
export async function recognizeCanvas(
  canvas: HTMLCanvasElement,
  toPdf: PixelToPdf,
  langs: OcrLanguages,
  slot = 0,
): Promise<OcrPage> {
  const worker = await workerFor(langs, slot);
  const { data } = await worker.recognize(canvas, {}, { blocks: true, text: false });
  return ocrPageFrom(data as unknown as OcrPageIn, toPdf);
}

/** Stop every worker — on app shutdown, or when OCR is switched off. */
export async function terminateOcr(): Promise<void> {
  const all = [...workers.values()];
  workers.clear();
  await Promise.all(all.map((w) => w.then((x) => x.terminate()).catch(() => undefined)));
}
