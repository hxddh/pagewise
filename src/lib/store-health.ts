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
}
