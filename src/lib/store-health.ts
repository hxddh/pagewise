/**
 * Files this session could not read, so the app can say so out loud.
 *
 * The stores all answer a failed read the only way they can: the reader's marks
 * load as none, the index cache misses, the record is empty. Until 20.0 that
 * was indistinguishable from "there is nothing stored", because the plugin
 * swallowed the parse error and handed back an empty map — and the next save
 * wrote that emptiness over the file.
 *
 * `atomic-store.ts` now raises `StoreUnreadableError` instead, and the stores
 * keep their behaviour (a corrupt cache must not block opening a document). The
 * one thing they cannot do is tell the reader. That is this module: one entry
 * per file, reported once, subscribed to by the app shell, which shows it as a
 * toast. Nothing here carries stored content — only the file name and why the
 * read failed.
 */
export interface UnreadableStore {
  /** The store file's name, e.g. `marks.json`. */
  file: string;
  message: string;
}

const unreadable = new Map<string, string>();
const listeners = new Set<(store: UnreadableStore) => void>();

/** Record that `file` could not be read. The first report per file wins. */
export function reportStoreUnreadable(file: string, message: string): void {
  if (unreadable.has(file)) return;
  unreadable.set(file, message);
  const entry = { file, message };
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {
      // A misbehaving subscriber must not break a store read.
    }
  }
}

/**
 * Why a store held a write back, the two cases that are not a failed read:
 * - `newer` — the file was written by a later PageWise, so this build reads it
 *   as empty and never writes it (a write would replace the reader's record);
 * - `full` — an edit would take the store past its total, so it stays in
 *   memory and the disk keeps the document as it was.
 * Either way nothing on disk is lost, and the reader must hear that what they
 * just did is not saved (21.0).
 */
export type StoreProblem = "newer" | "full";

export interface StoreProblemReport {
  file: string;
  problem: StoreProblem;
}

const problems = new Set<string>();
const problemListeners = new Set<(report: StoreProblemReport) => void>();

/** Record that `file` held a write back. Reported once per file and kind. */
export function reportStoreProblem(file: string, problem: StoreProblem): void {
  const id = `${problem}:${file}`;
  if (problems.has(id)) return;
  problems.add(id);
  for (const listener of problemListeners) {
    try {
      listener({ file, problem });
    } catch {
      // A misbehaving subscriber must not break a flush.
    }
  }
}

/** Called for each store problem reported while subscribed. */
export function subscribeStoreProblem(
  listener: (report: StoreProblemReport) => void,
): () => void {
  problemListeners.add(listener);
  return () => {
    problemListeners.delete(listener);
  };
}

/** Forget a report — the file was read successfully after all. */
export function clearStoreUnreadable(file: string): void {
  unreadable.delete(file);
}

/** Every file currently reported unreadable, in report order. */
export function unreadableStores(): UnreadableStore[] {
  return [...unreadable.entries()].map(([file, message]) => ({ file, message }));
}

/** Called for each file that becomes unreadable while subscribed. */
export function subscribeStoreUnreadable(
  listener: (store: UnreadableStore) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam — drop every report and subscriber. */
export function __resetStoreHealthForTests(): void {
  unreadable.clear();
  listeners.clear();
  problems.clear();
  problemListeners.clear();
}
