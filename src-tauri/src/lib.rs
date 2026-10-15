mod annotate;
mod grants;
mod inspect;
mod ocr_cache;
mod open_path;
mod secrets;
mod store_io;

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use inspect::{DocumentModel, Rect, RegionText, TextItemRect};
use tauri::{Emitter, Manager, State};

use grants::AllowedPaths;

fn canonicalize(path: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|e| format!("Invalid path: {e}"))
}

fn ensure_allowed(allowed: &AllowedPaths, path: &str) -> Result<PathBuf, String> {
    let canon = canonicalize(path)?;
    if !allowed.can_read(&canon)? {
        return Err("path not authorized".to_string());
    }
    Ok(canon)
}

fn run_blocking_pdf<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + std::panic::UnwindSafe,
{
    match std::panic::catch_unwind(f) {
        Ok(result) => result,
        Err(_) => Err(
            "PDF processing failed — the file may be malformed or unsupported".to_string(),
        ),
    }
}

// Nothing in the webview grants a path (21.0): see `grants` for where grants
// come from. `register_allowed_path` took any path the webview named.

/// Freshness stamp (modification time + size) for an authorized file.
///
/// The frontend keys its persistent page-index cache on this, so a file that was
/// rewritten in place can never be served page text that was extracted from its
/// previous contents.
#[tauri::command]
async fn file_stamp_cmd(path: String, allowed: State<'_, AllowedPaths>) -> Result<String, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let meta =
        std::fs::metadata(&canon).map_err(|e| format!("Failed to read file metadata: {e}"))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("Failed to read file metadata: {e}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("Failed to read file metadata: {e}"))?;
    Ok(format!(
        "{}.{:09}:{}",
        mtime.as_secs(),
        mtime.subsec_nanos(),
        meta.len()
    ))
}

/// Content fingerprint for an authorized file: what the file *is*, as opposed
/// to where it is (`path`) or when it last changed (`file_stamp_cmd`).
///
/// The frontend keys the reader's marks, findings and chat on it beside the
/// path, so a document that is renamed or moved finds its own record again.
/// Hashing the first and last 64 KiB plus the length rather than the whole
/// file keeps this cheap on a 400 MB scan; two of a reader's own documents
/// agreeing on all three is not a case worth a full read on every open.
///
/// FNV-1a, 64-bit, written out here rather than pulled in as a crate: this is
/// a fingerprint, not a signature, and nothing checks it against anything a
/// third party could forge.
#[tauri::command]
async fn file_identity_cmd(
    path: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<String, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    tauri::async_runtime::spawn_blocking(move || file_identity(&canon))
        .await
        .map_err(|e| format!("Task join failed: {e}"))?
}

const IDENTITY_WINDOW: u64 = 64 * 1024;

fn file_identity(path: &std::path::Path) -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("Failed to open file: {e}"))?;
    let len = file
        .metadata()
        .map_err(|e| format!("Failed to read file metadata: {e}"))?
        .len();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for b in bytes {
            hash ^= u64::from(*b);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    let mut buf = vec![0u8; IDENTITY_WINDOW as usize];
    let head = file.read(&mut buf).map_err(|e| format!("Failed to read file: {e}"))?;
    feed(&buf[..head]);
    if len > IDENTITY_WINDOW {
        let tail_start = len.saturating_sub(IDENTITY_WINDOW).max(IDENTITY_WINDOW);
        file.seek(SeekFrom::Start(tail_start))
            .map_err(|e| format!("Failed to read file: {e}"))?;
        let tail = file.read(&mut buf).map_err(|e| format!("Failed to read file: {e}"))?;
        feed(&buf[..tail]);
    }
    feed(&len.to_le_bytes());
    Ok(format!("fnv1a64:{hash:016x}:{len}"))
}

/// Parse a document once and hand back everything the app needs from it.
#[tauri::command]
async fn open_document_cmd(
    path: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<DocumentModel, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let canon_str = canon.to_str().ok_or("Invalid path encoding")?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        run_blocking_pdf(|| inspect::open_document(&canon_str))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

/// Every text run on one page, with its position — used to point at a search
/// hit on the rendered page.
#[tauri::command]
async fn page_text_items_cmd(
    path: String,
    page: u32,
    allowed: State<'_, AllowedPaths>,
) -> Result<Vec<TextItemRect>, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let canon_str = canon.to_str().ok_or("Invalid path encoding")?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        run_blocking_pdf(|| inspect::page_text_items(&canon_str, page))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

/// Read the text under a selection rectangle (top-left origin, PDF points).
#[tauri::command]
async fn extract_region_cmd(
    path: String,
    page: u32,
    rect: Rect,
    allowed: State<'_, AllowedPaths>,
) -> Result<RegionText, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let canon_str = canon.to_str().ok_or("Invalid path encoding")?.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        run_blocking_pdf(|| inspect::extract_region(&canon_str, page, rect))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

#[derive(Clone, Default)]
struct FileReadCancel(Arc<AtomicU64>);

impl FileReadCancel {
    fn bump(&self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tauri::command]
fn cancel_file_read_cmd(cancel: State<'_, FileReadCancel>) {
    cancel.bump();
}

/// Maximum file size for `read_file_bytes` (256 MiB).
const MAX_READ_BYTES: u64 = 256 * 1024 * 1024;
const READ_CHUNK_BYTES: usize = 1024 * 1024;

fn read_file_with_cancel(
    path: &Path,
    cancel: &Arc<AtomicU64>,
    gen_at_start: u64,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::SeqCst) != gen_at_start {
        return Err("Read cancelled".to_string());
    }
    let mut file = File::open(path).map_err(|e| format!("Read failed: {e}"))?;
    let len = file.metadata().map_err(|e| format!("Read failed: {e}"))?.len();
    if len > MAX_READ_BYTES {
        return Err(format!(
            "File too large ({len} bytes; max {MAX_READ_BYTES})"
        ));
    }
    let mut buf = Vec::with_capacity(len.min(MAX_READ_BYTES) as usize);
    let mut chunk = [0u8; READ_CHUNK_BYTES];
    loop {
        if cancel.load(Ordering::SeqCst) != gen_at_start {
            return Err("Read cancelled".to_string());
        }
        let n = file.read(&mut chunk).map_err(|e| format!("Read failed: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() as u64 > MAX_READ_BYTES {
            return Err(format!(
                "File too large (>{MAX_READ_BYTES} bytes)"
            ));
        }
    }
    Ok(buf)
}

#[tauri::command]
async fn read_file_bytes(
    path: String,
    allowed: State<'_, AllowedPaths>,
    cancel: State<'_, FileReadCancel>,
) -> Result<tauri::ipc::Response, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let meta = std::fs::metadata(&canon).map_err(|e| format!("Read failed: {e}"))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "File too large ({} bytes; max {MAX_READ_BYTES})",
            meta.len()
        ));
    }
    let cancel_gen = cancel.inner().0.clone();
    let gen_at_start = cancel_gen.load(Ordering::SeqCst);
    let path_for_read = canon.clone();
    let cancel_for_blocking = cancel_gen.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        read_file_with_cancel(&path_for_read, &cancel_for_blocking, gen_at_start)
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))??;
    if cancel_gen.load(Ordering::SeqCst) != gen_at_start {
        return Err("Read cancelled".to_string());
    }
    Ok(tauri::ipc::Response::new(bytes))
}


/// Where a save-as write may go: `(authorized parent, target)`.
///
/// Authorized ONLY by a save dialog having returned exactly this path, and
/// only once (22.0 — it was the dialog's whole folder for the session).
/// Deliberately NOT authorized by the target being a granted document: every
/// opened document would then be a write target too.
fn write_target(allowed: &AllowedPaths, path: &str) -> Result<(PathBuf, PathBuf), String> {
    let target = PathBuf::from(path);
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid path: no parent directory".to_string())?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Invalid path: no file name".to_string())?;
    let canon_parent = std::fs::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;

    // Reject any file name that contains path separators or traversal — the
    // write must stay directly inside the authorized parent directory.
    let name_str = file_name
        .to_str()
        .ok_or_else(|| "Invalid path: bad file name encoding".to_string())?;
    if name_str == ".."
        || name_str == "."
        || name_str.contains('/')
        || name_str.contains('\\')
    {
        return Err("path not authorized".to_string());
    }

    // Do NOT canonicalize the leaf: canonicalize() requires the final path
    // component to already exist, which would break saving to a NEW file name.
    let resolved = canon_parent.join(file_name);
    if !allowed.take_write(&resolved)? {
        return Err("path not authorized".to_string());
    }
    Ok((canon_parent, resolved))
}

/// Run immediately before writing (minimizes the check→write TOCTOU window):
/// reject a symlink leaf outright. Path::exists() follows symlinks and returns
/// false for a DANGLING one, which would otherwise let the write follow it and
/// create a file outside the authorized directory.
fn check_write_leaf(resolved: &Path, canon_parent: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(resolved) {
        Ok(meta) => {
            if meta.file_type().is_symlink() {
                return Err("path not authorized".to_string());
            }
            let canon_resolved =
                std::fs::canonicalize(resolved).map_err(|e| format!("Invalid path: {e}"))?;
            if !canon_resolved.starts_with(canon_parent) {
                return Err("path not authorized".to_string());
            }
            Ok(())
        }
        // New file — no existing target to resolve; the parent is authorized.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Invalid path: {e}")),
    }
}

#[tauri::command]
async fn write_text_file(
    path: String,
    content: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<(), String> {
    let (canon_parent, resolved) = write_target(&allowed, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        check_write_leaf(&resolved, &canon_parent)?;
        // Atomic like every other write (21.0): an export that fails midway
        // leaves the file that was there, not half of a new one.
        store_io::write_atomic(&resolved, content.as_bytes()).map_err(|e| format!("Write failed: {e}"))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

/// Write a copy of the open PDF with the reader's evidence as annotations
/// (14.1, `annotate.rs`). Returns how many were written. Never over the source.
#[tauri::command]
async fn export_annotated_pdf(
    path: String,
    out_path: String,
    annotations: Vec<annotate::AnnotationIn>,
    allowed: State<'_, AllowedPaths>,
) -> Result<usize, String> {
    let source = ensure_allowed(&allowed, &path)?;
    let (canon_parent, resolved) = write_target(&allowed, &out_path)?;
    tauri::async_runtime::spawn_blocking(move || {
        check_write_leaf(&resolved, &canon_parent)?;
        if std::fs::canonicalize(&resolved).is_ok_and(|p| p == source) {
            return Err("Choose a new file: the open document is not overwritten".to_string());
        }
        run_blocking_pdf(|| annotate::annotate_file(&source, &resolved, &annotations))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        // Single instance FIRST. The plugin's own docs are emphatic about it:
        // registered after another plugin, the second launch has already done
        // that plugin's setup before it is told to bow out.
        //
        // A reader who double-clicks a second PDF wants it in the window they
        // already have, not a second copy of the app with its own empty
        // conversation and its own idea of which document is open.
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let Some(window) = app.get_webview_window("main") else {
                return;
            };
            // Raise the window the reader already has. `unminimize` first —
            // `set_focus` on a minimized window is a no-op on Windows, which
            // is exactly the state a reader who went looking for the app is
            // most likely to have left it in.
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            // Anything that looks like a file on the second command line is
            // what they double-clicked. The front end decides whether it can
            // open it; this only carries it across.
            // Resolved against the second launch's directory, not ours: a
            // relative path typed in a terminal names a file there (16.0).
            // Granted here, before the front end hears of it (21.0).
            if let Some(path) = open_path::path_from_args(&argv, Path::new(&cwd)) {
                if let Ok(canon) = grants::grant_document(app, Path::new(&path)) {
                    let _ = window.emit("pagewise://open-path", grants::for_front_end(&canon));
                }
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // No store plugin: every JSON store the frontend keeps goes through
        // `store_io`'s four commands now. The plugin's `load` took a path from
        // the webview and `PathBuf::push` replaces the base directory for an
        // absolute one, so `store:default` let any script in the webview read
        // and write any JSON file the app could — and its `save()` was a plain
        // `fs::write`, which is what turned a torn write into a lost store.
        .manage(AllowedPaths::default())
        // The file this launch was started with (16.0, B15). Before, only a
        // second launch's file was opened: double-clicking a PDF with the app
        // closed started it empty.
        .manage(open_path::PendingOpen::from_launch())
        .manage(FileReadCancel::default())
        .setup(|app| {
            let handle = app.handle();
            grants::restore(handle);
            // The launch's own file, granted like any other the reader chose.
            open_path::grant_pending(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                // Off the event loop (22.0): each file is canonicalized and the
                // list fsync'd, which stalled the window for a large drop or
                // a slow network share.
                let app = window.app_handle().clone();
                let paths = paths.clone();
                tauri::async_runtime::spawn_blocking(move || grants::dropped(&app, &paths));
            }
        })
        .invoke_handler(tauri::generate_handler![
            grants::pick_document,
            grants::pick_save_path,
            grants::path_granted,
            cancel_file_read_cmd,
            file_stamp_cmd,
            file_identity_cmd,
            open_document_cmd,
            extract_region_cmd,
            page_text_items_cmd,
            read_file_bytes,
            write_text_file,
            export_annotated_pdf,
            store_io::store_read_cmd,
            store_io::store_write_cmd,
            store_io::store_list_cmd,
            store_io::store_delete_cmd,
            secrets::set_api_key,
            secrets::get_api_key,
            secrets::delete_api_key,
            ocr_cache::ocr_cache_read,
            ocr_cache::ocr_cache_write,
            ocr_cache::ocr_cache_stats,
            ocr_cache::ocr_cache_clear,
            open_path::take_pending_open,
        ])
        .build(tauri::generate_context!());

    match result {
        Ok(app) => app.run(|_app, _event| {
            // macOS hands a double-clicked file to the running app as an
            // event, at launch as well as later — never on the command line.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Opened { urls } = &_event {
                open_path::opened(_app, urls);
            }
        }),
        Err(e) => {
            eprintln!("error while running tauri application: {e}");
            std::process::exit(1);
        }
    }
}
