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
interface Slot {
  worker: Promise<Worker>;
  /**
   * Rejects when the worker is stopped. tesseract.js's `terminate()` never
   * settles the job the worker was running, so a page in progress would wait
   * forever — and, before 16.0, time out, restart every worker, and leave the
   * page in the other slot to time out in turn (B9).
   */
  stopped: Promise<never>;
  stop: () => void;
}

const workers = new Map<string, Slot>();

function workerFor(langs: OcrLanguages, slot: number): Slot {
  const key = `${langs}#${slot}`;
  let w = workers.get(key);
  if (!w) {
    const worker = resolveCorePath().then((core) =>
      createWorker(langs, OEM.LSTM_ONLY, {
        workerPath: pdfAssetUrl("ocr/worker.min.js"),
        corePath: core,
        langPath: pdfAssetUrl("ocr/lang"),
        workerBlobURL: false,
        gzip: true,
        cacheMethod: "none",
      }),
    );
    let stop = () => {};
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(new Error("OCR worker stopped"));
    });
    stopped.catch(() => {});
    const entry: Slot = { worker, stopped, stop };
    // A worker that failed to start must not poison every later request.
    worker.catch(() => {
      if (workers.get(key) === entry) workers.delete(key);
    });
    workers.set(key, entry);
    w = entry;
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
  const { worker, stopped } = workerFor(langs, slot);
  const w = await Promise.race([worker, stopped]);
  const { data } = await Promise.race([w.recognize(canvas, {}, { blocks: true, text: false }), stopped]);
  return ocrPageFrom(data as unknown as OcrPageIn, toPdf);
}

function stopEntries(keys: string[]): Promise<void> {
  const entries = keys.map((k) => workers.get(k)!).filter(Boolean);
  for (const k of keys) workers.delete(k);
  return Promise.all(
    entries.map((e) => {
      e.stop();
      return e.worker.then((x) => x.terminate()).catch(() => undefined);
    }),
  ).then(() => undefined);
}

/** Stop the worker of one slot — the one a page hung in — and no other. */
export function terminateOcrSlot(slot: number): Promise<void> {
  return stopEntries([...workers.keys()].filter((k) => k.endsWith(`#${slot}`)));
}

/** Stop every worker — on app shutdown, or when OCR is switched off. */
export function terminateOcr(): Promise<void> {
  return stopEntries([...workers.keys()]);
}
