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

export async function getRecentFiles(): Promise<RecentFile[]> {
  const s = await getStore();
  const list = await s.get<RecentFile[]>(KEY);
  return list ?? [];
}

export async function addRecentFile(entry: Omit<RecentFile, "openedAt">): Promise<RecentFile[]> {
  const s = await getStore();
  const existing = (await s.get<RecentFile[]>(KEY)) ?? [];
  const next: RecentFile = { ...entry, openedAt: Date.now() };
  const filtered = existing.filter((f) => f.path !== entry.path);
  const updated = [next, ...filtered].slice(0, MAX_RECENT);
  await s.set(KEY, updated);
  await s.save();
  return updated;
}

export async function removeRecentFile(path: string): Promise<RecentFile[]> {
  const s = await getStore();
  const existing = (await s.get<RecentFile[]>(KEY)) ?? [];
  const updated = existing.filter((f) => f.path !== path);
  await s.set(KEY, updated);
  await s.save();
  return updated;
}
