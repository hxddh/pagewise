/**
 * Local OCR as a service the rest of the app asks (14.0).
 *
 * One question: "what words are on this page, and where?" — for a page with
 * no text layer. The answer is computed at most once per page per document:
 * kept in memory while the document is open, and on disk (`ocr-store.ts`)
 * across launches, keyed by the file's content so a rename keeps it.
 *
 * TWO KINDS OF ASKING. A reader looking at a page, or the assistant reading
 * one, is waiting; the background sweep that reads the rest of a scan is not.
 * Both go through one queue with two slots, and a waiting request always takes
 * the next free slot ahead of the sweep. A slot is a tesseract worker, and a
 * page takes seconds, so two keeps one core free for everything else.
 *
 * Nothing here decides what OCR text is worth — whether it beats vision, or
 * whether a citation that is absent from it is wrong. It reads pages.
 */
import { docCache } from "../doc-cache";
import { readAuthorizedFileBytes, renderPageForOcr } from "../pdf";
import { recognizeCanvas, terminateOcr, type OcrLanguages } from "./ocr-engine";
import { readOcrDoc, writeOcrDoc, type StoredOcrPage } from "./ocr-store";
import { ocrDpiFor } from "./ocr-result";
import type { PageText } from "../types";

export const OCR_SLOTS = 2;
/**
 * A page that takes longer than this is abandoned and the workers restarted.
 * tesseract.js does not reject when its core or a model fails to load — it
 * waits forever — so without a ceiling one bad start would hang every page.
 */
const PAGE_TIMEOUT_MS = 90_000;
/** Coalesce a sweep's writes into one save every few seconds. */
const FLUSH_DELAY_MS = 4_000;

let enabled = true;
// Until the stored preference arrives: what "auto" would pick.
let languages: OcrLanguages =
  typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "chi_sim+eng" : "eng";

/** Apply the reader's preference. Switching models or turning OCR off stops the workers. */
export function configureOcr(options: { enabled: boolean; languages: OcrLanguages }): void {
  const changed = options.enabled !== enabled || options.languages !== languages;
  enabled = options.enabled;
  if (options.languages !== languages) {
    // Pages read with other models stay valid for what they are, but the
    // store is keyed by models; drop the in-memory copies with them.
    for (const state of docs.values()) state.pages.clear();
  }
  languages = options.languages;
  if (changed) void terminateOcr();
}

export function ocrEnabled(): boolean {
  return enabled;
}

export function ocrLanguages(): OcrLanguages {
  return languages;
}

interface DocState {
  identity?: string;
  pages: Map<number, StoredOcrPage>;
  inflight: Map<number, Promise<StoredOcrPage | null>>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
}

const docs = new Map<string, DocState>();

function stateFor(path: string): DocState {
  let s = docs.get(path);
  if (!s) {
    s = { pages: new Map(), inflight: new Map(), flushTimer: null, dirty: false };
    docs.set(path, s);
  }
  return s;
}

/**
 * Load what was read on this file before, and return it as page text for the
 * document being opened. Call before the document is committed, so a scan
 * opens with its words already in place.
 */
export async function restoreOcr(path: string, identity?: string): Promise<PageText[]> {
  const state = stateFor(path);
  if (identity) state.identity = identity;
  if (!enabled || !identity) return [];
  const stored = await readOcrDoc(identity, languages);
  for (const p of stored) if (!state.pages.has(p.page)) state.pages.set(p.page, p);
  return stored.map((p) => ({ page: p.page, text: p.text, source: "ocr" as const }));
}

/** The page as already read, without reading it. */
export function cachedOcrPage(path: string, page: number): StoredOcrPage | undefined {
  return docs.get(path)?.pages.get(page);
}

/** How long reading a page takes here, for the progress hint. */
export function ocrTimings(path: string): { pages: number; medianMs: number } {
  const ms = [...(docs.get(path)?.pages.values() ?? [])].map((p) => p.ms).filter((m) => m > 0).sort((a, b) => a - b);
  return { pages: docs.get(path)?.pages.size ?? 0, medianMs: ms.length ? ms[Math.floor(ms.length / 2)]! : 0 };
}

// ---------------------------------------------------------------- the queue

interface Job {
  path: string;
  page: number;
  background: boolean;
  signal?: AbortSignal;
  run: (slot: number) => Promise<void>;
  drop: () => void;
}

const queue: Job[] = [];
const freeSlots: number[] = Array.from({ length: OCR_SLOTS }, (_, i) => i);

function pump(): void {
  while (freeSlots.length > 0 && queue.length > 0) {
    const waiting = queue.findIndex((j) => !j.background);
    const job = queue.splice(waiting >= 0 ? waiting : 0, 1)[0]!;
    if (job.signal?.aborted || !docs.has(job.path)) {
      job.drop();
      continue;
    }
    const slot = freeSlots.shift()!;
    void job.run(slot).finally(() => {
      freeSlots.push(slot);
      pump();
    });
  }
}

/** Jobs waiting for a slot, for tests and the progress hint. */
export function ocrQueueLength(): number {
  return queue.length;
}

async function recognize(path: string, page: number, slot: number, signal?: AbortSignal): Promise<StoredOcrPage | null> {
  const started = performance.now();
  const langs = languages;
  const doc = docCache.get(path);
  if (!doc) return null;
  if (doc.kind === "image") {
    // An image has no PDF space to put boxes in; its words are text only.
    const bytes = await readAuthorizedFileBytes(path, signal);
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart]));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      const read = await recognizeCanvas(canvas, (x, y) => [x, y], langs, slot);
      return { ...read, items: [], page, ms: performance.now() - started };
    } finally {
      bitmap.close();
    }
  }
  const { canvas, toPdf } = await renderPageForOcr(path, page, signal, ocrDpiFor(langs));
  const read = await recognizeCanvas(canvas, toPdf, langs, slot);
  // Release the page image now rather than when the collector gets to it.
  canvas.width = 0;
  canvas.height = 0;
  return { ...read, page, ms: performance.now() - started };
}

/**
 * Read one page, or return what was read already. Resolves to null when OCR
 * is off, the document closed or the request was cancelled before it started,
 * or recognition failed — never throws.
 */
export function ocrPage(
  path: string,
  page: number,
  options: { signal?: AbortSignal; background?: boolean } = {},
): Promise<StoredOcrPage | null> {
  if (!enabled || options.signal?.aborted) return Promise.resolve(null);
  const state = stateFor(path);
  const done = state.pages.get(page);
  if (done) return Promise.resolve(done);
  const inflight = state.inflight.get(page);
  if (inflight) {
    // A sweep job someone is now waiting on moves to the front.
    if (!options.background) {
      const queued = queue.find((j) => j.path === path && j.page === page);
      if (queued) queued.background = false;
    }
    return inflight;
  }
  const langs = languages;
  const promise = new Promise<StoredOcrPage | null>((resolve) => {
    const job: Job = {
      path,
      page,
      background: !!options.background,
      signal: options.signal,
      drop: () => resolve(null),
      run: async (slot) => {
        let result: StoredOcrPage | null = null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          result = await Promise.race([
            recognize(path, page, slot, options.signal),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("OCR timed out")), PAGE_TIMEOUT_MS);
            }),
          ]);
        } catch (err) {
          if (import.meta.env.DEV) console.warn(`[ocr] page ${page}:`, err);
          if (err instanceof Error && err.message === "OCR timed out") void terminateOcr();
        } finally {
          clearTimeout(timer);
        }
        // The document closed, or the models changed, while this page was read.
        if (result && docs.get(path) === state && langs === languages && enabled) {
          state.pages.set(page, result);
          scheduleFlush(path, state);
        } else {
          result = null;
        }
        resolve(result);
      },
    };
    queue.push(job);
  }).finally(() => {
    if (state.inflight.get(page) === promise) state.inflight.delete(page);
  });
  state.inflight.set(page, promise);
  pump();
  return promise;
}

function scheduleFlush(path: string, state: DocState): void {
  state.dirty = true;
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    void flushOcr(path);
  }, FLUSH_DELAY_MS);
}

/** Write this document's pages to disk now, if anything changed. */
export async function flushOcr(path: string): Promise<void> {
  const state = docs.get(path);
  if (!state || !state.dirty || !state.identity) return;
  if (state.flushTimer) {
    clearTimeout(state.flushTimer);
    state.flushTimer = null;
  }
  state.dirty = false;
  try {
    await writeOcrDoc(state.identity, languages, state.pages.values());
  } catch (err) {
    state.dirty = true;
    if (import.meta.env.DEV) console.warn("[ocr] cache write failed", err);
  }
}

/** The document is closing: save what was read, drop the rest of its queue. */
export function forgetOcr(path: string): void {
  const state = docs.get(path);
  if (!state) return;
  void flushOcr(path);
  docs.delete(path);
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.path === path) queue.splice(i, 1)[0]!.drop();
  }
}

/** Test seam. */
export function __resetOcrServiceForTests(): void {
  for (const s of docs.values()) if (s.flushTimer) clearTimeout(s.flushTimer);
  docs.clear();
  queue.length = 0;
  freeSlots.length = 0;
  for (let i = 0; i < OCR_SLOTS; i++) freeSlots.push(i);
  enabled = true;
  languages = "eng";
}
