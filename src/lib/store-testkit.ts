/**
 * The store layer's double for tests: files in a Map.
 *
 * `atomic-store.ts` reaches the disk through two IPC calls, so a test stands in
 * for the backend rather than for a store module — which is also what lets a
 * test seed a *corrupt* file and assert that nothing overwrites it, and count
 * the bytes a flush writes. The real Rust side is covered by its own tests.
 */
import type { StoreBackend } from "./atomic-store";
import { __setStoreBackendForTests } from "./atomic-store";

export interface MemoryStoreBackend extends StoreBackend {
  /** The raw text of every file, as the disk would hold it. */
  files: Map<string, string>;
  /** Every write, in order, with the bytes it put on disk. */
  writes: { name: string; bytes: number }[];
  /** Total bytes written, the number a write-amplification test asserts on. */
  bytesWritten(): number;
  /** Write a file's contents (a JSON value, or raw text for a corrupt file). */
  seed(name: string, value: unknown): void;
  /** The file's parsed contents, or null when it does not exist. */
  peek<T>(name: string): T | null;
  /** Make the next write fail, as a full disk would. */
  failNextWrite(error?: Error): void;
  /** Make every write fail, as a full disk would. */
  failWrites(error?: Error): void;
  /** Let writes succeed again. */
  allowWrites(): void;
  /** Forget every file, write and failure. */
  reset(): void;
}

export function createMemoryStoreBackend(): MemoryStoreBackend {
  const files = new Map<string, string>();
  const writes: { name: string; bytes: number }[] = [];
  let failure: Error | null = null;
  let failures = 0;
  let nextFailure: Error | null = null;

  const backend: MemoryStoreBackend = {
    files,
    writes,
    bytesWritten: () => writes.reduce((total, w) => total + w.bytes, 0),
    async read(name: string) {
      return files.get(name) ?? null;
    },
    async write(name: string, contents: string) {
      if (failure || failures > 0) {
        if (failures > 0) failures -= 1;
        throw failure ?? nextFailure ?? new Error("disk full");
      }
      files.set(name, contents);
      writes.push({ name, bytes: contents.length });
    },
    async list(dir: string) {
      return [...files.keys()].filter((name) => name.startsWith(`${dir}/`)).sort();
    },
    async remove(names: string[]) {
      for (const name of names) files.delete(name);
    },
    seed(name: string, value: unknown) {
      files.set(name, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
    },
    peek<T>(name: string) {
      const raw = files.get(name);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    failNextWrite(error = new Error("disk full")) {
      failures += 1;
      nextFailure = error;
    },
    failWrites(error = new Error("disk full")) {
      failure = error;
    },
    allowWrites() {
      failure = null;
      failures = 0;
    },
    reset() {
      files.clear();
      writes.length = 0;
      failure = null;
      failures = 0;
      nextFailure = null;
      // A fresh disk is a fresh session: every store re-reads it (see
      // `__setStoreBackendForTests`).
      __setStoreBackendForTests(backend);
    },
  };
  return backend;
}

/** Install a fresh in-memory backend as the store layer's disk. */
export function useMemoryStoreBackend(): MemoryStoreBackend {
  const backend = createMemoryStoreBackend();
  __setStoreBackendForTests(backend);
  return backend;
}

/**
 * One key of one store file.
 *
 * A store file is a JSON object of keys, and most tests speak about exactly one
 * of them — the blob the store reads and writes. This is that key, so a test can
 * seed and inspect it without repeating the file's shape.
 */
export function storeKey(
  backend: MemoryStoreBackend,
  file: string,
  key: string,
): { seed(value: unknown): void; peek<T = unknown>(): T | undefined } {
  return {
    seed(value) {
      backend.seed(file, { [key]: value });
    },
    peek<T = unknown>() {
      return backend.peek<Record<string, T>>(file)?.[key];
    },
  };
}

/**
 * One store file, as the map of keys it holds.
 *
 * For the stores that keep several keys in one file (the chats keep one per
 * document), where a test wants to seed or inspect the file the way the old
 * plugin's `keys()`/`get()` did.
 */
export function storeFile(
  backend: MemoryStoreBackend,
  file: string,
): {
  keys(): string[];
  has(key: string): boolean;
  size(): number;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  write(entries: Record<string, unknown>): void;
  clear(): void;
} {
  const read = () => backend.peek<Record<string, unknown>>(file) ?? {};
  // Writing the file from a test is another process having written it: the
  // stores re-read on their next call (see `__setStoreBackendForTests`).
  const commit = (entries: Record<string, unknown>) => {
    backend.seed(file, entries);
    __setStoreBackendForTests(backend);
  };
  return {
    keys: () => Object.keys(read()),
    has: (key) => key in read(),
    size: () => Object.keys(read()).length,
    get: <T = unknown>(key: string) => read()[key] as T | undefined,
    set: (key, value) => commit({ ...read(), [key]: value }),
    write: commit,
    clear: () => commit({}),
  };
}

/** Go back to the real Tauri commands. */
export function uninstallStoreBackend(): void {
  __setStoreBackendForTests(null);
}
