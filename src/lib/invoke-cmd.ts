import { invoke, type InvokeArgs } from "@tauri-apps/api/core";

/**
 * invoke() wrapper that normalizes rejections to `Error`.
 *
 * Tauri v2 rejects the invoke promise with the raw deserialized command error,
 * which for our `Result<_, String>` commands is a plain **string**, not an
 * `Error`. Call sites that do `err instanceof Error ? err.message : …` (cancel
 * detection, the document-load catch) would otherwise mis-handle every
 * Rust-side error — collapsing "Encrypted PDF requires a password", "File too
 * large", "PDF extract cancelled", etc. into an empty/unclassified value.
 * Routing file-touching commands through here guarantees callers always see an
 * `Error` whose `.message` is the real Rust cause.
 */
export async function invokeCmd<T>(cmd: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (e instanceof Error) throw e;
    throw new Error(typeof e === "string" ? e : String(e));
  }
}
