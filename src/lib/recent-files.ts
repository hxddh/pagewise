import { LazyStore } from "@tauri-apps/plugin-store";
import { isSupportedDocument } from "./load-document";

const STORE_PATH = "recent.json";
const KEY = "files";
const MAX_RECENT = 10;

export interface RecentFile {
  path: string;
  name: string;
  kind: "pdf" | "image";
  openedAt: number;
}

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) store = new LazyStore(STORE_PATH);
  return store;
}

/**
 * Serializes every store mutation through a single promise chain so concurrent
 * read-modify-write cycles (e.g. startup restore racing a user opening a file)
 * can't interleave and drop entries via last-write-wins.
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

/** Unlocked read — callers hold the lock (or accept a snapshot) themselves. */
async function readRecentFiles(): Promise<RecentFile[]> {
  const s = await getStore();
  return sanitizeRecentFiles(await s.get<unknown>(KEY));
}

function isValidRecentFile(value: unknown): value is RecentFile {
  if (!value || typeof value !== "object") return false;
  const f = value as Partial<RecentFile>;
  return (
    typeof f.path === "string" &&
    typeof f.name === "string" &&
    (f.kind === "pdf" || f.kind === "image") &&
    typeof f.openedAt === "number" &&
    Number.isFinite(f.openedAt)
  );
}

/** Drop malformed entries so corrupt stored data can't flow into the UI. */
function sanitizeRecentFiles(raw: unknown): RecentFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidRecentFile);
}

export async function getRecentFiles(): Promise<RecentFile[]> {
  return withStoreLock(readRecentFiles);
}

/** Recent entries the app can still open (PDF or supported image). */
export function isOpenableRecent(file: RecentFile): boolean {
  return isSupportedDocument(file.path);
}

export function openableRecentFiles(files: RecentFile[]): RecentFile[] {
  return files.filter(isOpenableRecent);
}

export async function addRecentFile(entry: Omit<RecentFile, "openedAt">): Promise<RecentFile[]> {
  return withStoreLock(async () => {
    const s = await getStore();
    const existing = await readRecentFiles();
    const next: RecentFile = { ...entry, openedAt: Date.now() };
    const filtered = existing.filter((f) => f.path !== entry.path);
    const updated = [next, ...filtered].slice(0, MAX_RECENT);
    await s.set(KEY, updated);
    await s.save();
    return updated;
  });
}

export async function removeRecentFiles(paths: string[]): Promise<RecentFile[]> {
  return withStoreLock(async () => {
    const existing = await readRecentFiles();
    if (paths.length === 0) return existing;
    const removeSet = new Set(paths);
    const s = await getStore();
    const updated = existing.filter((f) => !removeSet.has(f.path));
    await s.set(KEY, updated);
    await s.save();
    return updated;
  });
}

export async function removeRecentFile(path: string): Promise<RecentFile[]> {
  return withStoreLock(async () => {
    const s = await getStore();
    const existing = await readRecentFiles();
    const updated = existing.filter((f) => f.path !== path);
    await s.set(KEY, updated);
    await s.save();
    return updated;
  });
}
