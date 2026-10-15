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
import { bothModelsWin, CJK_RETRY_CONFIDENCE, doubtfulInEnglish, MIN_PROBE_CHARS } from "./ocr-language";
import { readAuthorizedFileBytes, renderPageForOcr } from "../pdf";
import { recognizeCanvas, terminateOcr, terminateOcrSlot, type OcrLanguages } from "./ocr-engine";
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
  const previous = languages;
  languages = options.languages;
  if (previous !== languages) {
    // What was read with the other models stays valid for them: written to
    // their section of the file before the pages leave memory, and this set's
    // section read back in (16.0, B7).
    for (const [path, state] of docs) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.dirty && state.identity) {
        void writeOcrDoc(state.identity, state.langs ?? previous, state.pages.values()).catch(() => {});
      }
      state.dirty = false;
      state.pages.clear();
      // The interface's choice changed: the document chooses again.
      state.langs = undefined;
      state.cjkProbes = 0;
      if (enabled && state.identity) void restoreOcr(path, state.identity);
    }
  }
  if (changed) void terminateOcr();
}

export function ocrEnabled(): boolean {
  return enabled;
}

interface DocState {
  identity?: string;
  /**
   * The models this document reads with, when its pages chose them (22.0):
   * a scan in Chinese opened under an English interface. Unset means the
   * interface's choice, `languages`.
   */
  langs?: OcrLanguages;
  /** Pages tried with both models without that helping — capped, see below. */
  cjkProbes: number;
  pages: Map<number, StoredOcrPage>;
  inflight: Map<number, Promise<StoredOcrPage | null>>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  dirty: boolean;
}

const docs = new Map<string, DocState>();

function stateFor(path: string): DocState {
  let s = docs.get(path);
  if (!s) {
    s = { pages: new Map(), inflight: new Map(), flushTimer: null, dirty: false, cjkProbes: 0 };
    docs.set(path, s);
  }
  return s;
}

function langsFor(state: DocState): OcrLanguages {
  return state.langs ?? languages;
}

/** Probes that did not help before a document stops trying (a photo, a form). */
const MAX_CJK_PROBES = 2;

function meanConfidence(pages: readonly StoredOcrPage[]): number {
  // Pages with too little text say nothing about the script.
  const read = pages.filter((p) => p.text.trim().length >= MIN_PROBE_CHARS);
  return read.length === 0 ? 100 : read.reduce((n, p) => n + p.confidence, 0) / read.length;
}

/**
 * Load what was read on this file before, and return it as page text for the
 * document being opened. Call before the document is committed, so a scan
 * opens with its words already in place.
 *
 * A document that switched to both models once (22.0) has its pages in that
 * section; finding them is what remembers the switch.
 */
export async function restoreOcr(path: string, identity?: string): Promise<PageText[]> {
  const state = stateFor(path);
  if (identity) state.identity = identity;
  if (!enabled || !identity) return [];
  let stored = await readOcrDoc(identity, langsFor(state));
  if (languages === "eng" && !state.langs) {
    // Both sections can exist for a reader who changed the interface
    // language; English wins unless what it read is what a Chinese page reads
    // like to it.
    const both = await readOcrDoc(identity, "chi_sim+eng");
    if (both.length > 0 && (stored.length === 0 || meanConfidence(stored) < CJK_RETRY_CONFIDENCE)) {
      state.langs = "chi_sim+eng";
      stored = both;
    }
  }
  for (const p of stored) if (!state.pages.has(p.page)) state.pages.set(p.page, p);
  return stored.map((p) => ({ page: p.page, text: p.text, source: "ocr" as const }));
}

/** The page as already read, without reading it. */
export function cachedOcrPage(path: string, page: number): StoredOcrPage | undefined {
  return docs.get(path)?.pages.get(page);
}

// ---------------------------------------------------------------- the queue

interface Job {
  path: string;
  page: number;
  background: boolean;
  signal?: AbortSignal;
  /** When a slot took this job; null while it waits in the queue. */
  startedAt: number | null;
  run: (slot: number) => Promise<void>;
  drop: () => void;
}

const queue: Job[] = [];
const freeSlots: number[] = Array.from({ length: OCR_SLOTS }, (_, i) => i);

/**
 * Who is watching the queue.
 *
 * The preview's reading line (19.0) needs to know which page is being
 * recognised and how many are still waiting — the queue was invisible before,
 * and "wait for it" with no indication of how long is what makes a reader
 * think the app has stopped. Notified on every change that a watcher could
 * draw: a job queued, started, finished or dropped.
 */
const queueListeners = new Set<() => void>();

function notifyQueue(): void {
  for (const listener of queueListeners) listener();
}

export function subscribeOcrQueue(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => {
    queueListeners.delete(listener);
  };
}

export interface OcrQueueState {
  /** The page of this document being recognised right now, if any. */
  current: number | null;
  /** Pages of this document waiting for a slot. */
  queued: number;
}

/** What the queue is doing for one document, without reading anything. */
export function ocrQueueState(path: string): OcrQueueState {
  let current: number | null = null;
  let queued = 0;
  for (const job of queue) {
    if (job.path !== path) continue;
    if (job.startedAt !== null && current === null) current = job.page;
    if (job.startedAt === null) queued += 1;
  }
  return { current, queued };
}

/**
 * Drop this document's waiting jobs; the page being recognised finishes.
 *
 * Cancelling the middle of a recognition would throw away work already paid
 * for in CPU, and tesseract has no way to resume — so cancel means "read no
 * more pages", which is what a reader who wants to stop a scan wants. What is
 * being read right now lands in the page and the cache as usual.
 */
export function cancelQueuedOcr(path: string): number {
  let dropped = 0;
  for (let i = queue.length - 1; i >= 0; i--) {
    if (queue[i]!.path !== path) continue;
    queue.splice(i, 1)[0]!.drop();
    dropped += 1;
  }
  if (dropped > 0) notifyQueue();
  return dropped;
}

function pump(): void {
  while (freeSlots.length > 0 && queue.length > 0) {
    const waiting = queue.findIndex((j) => !j.background);
    const job = queue.splice(waiting >= 0 ? waiting : 0, 1)[0]!;
    if (job.signal?.aborted || !docs.has(job.path)) {
      job.drop();
      continue;
    }
    job.startedAt = performance.now();
    notifyQueue();
    const slot = freeSlots.shift()!;
    void job.run(slot).finally(() => {
      freeSlots.push(slot);
      notifyQueue();
      pump();
    });
  }
}

/**
 * Read a page with the document's models. A page read with English alone that
 * comes back with words but low confidence is read again with both (22.0):
 * until then the models followed the interface language only, so a Chinese
 * scan opened under an English interface located 2.2% of its quotes, against
 * 87.8% with both models — and nothing said why. When both models do
 * clearly better, the document reads with them from then on.
 */
async function recognize(path: string, page: number, slot: number, signal?: AbortSignal): Promise<StoredOcrPage | null> {
  const started = performance.now();
  const state = stateFor(path);
  const langs = langsFor(state);
  const first = await recognizeWith(path, page, slot, langs, signal);
  if (!first || langs !== "eng") return first && { ...first, ms: performance.now() - started };
  const doubtful = doubtfulInEnglish(first);
  // Another page may have switched the document while this one was read.
  const switched = langsFor(state) === "chi_sim+eng";
  if (!doubtful || (!switched && state.cjkProbes >= MAX_CJK_PROBES)) {
    return { ...first, ms: performance.now() - started };
  }
  const both = await recognizeWith(path, page, slot, "chi_sim+eng", signal);
  const better = bothModelsWin(first, both);
  if (!switched) {
    if (better) state.langs = "chi_sim+eng";
    else state.cjkProbes += 1;
  }
  return { ...(better && both ? both : first), ms: performance.now() - started };
}

async function recognizeWith(
  path: string,
  page: number,
  slot: number,
  langs: OcrLanguages,
  signal?: AbortSignal,
): Promise<StoredOcrPage | null> {
  const started = performance.now();
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
  // The interface's choice when this was asked: a change of it while the page
  // is read throws the result away (the pages are re-read with the new one).
  const langs = languages;
  const promise = new Promise<StoredOcrPage | null>((resolve) => {
    const job: Job = {
      path,
      page,
      background: !!options.background,
      signal: options.signal,
      startedAt: null,
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
          // Restart only the worker this page hung in; the other slot's page
          // is fine and keeps going (16.0, B9).
          if (err instanceof Error && err.message === "OCR timed out") void terminateOcrSlot(slot);
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
    notifyQueue();
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
    await writeOcrDoc(state.identity, langsFor(state), state.pages.values());
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