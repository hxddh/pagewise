import { invokeCmd } from "./invoke-cmd";
import { isTauriRuntime } from "./runtime";

/**
 * Freshness key for a file (modification time + size), used to decide whether a
 * persisted page index still describes the file's current contents.
 *
 * Returns `""` when no stamp can be obtained (browser dev runtime, unreadable
 * metadata). Callers treat an empty stamp as "do not read or write the
 * persistent cache", so a file whose freshness can't be established is
 * re-indexed rather than served text extracted from older contents.
 */
export async function fileStamp(path: string): Promise<string> {
  if (!isTauriRuntime()) return "";
  try {
    const stamp = await invokeCmd<string>("file_stamp_cmd", { path });
    return typeof stamp === "string" ? stamp : "";
  } catch {
    return "";
  }
}
