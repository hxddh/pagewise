import { invokeCmd } from "./invoke-cmd";
import { classifyOpenError } from "./open-error";
import { isTauriRuntime } from "./runtime";

export interface PreflightInfo {
  kind: "pdf" | "image";
  stamp: string;
  identity: string;
}

/**
 * Single-IPC document preflight (27.0): sniffs kind, reads freshness stamp,
 * and hashes head/tail identity in one file open on the Rust side.
 *
 * Rethrows coded open errors (`tooLarge`, `unsupportedType`); returns `null`
 * outside Tauri or when individual commands are mocked in unit tests so
 * `loadDocument` falls back cleanly to `documentKind` + `fileStamp` + `fileIdentity`.
 */
export async function preflightDocument(path: string): Promise<PreflightInfo | null> {
  if (!isTauriRuntime()) return null;
  try {
    const info = await invokeCmd<PreflightInfo | null>("preflight_document_cmd", { path });
    if (
      info &&
      (info.kind === "pdf" || info.kind === "image") &&
      typeof info.stamp === "string" &&
      typeof info.identity === "string"
    ) {
      return info;
    }
    return null;
  } catch (err) {
    if (classifyOpenError(err)) throw err;
    return null;
  }
}
