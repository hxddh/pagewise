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

function parentPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  if (idx < 0) return null;
  if (idx === 0) return "/";
  return path.slice(0, path.length - (normalized.length - idx));
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

  const s = await getStore();
  const existing = (await s.get<string[]>(KEY)) ?? [];
  if (existing.includes(trimmed)) return;

  const updated = [...existing, trimmed].slice(-MAX_PERSISTED);
  await s.set(KEY, updated);
  await s.save();
}

async function removePersistedPath(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;

  const s = await getStore();
  const existing = (await s.get<string[]>(KEY)) ?? [];
  if (!existing.includes(trimmed)) return;

  const updated = existing.filter((p) => p !== trimmed);
  await s.set(KEY, updated);
  await s.save();
}

/** Authorize a path with the Rust allowlist and persist it for the next launch. */
export async function allowPathPersisted(path: string): Promise<void> {
  const trimmed = path.trim();
  if (!trimmed) return;

  const ok = await registerWithBackend(trimmed, true);
  if (ok) await persistPath(trimmed);

  const parent = parentPath(trimmed);
  if (parent) {
    const parentOk = await registerWithBackend(parent, false);
    if (parentOk) await persistPath(parent);
  }
}

export interface RestoreAllowedPathsResult {
  restored: number;
  failed: string[];
}

/** Re-register paths saved from previous sessions (and recent documents). */
export async function restoreAllowedPaths(
  extraPaths: string[] = [],
): Promise<RestoreAllowedPathsResult> {
  const s = await getStore();
  const stored = (await s.get<string[]>(KEY)) ?? [];
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

    const parent = parentPath(trimmed);
    if (parent && !seen.has(parent)) {
      seen.add(parent);
      const parentOk = await registerWithBackend(parent, false);
      if (parentOk) {
        restored += 1;
      } else {
        failed.push(parent);
        await removePersistedPath(parent);
      }
    }
  }

  return { restored, failed };
}
