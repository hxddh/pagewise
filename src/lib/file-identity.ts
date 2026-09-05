import { invokeCmd } from "./invoke-cmd";
import { isTauriRuntime } from "./runtime";

/**
 * What a file is, independent of where it is.
 *
 * Every store in PageWise keys the reader's work — marks, findings, the
 * chat — on the document's absolute path, because a path is what the app is
 * handed. The 11.0 review put the consequence in one line: rename the file and
 * "the record is gone", though nothing on disk was deleted. This is the second
 * key: a content fingerprint (head, tail and length — see `file_identity_cmd`)
 * that survives a rename, a move, and a copy to another folder, and changes
 * when the contents do.
 *
 * Returns `""` when no fingerprint can be obtained (browser dev runtime,
 * unreadable file). An empty identity never matches anything, so a document
 * without one is looked up by path alone, exactly as before 12.0.
 */
export async function fileIdentity(path: string): Promise<string> {
  if (!isTauriRuntime()) return "";
  try {
    const id = await invokeCmd<string>("file_identity_cmd", { path });
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}
