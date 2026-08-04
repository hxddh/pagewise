/**
 * What the reader left on the document.
 *
 * PageWise was read-only: you read, you asked, and closing the document left
 * nothing on it. A mark is one thing — a place, the words that were there, and
 * optionally something the reader wanted to say about them. A mark with no note
 * is a highlight; a mark with one is an annotation. One type, so there is one
 * store, one layer and one list.
 *
 * Marks are anchored on page geometry, never on text. Measured on the sample
 * document, only 24% of sentence-length quotes can be located by matching page
 * text against text runs — the two come from different extraction paths and
 * disagree. A page number and a rectangle go through neither, so they survive
 * an upstream extractor change, which matters because the `pdf-inspector`
 * version is deliberately not pinned. `text` is a snapshot for the reader's
 * benefit, not an anchor.
 */
import { LazyStore } from "@tauri-apps/plugin-store";
import type { PdfRect } from "./types";

const STORE_PATH = "marks.json";
const KEY = "marks";
const VERSION = 1;

/** Marks kept for one document. A defence against runaway state, not a policy. */
export const MAX_MARKS_PER_DOC = 2_000;
/** Marks kept in total, across every document. */
export const MAX_MARKS_TOTAL = 20_000;
/** Longest snapshot stored, matching the selection quote cap. */
export const MAX_MARK_TEXT = 500;
/** Longest note stored. */
export const MAX_NOTE_TEXT = 2_000;
/** Coalesce a burst of edits into one write. */
const FLUSH_DELAY_MS = 400;

export interface Mark {
  id: string;
  /** 1-based. */
  page: number;
  /** One rect per line of the selection. Top-left origin, PDF points. */
  rects: PdfRect[];
  /** The words under the marks when it was made. Never used to locate it. */
  text: string;
  /** What the reader wanted to say. Empty for a plain highlight. */
  note: string;
  /**
   * How to draw it. Absent means "text" — marks stored by 5.0 have no kind.
   *
   * A wash over words makes them easier to find; the same wash over a figure
   * hides the figure, which is the thing the reader boxed it to see. Only the
   * drawing differs — both are located by their rectangles.
   */
  kind?: "text" | "region";
  createdAt: number;
  /** The file's stamp when the mark was made — see `marksAreStale`. */
  stamp: string;
}

interface StoredDoc {
  path: string;
  marks: Mark[];
}

interface StoredMarks {
  version: number;
  docs: StoredDoc[];
}

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) store = new LazyStore(STORE_PATH);
  return store;
}

/**
 * Serializes every mutation through one promise chain.
 *
 * The same reason the index store does it: an unserialized read-modify-write
 * loses entries to last-write-wins. Losing a cached page costs a re-index;
 * losing a mark costs the reader's own work, so it matters more here.
 */
let storeLock: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = storeLock.then(fn, fn);
  storeLock = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function isValidRect(value: unknown): value is PdfRect {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<PdfRect>;
  return (
    typeof r.x === "number" &&
    typeof r.y === "number" &&
    typeof r.width === "number" &&
    typeof r.height === "number" &&
    Number.isFinite(r.x) &&
    Number.isFinite(r.y) &&
    Number.isFinite(r.width) &&
    Number.isFinite(r.height)
  );
}

function isValidMark(value: unknown): value is Mark {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<Mark>;
  return (
    typeof m.id === "string" &&
    m.id.length > 0 &&
    typeof m.page === "number" &&
    Number.isInteger(m.page) &&
    m.page >= 1 &&
    Array.isArray(m.rects) &&
    m.rects.length > 0 &&
    m.rects.every(isValidRect) &&
    typeof m.text === "string" &&
    typeof m.note === "string" &&
    typeof m.createdAt === "number" &&
    Number.isFinite(m.createdAt) &&
    typeof m.stamp === "string" &&
    (m.kind === undefined || m.kind === "text" || m.kind === "region")
  );
}

/**
 * Coerce arbitrary stored data into marks.
 *
 * Corrupt state must never block a document from opening. Unlike the index
 * cache, a dropped entry here is unrecoverable, so validation rejects only
 * entries that are actually unusable — a mark with no rects cannot be drawn.
 */
export function sanitizeStoredMarks(raw: unknown): StoredDoc[] {
  if (!raw || typeof raw !== "object") return [];
  const parsed = raw as Partial<StoredMarks>;
  if (parsed.version !== VERSION || !Array.isArray(parsed.docs)) return [];
  const out: StoredDoc[] = [];
  let total = 0;
  for (const doc of parsed.docs) {
    if (!doc || typeof doc !== "object") continue;
    const d = doc as Partial<StoredDoc>;
    if (typeof d.path !== "string" || !d.path || !Array.isArray(d.marks)) continue;
    const marks = d.marks.filter(isValidMark).slice(0, MAX_MARKS_PER_DOC);
    if (marks.length === 0) continue;
    if (total + marks.length > MAX_MARKS_TOTAL) continue;
    total += marks.length;
    out.push({ path: d.path, marks });
  }
  return out;
}

async function readDocs(): Promise<StoredDoc[]> {
  const s = await getStore();
  return sanitizeStoredMarks(await s.get<unknown>(KEY));
}

async function writeDocs(docs: StoredDoc[]): Promise<void> {
  const s = await getStore();
  await s.set(KEY, { version: VERSION, docs } satisfies StoredMarks);
  await s.save();
}

/**
 * In-memory marks for the open document, so drawing a page never awaits disk.
 * The store is the durable copy; this is what the UI reads.
 */
const marksByPath = new Map<string, Mark[]>();
type MarkListener = (path: string) => void;
const listeners = new Set<MarkListener>();

function notify(path: string): void {
  for (const listener of listeners) {
    try {
      listener(path);
    } catch {
      // A misbehaving subscriber must not break mark updates.
    }
  }
}

export function subscribeMarks(listener: MarkListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Marks for `path`, page order then creation order. */
export function getMarks(path: string): Mark[] {
  return marksByPath.get(path) ?? [];
}

export function marksOnPage(path: string, page: number): Mark[] {
  return getMarks(path).filter((m) => m.page === page);
}

/** Pages carrying at least one mark, ascending. */
export function pagesWithMarks(path: string): number[] {
  const pages = new Set<number>();
  for (const mark of getMarks(path)) pages.add(mark.page);
  return [...pages].sort((a, b) => a - b);
}

/**
 * Marks made against a different version of the file than the one open.
 *
 * The index cache DISCARDS its pages when the stamp changes — they are free to
 * recompute. A mark is the reader's own work, so it is kept and flagged: the
 * rectangle may now point at the wrong place, but the snapshot still says what
 * was marked, and only the reader can judge that.
 */
export function marksAreStale(path: string, stamp: string): boolean {
  if (!stamp) return false;
  return getMarks(path).some((m) => m.stamp !== stamp);
}

function sortMarks(marks: Mark[]): Mark[] {
  return [...marks].sort((a, b) => a.page - b.page || a.createdAt - b.createdAt);
}

/** Load a document's marks into memory. Call once per open. */
export async function loadMarks(path: string): Promise<Mark[]> {
  try {
    const docs = await withStoreLock(readDocs);
    const marks = sortMarks(docs.find((d) => d.path === path)?.marks ?? []);
    marksByPath.set(path, marks);
    notify(path);
    return marks;
  } catch {
    marksByPath.set(path, []);
    return [];
  }
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
const dirty = new Set<string>();
let flushInFlight: Promise<void> = Promise.resolve();

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushMarkStore();
  }, FLUSH_DELAY_MS);
}

/** Write pending changes now (document close, app quit, before stats). */
export async function flushMarkStore(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (dirty.size === 0) {
    await flushInFlight;
    return;
  }
  const paths = [...dirty];
  dirty.clear();
  flushInFlight = withStoreLock(async () => {
    const docs = await readDocs();
    const byPath = new Map(docs.map((d) => [d.path, d] as const));
    for (const path of paths) {
      const marks = marksByPath.get(path) ?? [];
      if (marks.length === 0) byPath.delete(path);
      else byPath.set(path, { path, marks: marks.slice(0, MAX_MARKS_PER_DOC) });
    }
    let total = 0;
    const kept: StoredDoc[] = [];
    for (const doc of byPath.values()) {
      if (total + doc.marks.length > MAX_MARKS_TOTAL) continue;
      total += doc.marks.length;
      kept.push(doc);
    }
    await writeDocs(kept);
  }).catch(() => {
    // A failed write must not lose the marks — they stay in memory and in
    // `dirty` for the next attempt.
    for (const path of paths) dirty.add(path);
  });
  await flushInFlight;
}

function mutate(path: string, next: Mark[]): void {
  marksByPath.set(path, sortMarks(next));
  dirty.add(path);
  notify(path);
  scheduleFlush();
}

export interface NewMark {
  page: number;
  rects: PdfRect[];
  text: string;
  note?: string;
  stamp: string;
  kind?: "text" | "region";
}

/** Add a mark and return it, or null when the document is already at its cap. */
export function addMark(path: string, input: NewMark): Mark | null {
  const existing = getMarks(path);
  if (existing.length >= MAX_MARKS_PER_DOC) return null;
  if (input.rects.length === 0) return null;
  const mark: Mark = {
    id: crypto.randomUUID(),
    page: input.page,
    rects: input.rects,
    text: input.text.slice(0, MAX_MARK_TEXT),
    note: (input.note ?? "").slice(0, MAX_NOTE_TEXT),
    createdAt: Date.now(),
    stamp: input.stamp,
    // Omitted for text marks, so a document of them stores nothing extra.
    ...(input.kind === "region" ? { kind: "region" as const } : {}),
  };
  mutate(path, [...existing, mark]);
  return mark;
}

export function setMarkNote(path: string, id: string, note: string): void {
  const existing = getMarks(path);
  const trimmed = note.slice(0, MAX_NOTE_TEXT);
  let changed = false;
  const next = existing.map((m) => {
    if (m.id !== id || m.note === trimmed) return m;
    changed = true;
    return { ...m, note: trimmed };
  });
  if (changed) mutate(path, next);
}

export function removeMark(path: string, id: string): void {
  const existing = getMarks(path);
  const next = existing.filter((m) => m.id !== id);
  if (next.length !== existing.length) mutate(path, next);
}

/** Drop a document's marks from memory. The stored copy is untouched. */
export function forgetMarks(path: string): void {
  marksByPath.delete(path);
}

export interface MarkStoreStats {
  docs: number;
  marks: number;
}

export async function getMarkStoreStats(): Promise<MarkStoreStats> {
  await flushMarkStore();
  try {
    const docs = await withStoreLock(readDocs);
    return { docs: docs.length, marks: docs.reduce((n, d) => n + d.marks.length, 0) };
  } catch {
    return { docs: 0, marks: 0 };
  }
}

// Closing the window with edits still buffered would throw away the reader's
// own work. The unload handler cannot await, which is why the debounce is short.
if (typeof window !== "undefined") {
  const flushOnExit = () => {
    void flushMarkStore();
  };
  window.addEventListener("beforeunload", flushOnExit);
  window.addEventListener("pagehide", flushOnExit);
}

export function __resetMarkStoreForTests(): void {
  marksByPath.clear();
  dirty.clear();
  listeners.clear();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  store = null;
}
