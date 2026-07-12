import { LazyStore } from "@tauri-apps/plugin-store";
import { invoke } from "@tauri-apps/api/core";

const STORE_PATH = "allowed-paths.json";
const KEY = "paths";
const MAX_PERSISTED = 64;

let store: LazyStore | null = null;

async function getStore(): Promise<LazyStore> {
  if (!store) store = new LazyStore(STORE_PATH);
  return store;
}

/**
 * Serializes every persisted-array mutation through a single promise chain so a
 * concurrent startup restore and a user allow/remove action can't interleave
 * their read-modify-write cycles and drop entries via last-write-wins.
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

async function registerWithBackend(path: string, strict: boolean): Promise<boolean> {
  try {
    await invoke("register_allowed_path", { path });
    return true;
  } catch {
    if (strict) throw new Error("path not authorized");
    return false;
  }
}

async function persistPath(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;

  return withStoreLock(async () => {
    const s = await getStore();
    const existing = (await s.get<string[]>(KEY)) ?? [];
    if (existing.includes(trimmed)) return;

    const updated = [...existing, trimmed].slice(-MAX_PERSISTED);
    await s.set(KEY, updated);
    await s.save();
  });
}

async function removePersistedPath(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;

  return withStoreLock(async () => {
    const s = await getStore();
    const existing = (await s.get<string[]>(KEY)) ?? [];
    if (!existing.includes(trimmed)) return;

    const updated = existing.filter((p) => p !== trimmed);
    await s.set(KEY, updated);
    await s.save();
  });
}

/**
 * Authorize exactly the given path with the Rust allowlist and persist it for
 * the next launch. Only the path passed in is authorized — opening a document
 * authorizes that file alone, never its parent directory. "Save as" flows that
 * need to create a new file explicitly authorize the chosen output directory
 * themselves (see saveMarkdownFile), so write access stays scoped to a folder
 * the user just picked rather than every folder they ever opened a file from.
 */
export async function allowPathPersisted(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;

  const ok = await registerWithBackend(trimmed, true);
  if (ok) await persistPath(trimmed);
}

export interface RestoreAllowedPathsResult {
  restored: number;
  failed: string[];
}

/** Re-register paths saved from previous sessions (and recent documents). */
export async function restoreAllowedPaths(
  extraPaths: string[] = [],
): Promise<RestoreAllowedPathsResult> {
  // Snapshot the persisted list under the lock; per-path removals below take the
  // lock individually so we never hold it across backend round-trips.
  const stored = await withStoreLock(async () => {
    const s = await getStore();
    return (await s.get<string[]>(KEY)) ?? [];
  });
  const seen = new Set<string>();
  const failed: string[] = [];
  let restored = 0;

  for (const path of [...stored, ...extraPaths]) {
    const trimmed = path.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);

    const ok = await registerWithBackend(trimmed, false);
    if (ok) {
      restored += 1;
    } else {
      failed.push(trimmed);
      await removePersistedPath(trimmed);
    }
  }

  return { restored, failed };
}
