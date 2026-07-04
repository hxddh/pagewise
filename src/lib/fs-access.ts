import { allowPathPersisted } from "./allowed-paths";

/**
 * Authorize a single absolute path with the Rust backend's path allowlist.
 *
 * Every file-touching Tauri command (extract_pdf_text_cmd, read_file_bytes,
 * write_text_file, ocr_image) enforces this allowlist, so a path must be
 * registered here before those commands will operate on it. For "save as"
 * flows, registering the parent directory authorizes new files created inside
 * it (see write_text_file in the Rust backend).
 */
export async function allowPath(path: string): Promise<void> {
  await allowPathPersisted(path);
}

/**
 * Authorize several paths at once. Rejects if any single registration fails.
 */
export async function allowPaths(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => allowPath(path)));
}
