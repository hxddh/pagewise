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
  /**
   * Where the reader was, and what they had. All optional — entries written
   * before 12.0 have none — and all best-effort: the row in the library reads
   * "page 37 of 120 · 6 in the record · 2 to re-check" from these, and the
   * document reopens at `lastPage` instead of at 1.
   */
  lastPage?: number;
  totalPages?: number;
  findingCount?: number;
  /** Findings the reader has been asked to re-check — see `finding-trust.ts`. */
  openCount?: number;
}

export type RecentProgress = Pick<
  RecentFile,
  "lastPage" | "totalPages" | "findingCount" | "openCount"
>;

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

const PROGRESS_KEYS = ["lastPage", "totalPages", "findingCount", "openCount"] as const;

/** A whole positive count, or nothing. A corrupt progress field costs the field, not the row. */
function wholeOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
}

function sanitizeProgress(f: RecentFile): RecentFile {
  const out: RecentFile = { path: f.path, name: f.name, kind: f.kind, openedAt: f.openedAt };
  for (const k of PROGRESS_KEYS) {
    const v = wholeOrUndefined((f as unknown as Record<string, unknown>)[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Drop malformed entries so corrupt stored data can't flow into the UI. */
function sanitizeRecentFiles(raw: unknown): RecentFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isValidRecentFile).map(sanitizeProgress);
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
    const previous = existing.find((f) => f.path === entry.path);
    // Reopening keeps the progress the last visit left, unless the caller
    // says otherwise: "where was I" is the reason the entry exists.
    const next: RecentFile = { ...(previous ?? {}), ...entry, openedAt: Date.now() };
    const filtered = existing.filter((f) => f.path !== entry.path);
    const updated = [next, ...filtered].slice(0, MAX_RECENT);
    await s.set(KEY, updated);
    await s.save();
    return updated;
  });
}

/**
 * Where the reader is in a document, and what they have. Merged into the
 * existing entry; a document not in the list is not added by this — it is
 * progress on something, not a visit.
 */
export async function updateRecentProgress(
  path: string,
  progress: RecentProgress,
): Promise<RecentFile[]> {
  return withStoreLock(async () => {
    const existing = await readRecentFiles();
    const index = existing.findIndex((f) => f.path === path);
    if (index < 0) return existing;
    const current = existing[index]!;
    const merged = sanitizeProgress({ ...current, ...progress });
    let same = true;
    for (const k of PROGRESS_KEYS) if (merged[k] !== current[k]) same = false;
    if (same) return existing;
    const updated = existing.slice();
    updated[index] = merged;
    const s = await getStore();
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
