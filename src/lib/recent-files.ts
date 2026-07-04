import { LazyStore } from "@tauri-apps/plugin-store";

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
  const s = await getStore();
  const list = await s.get<unknown>(KEY);
  return sanitizeRecentFiles(list);
}

export async function addRecentFile(entry: Omit<RecentFile, "openedAt">): Promise<RecentFile[]> {
  const s = await getStore();
  const existing = sanitizeRecentFiles(await s.get<unknown>(KEY));
  const next: RecentFile = { ...entry, openedAt: Date.now() };
  const filtered = existing.filter((f) => f.path !== entry.path);
  const updated = [next, ...filtered].slice(0, MAX_RECENT);
  await s.set(KEY, updated);
  await s.save();
  return updated;
}

export async function removeRecentFile(path: string): Promise<RecentFile[]> {
  const s = await getStore();
  const existing = sanitizeRecentFiles(await s.get<unknown>(KEY));
  const updated = existing.filter((f) => f.path !== path);
  await s.set(KEY, updated);
  await s.save();
  return updated;
}
