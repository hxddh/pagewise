//! Which files the app may read and which folders it may write to (21.0).
//!
//! Until 21.0 the allowlist was filled by `register_allowed_path`, an ordinary
//! command that took any path from the webview and granted it — and widened the
//! asset protocol to it. The allowlist therefore protected nothing from the one
//! party it exists to constrain: any script running in the webview could grant
//! itself `~/.ssh/id_rsa` and read it, or grant `$HOME` and write into it. The
//! save-as folders were also persisted in a JSON store the webview itself can
//! write, and re-granted at every launch.
//!
//! Now a grant only ever comes from something the reader did outside the
//! webview, observed here in Rust:
//!
//! - a file picked in the open dialog (`pick_document`), or a folder implied by
//!   a file picked in the save dialog (`pick_save_path`, this session only);
//! - a file dropped on the window (the drop is granted here, then announced to
//!   the front end as `pagewise://dropped`);
//! - a file the app was launched with, handed over by a second launch, or
//!   handed over by macOS (`open_path`);
//! - a document granted in an earlier session, read back from
//!   `granted-documents.list` — a file the webview cannot address, since the
//!   store commands only take names ending in `.json`.
//!
//! The webview can ask whether a path is granted, never grant one.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

/// What the open dialog offers, and what a drop or a launch may grant. The
/// front end's `isSupportedDocument` names the same set.
pub const DOCUMENT_EXTENSIONS: &[&str] =
    &["pdf", "png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif"];
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp", "gif"];

/// The documents granted in earlier sessions. Not `.json`: no store command
/// accepts the name, so the webview can neither read nor write it.
const LIST_FILE: &str = "granted-documents.list";
/// Where 20.0 kept the front end's own list, read once to carry recents over.
const LEGACY_FILE: &str = "allowed-paths.json";
/// Kept across sessions; the oldest grants go first.
const MAX_PERSISTED: usize = 256;

#[derive(Default)]
pub struct AllowedPaths {
    /// Files that may be read, canonical.
    files: Mutex<HashSet<PathBuf>>,
    /// The files a save dialog returned, each writable once: canonical parent
    /// joined with the chosen name. Never persisted. Until 22.0 this was the
    /// dialog's whole folder, for the session — a reader who exported to
    /// `$HOME` once let any webview script write any file there afterwards.
    write_targets: Mutex<HashSet<PathBuf>>,
    /// The persisted documents, oldest first, as they are written to disk.
    persisted: Mutex<Vec<PathBuf>>,
    /// Whether `restore` has read the list back. Until it has, the list in
    /// memory is not the list on disk, and writing it would replace the disk's
    /// (21.0.1: macOS hands a double-clicked file to the app before setup).
    restored: AtomicBool,
}

impl AllowedPaths {
    pub fn can_read(&self, canon: &Path) -> Result<bool, String> {
        Ok(self
            .files
            .lock()
            .map_err(|_| "allowlist lock poisoned".to_string())?
            .contains(canon))
    }

    /// Whether `target` (canonical parent + name) was returned by a save
    /// dialog, consuming the grant: one dialog, one write.
    pub fn take_write(&self, target: &Path) -> Result<bool, String> {
        Ok(self
            .write_targets
            .lock()
            .map_err(|_| "allowlist lock poisoned".to_string())?
            .remove(target))
    }
}

pub fn is_document(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| DOCUMENT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Grant reading one document file, and keep it for the next session.
///
/// Refuses anything that is not an existing file with a document extension:
/// a grant is for the document the reader chose, never for a folder.
pub fn grant_document(app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
    let canon = std::fs::canonicalize(path).map_err(|e| format!("Invalid path: {e}"))?;
    if !canon.is_file() || !is_document(&canon) {
        return Err("not a document".to_string());
    }
    grant_file_in_session(app, &canon)?;
    persist(app, &canon);
    Ok(canon)
}

fn grant_file_in_session(app: &AppHandle, canon: &Path) -> Result<(), String> {
    // The asset protocol first, and the allowlist only once it holds: a path
    // the IPC commands read while its asset URL 404s is the half-granted state
    // the old command was careful to avoid, and so is this.
    app.asset_protocol_scope()
        .allow_file(canon)
        .map_err(|e| format!("asset scope: {e}"))?;
    let state = app.state::<AllowedPaths>();
    state
        .files
        .lock()
        .map_err(|_| "allowlist lock poisoned".to_string())?
        .insert(canon.to_path_buf());
    Ok(())
}

fn grant_write_target(app: &AppHandle, path: &Path) -> Result<PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid path: no parent directory".to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "Invalid path: no file name".to_string())?;
    let canon_parent = std::fs::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;
    if !canon_parent.is_dir() {
        return Err("not a folder".to_string());
    }
    let target = canon_parent.join(name);
    app.state::<AllowedPaths>()
        .write_targets
        .lock()
        .map_err(|_| "allowlist lock poisoned".to_string())?
        .insert(target.clone());
    Ok(target)
}

fn list_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join(LIST_FILE))
}

/// Remember a granted document for the next session. Best-effort: a failed
/// write costs the reader one re-pick, never the document they have open.
fn persist(app: &AppHandle, canon: &Path) {
    let state = app.state::<AllowedPaths>();
    let Ok(mut list) = state.persisted.lock() else {
        return;
    };
    list.retain(|p| p != canon);
    list.push(canon.to_path_buf());
    let excess = list.len().saturating_sub(MAX_PERSISTED);
    list.drain(..excess);
    // Before `restore`, the list in memory holds only what this launch granted
    // so far. In 21.0 it was written as it stood: a document double-clicked in
    // Finder arrives as an `Opened` event before `didFinishLaunching`, so the
    // list on disk became that one file, `restore` read it back, and the front
    // end pruned every other recent document — and its chat — as ungranted.
    // `restore` merges what is held here and writes once.
    if !state.restored.load(Ordering::SeqCst) {
        return;
    }
    let Some(file) = list_path(app) else {
        return;
    };
    if let Ok(json) = serde_json::to_vec(&*list) {
        let _ = crate::store_io::write_atomic(&file, &json);
    }
}

/// Read back what earlier sessions granted, and grant the documents that are
/// still there. Called once, at startup.
///
/// The first 21.0 launch finds no list and carries over the files (never the
/// folders) of 20.0's `allowed-paths.json`, so a reader's library still opens.
/// That file was writable from the webview, but everything in it was already
/// granted by 20.0 at every launch: importing it once grants nothing 20.0 did
/// not, and nothing written to it afterwards is ever read again.
pub fn restore(app: &AppHandle) {
    let Some(file) = list_path(app) else {
        return;
    };
    let stored: Vec<PathBuf> = match std::fs::read(&file) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
        Err(_) => legacy_documents(app),
    };
    let mut kept = Vec::new();
    for path in stored {
        let Ok(canon) = std::fs::canonicalize(&path) else {
            continue;
        };
        if !canon.is_file() || !is_document(&canon) || kept.contains(&canon) {
            continue;
        }
        if grant_file_in_session(app, &canon).is_ok() {
            kept.push(canon);
        }
    }
    let state = app.state::<AllowedPaths>();
    let Ok(mut list) = state.persisted.lock() else {
        return;
    };
    // Documents granted before this ran (an `Opened` event at launch) are the
    // newest, so they go last; then the cap.
    let merged = merge_persisted(kept, &list);
    if let Ok(json) = serde_json::to_vec(&merged) {
        let _ = crate::store_io::write_atomic(&file, &json);
    }
    *list = merged;
    state.restored.store(true, Ordering::SeqCst);
}

/// The list `restore` writes: what was on disk and still exists, then what was
/// granted before `restore` ran, without duplicates, the newest `MAX_PERSISTED`.
pub fn merge_persisted(stored: Vec<PathBuf>, early: &[PathBuf]) -> Vec<PathBuf> {
    let mut merged: Vec<PathBuf> = stored.into_iter().filter(|p| !early.contains(p)).collect();
    merged.extend(early.iter().cloned());
    let excess = merged.len().saturating_sub(MAX_PERSISTED);
    merged.drain(..excess);
    merged
}

/// A canonical path as the front end shows and stores it. On Windows
/// `canonicalize` returns the verbatim form (`\\?\C:\…`, `\\?\UNC\…`); 21.0
/// handed that to the webview, so a document opened through a dialog or a
/// drop was a different recent entry from the same file in 20.0's list, and
/// the prefix showed in the library. The Rust side still checks grants
/// against the canonical form: `path_granted` canonicalizes what it is given.
pub fn for_front_end(canon: &Path) -> String {
    let s = canon.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    s.strip_prefix(r"\\?\").map(str::to_owned).unwrap_or_else(|| s.into_owned())
}

fn legacy_documents(app: &AppHandle) -> Vec<PathBuf> {
    let Ok(dir) = app.path().app_data_dir() else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(dir.join(LEGACY_FILE)) else {
        return Vec::new();
    };
    legacy_paths(&bytes)
}

/// The paths in 20.0's `allowed-paths.json` (`{ "paths": [...] }`).
pub fn legacy_paths(bytes: &[u8]) -> Vec<PathBuf> {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|v| v.get("paths").cloned())
        .and_then(|p| serde_json::from_value::<Vec<String>>(p).ok())
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

/// Ask the reader for a document, and grant the one they pick.
#[tauri::command]
pub async fn pick_document(app: AppHandle) -> Result<Option<String>, String> {
    let picker = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        picker
            .dialog()
            .file()
            .add_filter("Documents", DOCUMENT_EXTENSIONS)
            .add_filter("PDF", &["pdf"])
            .add_filter("Images", IMAGE_EXTENSIONS)
            .blocking_pick_file()
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| format!("Invalid path: {e}"))?;
    let canon = grant_document(&app, &path)?;
    Ok(Some(for_front_end(&canon)))
}

/// Ask the reader where to save, and grant one write to the file they chose
/// (21.1.0: it was their whole folder, for the rest of the session). Returns
/// the path they chose, not canonical — the file may not exist yet.
#[tauri::command]
pub async fn pick_save_path(
    app: AppHandle,
    default_name: String,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<String>, String> {
    let picker = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let exts: Vec<&str> = extensions.iter().map(String::as_str).collect();
        picker
            .dialog()
            .file()
            .set_file_name(default_name)
            .add_filter(filter_name, &exts)
            .blocking_save_file()
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?;
    let Some(picked) = picked else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| format!("Invalid path: {e}"))?;
    grant_write_target(&app, &path)?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Whether a document may be opened — granted this session or an earlier one.
/// The front end asks before it opens a path it got from its own state (a
/// recent file), so a refusal is a clear message rather than a read error.
#[tauri::command]
pub fn path_granted(path: String, app: AppHandle) -> Result<bool, String> {
    let Ok(canon) = std::fs::canonicalize(&path) else {
        return Ok(false);
    };
    app.state::<AllowedPaths>().can_read(&canon)
}

/// A drop on the window: grant each document dropped, then tell the front end
/// which ones it may open. Granted here, before the front end hears of it, so
/// it never races the grant; anything that is not a document is not granted.
pub fn dropped(app: &AppHandle, paths: &[PathBuf]) {
    let granted: Vec<String> = paths
        .iter()
        .filter_map(|p| grant_document(app, p).ok())
        .map(|p| for_front_end(&p))
        .collect();
    if !granted.is_empty() {
        let _ = app.emit("pagewise://dropped", granted);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_is_known_by_its_extension_in_any_case() {
        assert!(is_document(Path::new("/a/paper.PDF")));
        assert!(is_document(Path::new("/a/scan.tiff")));
        assert!(!is_document(Path::new("/home/me/.ssh/id_rsa")));
        assert!(!is_document(Path::new("/home/me/.bashrc")));
        assert!(!is_document(Path::new("/home/me")));
    }

    #[test]
    fn reads_the_paths_twenty_point_zero_kept() {
        let got = legacy_paths(br#"{"paths":["/a/paper.pdf","/a/out"]}"#);
        assert_eq!(got, vec![PathBuf::from("/a/paper.pdf"), PathBuf::from("/a/out")]);
        assert!(legacy_paths(b"not json").is_empty());
        assert!(legacy_paths(br#"{"paths":"nope"}"#).is_empty());
    }

    #[test]
    fn a_grant_before_restore_joins_the_list_instead_of_replacing_it() {
        let stored = vec![PathBuf::from("/a.pdf"), PathBuf::from("/b.pdf"), PathBuf::from("/c.pdf")];
        let early = vec![PathBuf::from("/b.pdf"), PathBuf::from("/new.pdf")];
        assert_eq!(
            merge_persisted(stored, &early),
            vec![
                PathBuf::from("/a.pdf"),
                PathBuf::from("/c.pdf"),
                PathBuf::from("/b.pdf"),
                PathBuf::from("/new.pdf"),
            ],
        );
        let many: Vec<PathBuf> = (0..MAX_PERSISTED + 5).map(|i| PathBuf::from(format!("/{i}.pdf"))).collect();
        let merged = merge_persisted(many, &[PathBuf::from("/last.pdf")]);
        assert_eq!(merged.len(), MAX_PERSISTED);
        assert_eq!(merged.last(), Some(&PathBuf::from("/last.pdf")));
    }

    #[test]
    fn the_front_end_gets_a_path_without_the_verbatim_prefix() {
        assert_eq!(for_front_end(Path::new(r"\\?\C:\Docs\a.pdf")), r"C:\Docs\a.pdf");
        assert_eq!(for_front_end(Path::new(r"\\?\UNC\srv\share\a.pdf")), r"\\srv\share\a.pdf");
        assert_eq!(for_front_end(Path::new("/home/me/a.pdf")), "/home/me/a.pdf");
    }

    #[test]
    fn a_save_dialog_grants_its_one_file_once() {
        let allowed = AllowedPaths::default();
        let target = PathBuf::from("/out/notes.md");
        allowed.write_targets.lock().unwrap().insert(target.clone());
        assert!(!allowed.take_write(Path::new("/out/.bashrc")).unwrap(), "only the file chosen");
        assert!(allowed.take_write(&target).unwrap());
        assert!(!allowed.take_write(&target).unwrap(), "and only once");
    }

    #[test]
    fn the_list_file_is_not_a_store_name() {
        // The point of the name: the webview's store commands refuse it.
        assert!(crate::store_io::store_file_name(LIST_FILE).is_none());
    }
}
