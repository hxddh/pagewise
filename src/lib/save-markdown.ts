import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { allowPath } from "./fs-access";

export async function saveMarkdownFile(
  content: string,
  defaultName: string,
  filterName = "Markdown",
): Promise<boolean> {
  const path = await save({
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: ["md"] }],
  });

  if (!path) return false;

  // The chosen file may not exist yet; authorize its parent directory so the
  // backend allowlist permits the write (canonicalizing a new file would fail).
  const parent = path.replace(/[/\\][^/\\]*$/, "");
  if (parent && parent !== path) {
    await allowPath(parent);
  }

  await invoke("write_text_file", { path, content });
  return true;
}
