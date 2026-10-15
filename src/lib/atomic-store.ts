/**
 * The store file layer: one JSON object, written whole, atomically.
 *
 * Six stores and the preferences used to go through `tauri-plugin-store`, whose
 * `save()` is `create_dir_all` + pretty JSON + `fs::write` and whose load error
 * is swallowed (`let _ = store_inner.load()` in its `build_inner`). The 20.0
 * review measured what that costs:
 *
 *   - a torn write — a crash in the middle of `fs::write` — reads back as an
 *     *empty* store, and the next save writes that emptiness over the reader's
 *     file. Marks, findings and chats are the reader's own work;
 *   - a store that failed to load could not be told apart from one that is
 *     empty, so nothing could refuse to overwrite it.
 *
 * This is the replacement, and it keeps the shape the stores already rely on
 * (load once, mutate in memory, write on `save`) while changing three things:
 *
 *   - `save()` goes through the `store_write_cmd` Rust command, which writes a
 *     sibling temp file, fsyncs it, renames it over the target and fsyncs the
 *     directory — so a reader either has the previous copy or the new one,
 *     never half of either;
 *   - a file that exists and cannot be parsed raises `StoreUnreadableError` on
 *     every read *and every write*, so the bytes on disk are never replaced;
 *   - the file name is one path component the Rust side resolves under the app
 *     data directory, so the webview cannot name another path. The plugin's
 *     `load` took a full path and `PathBuf::push` replaces the base directory
 *     when the argument is absolute (`tauri-2.12.3/src/path/mod.rs`), which is
 *     why `store:default` was the widest line in the capability file.
 *
 * The on-disk format is unchanged: a pretty-printed JSON object, one member per
 * key, exactly what the plugin wrote. Existing files load; nothing is migrated.
 */
import { invoke } from "@tauri-apps/api/core";
import { clearStoreUnreadable, reportStoreUnreadable } from "./store-health";

/** The subset of `LazyStore` the stores here use, and all of it they may. */
export interface StoreHandle {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;
  keys(): Promise<string[]>;
  save(): Promise<void>;
}

/**
 * A store file that exists but cannot be read. Thrown by every operation on
 * that file, including `save()`, until it can be read again: overwriting a file
 * this app could not parse is how a torn write turns into data loss.
 */
export class StoreUnreadableError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${file} could not be read (${detail}) — it was left untouched`);
    this.name = "StoreUnreadableError";
    this.file = file;
  }
}

/**
 * Where the bytes come from and go. Two calls, because there are two facts to
 * get right: a read that can say "unreadable" rather than "empty", and a write
 * that cannot leave half a file behind.
 */
export interface StoreBackend {
  /** The file's text, or null when it does not exist. Throws when unreadable. */
  read(name: string): Promise<string | null>;
  /** Replace the file's text atomically. */
  write(name: string, contents: string): Promise<void>;
  /**
   * The store file names inside a side directory, and the removal of named
   * files. Part of the backend because they are the same question the other two
   * answer — what is on this disk — and a test standing in for the disk has to
   * answer them too.
   */
  list(dir: string): Promise<string[]>;
  remove(names: string[]): Promise<void>;
}

const tauriBackend: StoreBackend = {
  read: (name) => invoke<string | null>("store_read_cmd", { name }),
  write: (name, contents) => invoke("store_write_cmd", { name, contents }),
  list: (dir) => invoke<string[]>("store_list_cmd", { dir }),
  remove: (names) => invoke("store_delete_cmd", { names }),
};

/**
 * The backend tests install, held on `globalThis` rather than in a module
 * variable: several suites call `vi.resetModules()` and re-import the stores,
 * which re-creates this module, and a module-level seam would be lost with it.
 * Production never sets this.
 */
const TEST_BACKEND = "__pagewiseStoreBackend";

function backend(): StoreBackend {
  const injected = (globalThis as Record<string, unknown>)[TEST_BACKEND];
  return (injected as StoreBackend | undefined) ?? tauriBackend;
}

/**
 * Bumped whenever a test installs a backend. A handle loaded under an older
 * generation re-reads: installing a backend means "this is a new disk, as after
 * a restart", which is what a test seeding a file expects to be read. In
 * production nothing bumps it and every handle loads once, as before.
 */
let generation = 0;

/** Test seam: install an in-memory backend (see `store-testkit.ts`), or null. */
export function __setStoreBackendForTests(next: StoreBackend | null): void {
  const g = globalThis as Record<string, unknown>;
  if (next) g[TEST_BACKEND] = next;
  else delete g[TEST_BACKEND];
  generation += 1;
}

/** The text of a store file, or null when there is none. */
export function readStoreFile(name: string): Promise<string | null> {
  return backend().read(name);
}

/** Replace a store file's text, atomically. */
export function writeStoreFile(name: string, contents: string): Promise<void> {
  return backend().write(name, contents);
}

/** The store area's one side directory: one file per kept answer. */
export const BODIES_DIR = "finding-bodies";

/** The side file name a finding's body is kept in. */
export function bodyFileName(id: string): string {
  return `${BODIES_DIR}/${id}.json`;
}

/** The store file names inside a side directory. */
export function listStoreDir(dir: string): Promise<string[]> {
  return backend().list(dir);
}

/** Delete store files by name. Missing ones are not an error. */
export function deleteStoreFiles(names: string[]): Promise<void> {
  return backend().remove(names);
}

/** One store file, loaded at most once and written whole. */
export function createAtomicStore(file: string): StoreHandle {
  /** The parsed file, or null while it has not been read (or could not be). */
  let contents: Map<string, unknown> | null = null;
  /** The generation `contents` was read under — see `__setStoreBackendForTests`. */
  let loadedAt = -1;
  /** The read in flight. Shared, so two first calls cannot both load. */
  let loading: Promise<Map<string, unknown>> | null = null;
  /** Bumped by every mutation; `written` is the revision last saved. */
  let revision = 0;
  let written = 0;
  /** Saves queue behind each other: two writes must not interleave. */
  let writes: Promise<void> = Promise.resolve();

  async function read(): Promise<Map<string, unknown>> {
    const raw = await readStoreFile(file);
    if (raw === null || raw === undefined) {
      clearStoreUnreadable(file);
      return new Map();
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw unreadable(err);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw unreadable(new Error("not a JSON object"));
    }
    clearStoreUnreadable(file);
    return new Map(Object.entries(parsed as Record<string, unknown>));
  }

  function unreadable(cause: unknown): StoreUnreadableError {
    const error = new StoreUnreadableError(file, cause);
    // The app has to be able to say which file it could not read — a store that
    // silently reads as empty is the failure this layer exists to end.
    reportStoreUnreadable(file, error.message);
    return error;
  }

  function loaded(): Promise<Map<string, unknown>> {
    if (contents && loadedAt === generation) return Promise.resolve(contents);
    if (!loading) {
      const at = generation;
      loading = read().then(
        (map) => {
          loading = null;
          if (at === generation) {
            contents = map;
            loadedAt = at;
          }
          return map;
        },
        (err) => {
          // Not remembered as broken: a file that was moved back into place is
          // read again on the next call.
          loading = null;
          throw err;
        },
      );
    }
    return loading;
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const map = await loaded();
      return map.get(key) as T | undefined;
    },

    async set(key: string, value: unknown): Promise<void> {
      const map = await loaded();
      map.set(key, value);
      revision += 1;
    },

    async delete(key: string): Promise<boolean> {
      const map = await loaded();
      const had = map.delete(key);
      if (had) revision += 1;
      return had;
    },

    async has(key: string): Promise<boolean> {
      const map = await loaded();
      return map.has(key);
    },

    async keys(): Promise<string[]> {
      const map = await loaded();
      return [...map.keys()];
    },

    async save(): Promise<void> {
      // `loaded()` first, always: a file this app could not read is never
      // replaced by what it would have written instead.
      const map = await loaded();
      const at = revision;
      if (at === written) return;
      const text = `${JSON.stringify(Object.fromEntries(map), null, 2)}\n`;
      const run = writes.then(() => writeStoreFile(file, text));
      writes = run.then(
        () => undefined,
        () => undefined,
      );
      await run;
      written = Math.max(written, at);
    },
  };
}
