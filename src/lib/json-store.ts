/**
 * The parts every JSON-backed store in the app repeats.
 *
 * Six stores — allowed paths, recent files, the page index, marks, findings,
 * chats — and the preferences are each one file with one key, opened lazily,
 * and each serialises its mutations through its own promise chain: two
 * read-modify-write cycles that interleave lose one of them to last-write-wins.
 * Written per store, the lock alone was six byte-identical copies and a renamed
 * seventh, and every one of them had to be got right on its own. The stores that
 * are edited in bursts repeat more: a dirty set, a debounced flush, a retry that
 * keeps unsaved work until a write lands, and a reset hook for tests.
 *
 * This module owns those parts. What stays in a store is what actually differs:
 * its schema, its validation and merge rules for a document's entries, and the
 * queries over them.
 *
 * The handle these runtimes open is `atomic-store.ts`'s, not the store plugin's:
 * one file, written whole through a temp file and a rename, with a file that
 * cannot be read refused rather than read as empty. See that module for what the
 * plugin's `save()` and swallowed load error cost.
 */
import type { StoreHandle } from "./atomic-store";
import { reportStoreProblem } from "./store-health";
import { migrateStored, preserveNewer, type Migration } from "./store-migrate";

export interface StoreRuntime<Handle> {
  /** The handle for this store's file, opened on first use. */
  store(): Promise<Handle>;
  /** Run a mutation after every one queued before it has settled. */
  withStoreLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Drop the handle so the next use opens again — tests only. */
  resetStore(): void;
  /** Drop the lock's queue — tests only. */
  resetLock(): void;
}

/**
 * The store handle and the write lock for one file.
 *
 * `open` runs on first use, and again after it fails: a store that could not be
 * opened must not be remembered as broken for the rest of the session. Nothing
 * is created before a caller asks for it, so a module that is imported but
 * never used touches no disk.
 *
 * The lock is a promise chain, not a flag: every mutation is queued behind the
 * one before it and inherits its failure, so a caller that rejects cannot strand
 * the queue. `fn` is also passed as the rejection handler, which is what keeps
 * the chain running after a failed write.
 *
 * One runtime per file, never shared across files: two stores have no reason to
 * wait for each other, and their writes go to different files anyway.
 */
export function createStoreRuntime<Handle>(open: () => Handle | Promise<Handle>): StoreRuntime<Handle> {
  let handle: Promise<Handle> | null = null;
  let lockTail: Promise<unknown> = Promise.resolve();
  return {
    store() {
      if (!handle) {
        // Opened through an async call, so a synchronous throw is a rejected
        // promise like any other failed open, and the next call retries.
        handle = (async () => open())().catch((err) => {
          handle = null;
          throw err;
        });
      }
      return handle;
    },
    withStoreLock(fn) {
      const result = lockTail.then(fn, fn);
      lockTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    resetStore() {
      handle = null;
    },
    resetLock() {
      lockTail = Promise.resolve();
    },
  };
}

/**
 * Subscribers to a store's per-document changes.
 *
 * `notify` swallows what a subscriber throws: a misbehaving one is a bug in a
 * view, and a store update is not the place to surface it.
 */
export interface PathListeners {
  subscribe(listener: (path: string) => void): () => void;
  notify(path: string): void;
  clear(): void;
}

export function createPathListeners(): PathListeners {
  const listeners = new Set<(path: string) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    notify(path) {
      for (const listener of listeners) {
        try {
          listener(path);
        } catch {
          // A misbehaving subscriber must not break the update.
        }
      }
    },
    clear() {
      listeners.clear();
    },
  };
}

export interface DocumentStoreOptions<Doc, Entry> {
  /** The store's file name, as the reader is told it when a write is held back. */
  file: string;
  /** Key inside the store's file. */
  key: string;
  /** Current schema version, and how older blobs reach it. */
  version: number;
  migrations: readonly Migration[];
  /** Coalesce a burst of edits into one write. */
  flushDelayMs: number;
  /** Entries kept for one document, and in total across the store. */
  maxPerDoc: number;
  maxTotal: number;
  /** The entries a stored document holds. */
  entriesOf(doc: Doc): Entry[];
  /** A stored document holding exactly `entries`, and the fingerprint with them. */
  build(path: string, entries: Entry[], identity?: string): Doc;
  /** Coerce arbitrary stored data into documents; corrupt input reads as none. */
  sanitize(raw: unknown): Doc[];
  /**
   * The part of a document that lives *beside* the index instead of inside it —
   * the findings store's bodies since 20.0.
   *
   * `externalize` is called with the documents a flush is about to write,
   * before the index is written: it persists whatever belongs in the side
   * files and returns the documents as the index should hold them. Writing the
   * side first is what makes a crash between the two harmless — an orphan body,
   * never a reference to nothing. `prune` then drops the side files no kept
   * document mentions any more.
   */
  sidecar?: {
    externalize(docs: Doc[]): Promise<Doc[]>;
    prune(docs: Doc[]): Promise<void>;
  };
}

export interface DocumentStore<Doc, Entry> {
  /** Everything stored, migrated and validated; read under the lock. */
  documents(): Promise<Doc[]>;
  /** The entries held in memory for `path`, or null if it is not open. */
  cached(path: string): Entry[] | null;
  /**
   * Called when a document opens: its unsaved entries when it has any, else
   * null. Reopening also cancels a forget that has not been written yet —
   * those edits are newer than anything the store holds.
   */
  reopen(path: string): Entry[] | null;
  /** Remember the fingerprint the open document was loaded with, to write back. */
  identify(path: string, identity?: string): void;
  /** The stored document for `path`, re-keyed when its fingerprint moved it. */
  locate(path: string, identity?: string): Promise<Doc | null>;
  /** Hold entries in memory for a path; nothing is queued for the store. */
  cache(path: string, entries: Entry[]): void;
  /** Replace an open document's entries in memory and queue the write. */
  replace(path: string, entries: Entry[]): void;
  /** Forget a closed document now, or after the write of its edits lands. */
  forget(path: string): void;
  /** Write everything queued now (document close, app quit, before stats). */
  flush(): Promise<void>;
  /** Test seam — drop all in-memory state and the store handle. */
  reset(): void;
}

/**
 * The dirty-set-and-flush half of a per-document store.
 *
 * A document's entries are edited in memory and written back as a whole, so
 * every store that works this way asks the same questions: which documents have
 * edits the file does not have yet, when to write them, and what a closed
 * document's copy is worth while its write has not landed. The answers are the
 * same for marks and findings because the risk is the same — the entries are
 * the reader's own work, and nothing may be dropped on the way to disk.
 *
 * `locate` carries the merge the two stores also share: a document stored under
 * another path whose fingerprint matches is the same file renamed, and it is
 * re-keyed rather than duplicated. The old entry is emptied in memory and both
 * paths are marked dirty, so the next flush writes the file where it is now and
 * drops the entry where it was.
 */
export function createDocumentStore<Doc extends { path: string; identity?: string }, Entry>(
  runtime: StoreRuntime<StoreHandle>,
  options: DocumentStoreOptions<Doc, Entry>,
): DocumentStore<Doc, Entry> {
  const {
    file,
    key,
    version,
    migrations,
    flushDelayMs,
    maxPerDoc,
    maxTotal,
    entriesOf,
    build,
    sanitize,
    sidecar,
  } = options;

  /** Entries held in memory for open documents, and their fingerprints. */
  const byPath = new Map<string, Entry[]>();
  const identityByPath = new Map<string, string>();
  /** Paths with edits the store does not have yet. */
  const dirty = new Set<string>();
  /** Closed documents whose unsaved copy must outlive a failed write (B6). */
  const forgetAfterFlush = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushInFlight: Promise<void> = Promise.resolve();

  /**
   * Documents as stored, and whether a later PageWise wrote them.
   *
   * A later version's record is read as empty and kept aside, and this build
   * must then never write the store: a flush would replace the record with the
   * documents open in memory, and the sidecar's prune would delete the bodies of
   * every other document — the reader's text, gone, on a downgrade (21.0).
   */
  async function readStored(): Promise<{ docs: Doc[]; newer: boolean }> {
    const s = await runtime.store();
    const raw = await s.get<unknown>(key);
    const outcome = migrateStored(raw, version, migrations);
    if (outcome.status === "newer") {
      await preserveNewer(s, key, raw).catch(() => {});
      return { docs: [], newer: true };
    }
    return { docs: sanitize(raw), newer: false };
  }

  async function readDocs(): Promise<Doc[]> {
    return (await readStored()).docs;
  }

  async function writeDocs(docs: Doc[]): Promise<void> {
    const s = await runtime.store();
    await s.set(key, { version, docs });
    await s.save();
  }

  function forgetNow(path: string): void {
    if (!forgetAfterFlush.delete(path)) return;
    byPath.delete(path);
    identityByPath.delete(path);
  }

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void store.flush();
    }, flushDelayMs);
  }

  const store: DocumentStore<Doc, Entry> = {
    documents: () => runtime.withStoreLock(readDocs),

    cached: (path) => byPath.get(path) ?? null,

    reopen(path) {
      forgetAfterFlush.delete(path);
      if (dirty.has(path) && byPath.has(path)) return byPath.get(path)!;
      return null;
    },

    identify(path, identity) {
      if (identity) identityByPath.set(path, identity);
      else identityByPath.delete(path);
    },

    async locate(path, identity) {
      return runtime.withStoreLock(async () => {
        const docs = await readDocs();
        const found = docs.find((d) => d.path === path);
        if (found) return found;
        if (!identity) return null;
        const moved = docs.find((d) => d.identity === identity);
        if (!moved) return null;
        byPath.set(moved.path, []);
        dirty.add(moved.path);
        dirty.add(path);
        scheduleFlush();
        return moved;
      });
    },

    cache(path, entries) {
      byPath.set(path, entries);
    },

    replace(path, entries) {
      byPath.set(path, entries);
      dirty.add(path);
      scheduleFlush();
    },

    forget(path) {
      forgetAfterFlush.add(path);
      if (!dirty.has(path)) forgetNow(path);
    },

    async flush() {
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
      flushInFlight = runtime
        .withStoreLock(async () => {
          const { docs, newer } = await readStored();
          if (newer) {
            // Held back, not dropped: the edits stay in memory and dirty, and
            // the reader is told why they will not reach the disk.
            reportStoreProblem(file, "newer");
            throw new Error(`${file} was written by a later PageWise`);
          }
          const before = new Map(docs.map((d) => [d.path, d] as const));
          const stored = new Map(before);
          for (const path of paths) {
            // Not in memory: nothing here to write, and an empty list would read
            // as "the reader removed them all" (16.0).
            if (!byPath.has(path)) continue;
            const entries = byPath.get(path)!;
            if (entries.length === 0) stored.delete(path);
            else {
              const identity = identityByPath.get(path) ?? stored.get(path)?.identity;
              stored.set(path, build(path, entries.slice(0, maxPerDoc), identity));
            }
          }
          // The total cap. A document this flush did not touch is on disk
          // already and keeps its place whatever the count: until 21.0 the cap
          // skipped whole documents in file order, so one edit near the total
          // could make another document's record vanish (and its bodies be
          // pruned) while the screen still showed it. Now only an edited
          // document can be refused, it falls back to what the disk had, its
          // edit stays in memory for when there is room, and the reader is told.
          const touched = new Set(paths);
          let total = 0;
          for (const doc of stored.values()) if (!touched.has(doc.path)) total += entriesOf(doc).length;
          const refused: string[] = [];
          for (const path of paths) {
            const doc = stored.get(path);
            if (!doc) continue;
            const n = entriesOf(doc).length;
            if (total + n <= maxTotal) {
              total += n;
              continue;
            }
            refused.push(path);
            const previous = before.get(path);
            if (previous) {
              stored.set(path, previous);
              total += entriesOf(previous).length;
            } else stored.delete(path);
          }
          const kept = [...stored.values()];
          // The side files first: a crash between the two writes leaves a body
          // nothing refers to (pruned later), never a finding that refers to a
          // body that is not there.
          const index = sidecar ? await sidecar.externalize(kept) : kept;
          await writeDocs(index);
          // Dropping a body whose finding is gone is housekeeping: a failure
          // costs a file, never the reader's record.
          if (sidecar) await sidecar.prune(kept).catch(() => {});
          if (refused.length > 0) {
            for (const path of refused) dirty.add(path);
            reportStoreProblem(file, "full");
          }
          for (const path of paths) if (!dirty.has(path)) forgetNow(path);
        })
        .catch(() => {
          // A failed write must not lose the entries — they stay in memory and
          // in `dirty` for the next attempt.
          for (const path of paths) dirty.add(path);
        });
      await flushInFlight;
    },

    reset() {
      forgetAfterFlush.clear();
      byPath.clear();
      identityByPath.clear();
      dirty.clear();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      runtime.resetStore();
    },
  };

  return store;
}
