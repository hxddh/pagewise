import { invoke } from "@tauri-apps/api/core";
import { pickSavePath } from "./allowed-paths";

export async function saveMarkdownFile(
  content: string,
  defaultName: string,
  filterName = "Markdown",
): Promise<boolean> {
  return (await saveMarkdownFileWithPath(content, defaultName, filterName)) !== null;
}

export async function saveMarkdownFileWithPath(
  content: string,
  defaultName: string,
  filterName = "Markdown",
): Promise<string | null> {
  return saveTextFileWithPath(content, defaultName, filterName, ["md"]);
}

export async function saveTextFile(
  content: string,
  defaultName: string,
  filterName: string,
  extensions: string[],
): Promise<boolean> {
  return (await saveTextFileWithPath(content, defaultName, filterName, extensions)) !== null;
}

export async function saveTextFileWithPath(
  content: string,
  defaultName: string,
  filterName: string,
  extensions: string[],
): Promise<string | null> {
  const path = await pickSavePath(defaultName, filterName, extensions);
  if (!path) return null;

  await invoke("write_text_file", { path, content });
  return path;
}
