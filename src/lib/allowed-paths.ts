import { invoke } from "@tauri-apps/api/core";

/**
 * What the Rust side has granted, and the two dialogs that grant (21.0).
 *
 * Until 21.0 this module granted: it called `register_allowed_path` with any
 * path it was handed and kept the list in `allowed-paths.json`, a store the
 * webview itself writes, re-granting all of it at every launch. So the
 * allowlist protected nothing from a script in the webview — it could grant
 * itself any file and read it, or any folder and write into it.
 *
 * Now nothing here grants. A path is granted in Rust by what the reader did
 * outside the webview — the open dialog, the save dialog, a drop on the
 * window, a file the app was launched with — and Rust keeps its own list of
 * the documents granted in earlier sessions (`src-tauri/src/grants.rs`). This
 * module only opens the dialogs and asks whether a path is granted.
 */

function message(e: unknown, fallback: string): string {
  // Tauri rejects with a plain string; keep the real Rust cause (a moved file
  // fails canonicalize with "No such file", which is not an authorization
  // refusal and should not read as one).
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return raw || fallback;
}

/** Whether a document may be opened. False for a path that no longer exists. */
export async function isPathGranted(path: string): Promise<boolean> {
  const trimmed = path.trim();
  if (!trimmed) return false;
  try {
    return await invoke<boolean>("path_granted", { path: trimmed });
  } catch {
    return false;
  }
}

/**
 * Throw unless `path` was granted. Every file-touching command enforces the
 * allowlist itself; this asks first so the reader gets a clear refusal
 * instead of a read error halfway through opening a document.
 */
export async function requireGrantedPath(path: string): Promise<void> {
  if (!(await isPathGranted(path))) throw new Error("path not authorized");
}

/** The open dialog. Resolves to the granted document, or null on cancel. */
export async function pickDocument(): Promise<string | null> {
  try {
    return (await invoke<string | null>("pick_document")) ?? null;
  } catch (e) {
    throw new Error(message(e, "path not authorized"));
  }
}

/**
 * The save dialog. Resolves to the chosen path, or null on cancel; writing
 * into the chosen folder is granted for the rest of this session.
 */
export async function pickSavePath(
  defaultName: string,
  filterName: string,
  extensions: string[],
): Promise<string | null> {
  try {
    return (
      (await invoke<string | null>("pick_save_path", { defaultName, filterName, extensions })) ?? null
    );
  } catch (e) {
    throw new Error(message(e, "path not authorized"));
  }
}

/** Of these paths, the ones no longer granted (moved, deleted, never granted). */
export async function ungrantedPaths(paths: readonly string[]): Promise<string[]> {
  const unique = [...new Set(paths.map((p) => p.trim()).filter(Boolean))];
  const granted = await Promise.all(unique.map(isPathGranted));
  return unique.filter((_, i) => !granted[i]);
}
