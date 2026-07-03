import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

export async function saveMarkdownFile(
  content: string,
  defaultName: string,
): Promise<boolean> {
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });

  if (!path) return false;

  await invoke("write_text_file", { path, content });
  return true;
}
