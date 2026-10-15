import { invoke } from "@tauri-apps/api/core";
import { pickSavePath } from "./allowed-paths";

export async function saveMarkdownFile(
  content: string,
  defaultName: string,
  filterName = "Markdown",
): Promise<boolean> {
  return saveTextFile(content, defaultName, filterName, ["md"]);
}

/** Ask where to save text with these extensions, and write it there. */
export async function saveTextFile(
  content: string,
  defaultName: string,
  filterName: string,
  extensions: string[],
): Promise<boolean> {
  // The dialog runs in Rust, which grants one write to the file chosen
  // (21.1.0); the webview cannot grant a path itself.
  const path = await pickSavePath(defaultName, filterName, extensions);
  if (!path) return false;

  await invoke("write_text_file", { path, content });
  return true;
}
