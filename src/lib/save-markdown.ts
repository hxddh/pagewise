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
  // The dialog runs in Rust, which grants writing into the folder chosen
  // (21.0); the webview can no longer grant a folder itself.
  const path = await pickSavePath(defaultName, filterName, extensions);
  if (!path) return false;

  await invoke("write_text_file", { path, content });
  return true;
}
