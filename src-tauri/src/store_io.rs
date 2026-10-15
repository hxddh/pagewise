//! This app's own store files: read, write, and the bodies kept beside the
//! findings.
//!
//! Every JSON store the frontend keeps lives in one file under the app data
//! directory, and all of them used to be written by `tauri-plugin-store`:
//! `create_dir_all` + pretty JSON + `fs::write`, with the load error swallowed
//! (`let _ = store_inner.load()` in its `build_inner`). The 20.0 review measured
//! what that costs: a crash in the middle of that write left a truncated file
//! that read back as an *empty* store — and the next save wrote that emptiness
//! over the reader's own marks, findings or chats.
//!
//! These commands are the replacement, and they are deliberately the only way
//! the webview can touch those files:
//!
//!   - `store_write_cmd` writes a sibling temp file, fsyncs it, renames it over
//!     the target and fsyncs the directory, so a reader has the previous copy or
//!     the new one and never half of either;
//!   - `store_read_cmd` tells "no file" (`None`) apart from "cannot read"
//!     (`Err`), which the frontend turns into a refusal to write;
//!   - the name is validated here — one path component, `.json`, no traversal —
//!     and resolved under the app data directory. The store plugin took a full
//!     path from the webview and `PathBuf::push` replaces the base directory
//!     when that path is absolute (`tauri-2.12.3/src/path/mod.rs`), so the
//!     webview could address any file the app could write. That is why
//!     `store:default` is gone from the capability file.
//!
//! One subdirectory is allowed, `finding-bodies/`: the reader's kept answers,
//! one file per finding, so that editing one body does not rewrite the whole
//! record (a 5,000-finding index with full bodies is ~104 MB, and every one of
//! those bytes used to be rewritten per debounce).

use std::io::Write;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// A store file may not exceed this. The largest store measured in the 20.0
/// review — 5,000 findings with 20,000-character bodies — is ~104 MB.
const MAX_STORE_BYTES: usize = 256 * 1024 * 1024;
/// The only directory under the store area: one file per kept answer.
const BODIES_DIR: &str = "finding-bodies";

/// A file name in the store area: `marks.json`, or `finding-bodies/<id>.json`.
///
/// Validated rather than trusted — it comes from the webview. One path
/// component (no separators, no `..`, no drive letters), `.json`, and nothing
/// that would let the name leave the app data directory.
pub fn store_file_name(name: &str) -> Option<PathBuf> {
    if let Some(rest) = name.strip_prefix(&format!("{BODIES_DIR}/")) {
        let id = rest.strip_suffix(".json")?;
        // `crypto.randomUUID()`: hex and dashes, 36 characters.
        let valid = (8..=64).contains(&id.len())
            && id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-');
        return valid.then(|| PathBuf::from(BODIES_DIR).join(format!("{id}.json")));
    }
    let stem = name.strip_suffix(".json")?;
    let valid = (1..=64).contains(&stem.len())
        && stem.bytes().all(|b| {
            b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.'
        })
        // `.` and `..` are the two names that are not file names.
        && stem != "."
        && stem != ".."
        && !stem.starts_with('.');
    valid.then(|| PathBuf::from(format!("{stem}.json")))
}

/// The absolute path of a validated store file name, or an error.
fn store_path(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let relative = store_file_name(name).ok_or_else(|| "Invalid store file name".to_string())?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?;
    Ok(dir.join(relative))
}

/// Write through a sibling temp file and a rename, with the bytes flushed
/// before the rename makes them visible.
///
/// The fsync before the rename is what keeps a crash from exposing a renamed
/// file whose contents are still only in the page cache; the directory fsync
/// afterwards is what keeps the rename itself. The latter is best-effort —
/// Windows cannot open a directory as a file — and the previous copy is still
/// intact if it does not happen.
///
/// The OCR cache and the Markdown export write through here too since 21.0 —
/// the cache renamed an unsynced temp file and the export wrote in place.
/// (The annotated PDF does the same steps inline in `annotate.rs`.)
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);

    let write = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        Ok(())
    })();
    if let Err(e) = write {
        // Never leave the temp file behind for the next write to trip over.
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    commit_temp(&tmp, path)
}

/// Make a fully written temp file the file at `path`: fsync it, rename it over
/// `path`, then fsync the directory (best-effort — Windows cannot open a
/// directory as a file). The temp file is removed if any step fails.
fn commit_temp(tmp: &Path, path: &Path) -> std::io::Result<()> {
    let result = (|| -> std::io::Result<()> {
        std::fs::OpenOptions::new().write(true).open(tmp)?.sync_all()?;
        std::fs::rename(tmp, path)
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_file(tmp);
        return Err(e);
    }
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

/// The text of a store file, `None` when it does not exist.
///
/// A file that exists but cannot be read is an error, never an empty document:
/// the frontend refuses to write over anything it could not read.
#[tauri::command]
pub async fn store_read_cmd(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = store_path(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read {}: {e}", path.display())),
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

/// Replace a store file's contents, atomically.
#[tauri::command]
pub async fn store_write_cmd(
    app: AppHandle,
    name: String,
    contents: String,
) -> Result<(), String> {
    if contents.len() > MAX_STORE_BYTES {
        return Err(format!(
            "Store file too large ({} bytes; max {MAX_STORE_BYTES})",
            contents.len()
        ));
    }
    let path = store_path(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || {
        write_atomic(&path, contents.as_bytes())
            .map_err(|e| format!("Failed to write {}: {e}", path.display()))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

/// The absolute path of the one side directory, or an error.
fn store_dir_path(app: &AppHandle, dir: &str) -> Result<PathBuf, String> {
    if dir != BODIES_DIR {
        return Err("Invalid store directory".to_string());
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))?;
    Ok(base.join(BODIES_DIR))
}

/// The names inside the bodies directory, as store file names.
#[tauri::command]
pub async fn store_list_cmd(app: AppHandle, dir: String) -> Result<Vec<String>, String> {
    let path = store_dir_path(&app, &dir)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entries = match std::fs::read_dir(&path) {
            Ok(entries) => entries,
            // Nothing kept yet is not a failure.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("Failed to list {}: {e}", path.display())),
        };
        let mut names = Vec::new();
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if store_file_name(&format!("{BODIES_DIR}/{name}")).is_some() {
                names.push(format!("{BODIES_DIR}/{name}"));
            }
        }
        Ok(names)
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

/// Delete named files from the bodies directory. Missing ones are not an error.
#[tauri::command]
pub async fn store_delete_cmd(app: AppHandle, names: Vec<String>) -> Result<(), String> {
    // Only the side directory: the store files themselves are replaced by a
    // write, never removed, and a name that is not `finding-bodies/<id>.json`
    // has no business here.
    let paths = names
        .iter()
        .map(|name| {
            if !name.starts_with(&format!("{BODIES_DIR}/")) {
                return Err("Invalid store file name".to_string());
            }
            store_path(&app, name)
        })
        .collect::<Result<Vec<_>, _>>()?;
    tauri::async_runtime::spawn_blocking(move || {
        for path in paths {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("Failed to delete {}: {e}", path.display())),
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_names_the_stores_use() {
        for name in [
            "marks.json",
            "findings.json",
            "index-cache.json",
            "settings.json",
            "allowed-paths.json",
            "recent.json",
            "pagewise-v3-chats.json",
            "preferences.json",
        ] {
            assert_eq!(
                store_file_name(name),
                Some(PathBuf::from(name)),
                "{name} is a store file"
            );
        }
    }

    #[test]
    fn rejects_a_name_that_could_leave_the_store_directory() {
        for name in [
            "/etc/passwd",
            "/etc/passwd.json",
            "../../secrets.json",
            "..json",
            "sub/dir.json",
            "sub\\dir.json",
            ".hidden.json",
            "..",
            "marks.txt",
            "",
            "C:\\Users\\me\\settings.json",
        ] {
            assert_eq!(store_file_name(name), None, "{name} must not resolve");
        }
    }

    #[test]
    fn accepts_a_finding_body_and_nothing_else_in_that_directory() {
        let id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        assert_eq!(
            store_file_name(&format!("finding-bodies/{id}.json")),
            Some(PathBuf::from(format!("finding-bodies/{id}.json")))
        );
        for name in [
            "finding-bodies/../../etc/passwd.json",
            "finding-bodies/not-hex-zzzzzzzz.json",
            "finding-bodies/.json",
            "finding-bodies/0f8fad5b-d9cb-469f-a165-70867728950e.txt",
        ] {
            assert_eq!(store_file_name(name), None, "{name} must not resolve");
        }
    }

    #[test]
    fn a_write_replaces_the_file_and_leaves_no_temp_behind() {
        let dir = std::env::temp_dir().join(format!("pagewise-store-{}", std::process::id()));
        let path = dir.join("marks.json");
        write_atomic(&path, b"{\"a\":1}").expect("first write");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        write_atomic(&path, b"{\"a\":2}").expect("second write");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"a\":2}");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left: {leftovers:?}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
