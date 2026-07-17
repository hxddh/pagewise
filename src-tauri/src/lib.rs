mod pdf;
mod secrets;

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use pdf::{extract_pdf_text, pdf_page_count, PdfCache, PdfExtractCancel, PdfExtractResult};
use tauri::{Manager, State};

#[derive(Default)]
struct AllowedPaths(Mutex<HashSet<PathBuf>>);

impl AllowedPaths {
    fn contains(&self, path: &PathBuf) -> Result<bool, String> {
        let set = self
            .0
            .lock()
            .map_err(|_| "allowlist lock poisoned".to_string())?;
        Ok(set.contains(path))
    }
}

fn canonicalize(path: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|e| format!("Invalid path: {e}"))
}

fn ensure_allowed(allowed: &AllowedPaths, path: &str) -> Result<PathBuf, String> {
    let canon = canonicalize(path)?;
    if !allowed.contains(&canon)? {
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

// Authorizations are intentionally session-scoped: they accumulate for the life
// of the process and are never revoked, so an already-open document or in-flight
// asset load can't lose access mid-session. Growth is bounded in practice by the
// number of distinct files touched this session and fully resets on restart (the
// frontend re-registers only its capped recent-files list at startup), so no
// eviction policy is needed here.
#[tauri::command]
async fn register_allowed_path(
    path: String,
    state: State<'_, AllowedPaths>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let canon = canonicalize(&path)?;
    // Grant the asset-protocol scope BEFORE recording the path, and don't hold
    // the allowlist lock across that call: if allow_file fails, the set must not
    // end up with a path the asset scope doesn't know about (IPC reads would
    // work while asset URLs 404 for the rest of the session).
    app.asset_protocol_scope()
        .allow_file(&canon)
        .map_err(|e| format!("asset scope: {e}"))?;
    state
        .0
        .lock()
        .map_err(|_| "allowlist lock poisoned".to_string())?
        .insert(canon);
    Ok(())
}

#[tauri::command]
fn cancel_pdf_extract_cmd(scope: String, cancel: State<'_, PdfExtractCancel>) {
    cancel.bump_scope(pdf::PdfExtractScope::parse(&scope));
}

#[tauri::command]
async fn pdf_page_count_cmd(
    path: String,
    scope: String,
    allowed: State<'_, AllowedPaths>,
    cancel: State<'_, PdfExtractCancel>,
) -> Result<u32, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let canon_str = canon.to_str().ok_or("Invalid path encoding")?.to_string();
    let cancel = cancel.inner().clone();
    let pdf_scope = pdf::PdfExtractScope::parse(&scope);
    let gen = cancel.capture(pdf_scope);
    tauri::async_runtime::spawn_blocking(move || {
        run_blocking_pdf(|| pdf_page_count(&canon_str, &cancel, pdf_scope, gen))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

#[tauri::command]
async fn extract_pdf_text_cmd(
    path: String,
    page: Option<u32>,
    scope: String,
    allowed: State<'_, AllowedPaths>,
    cache: State<'_, PdfCache>,
    cancel: State<'_, PdfExtractCancel>,
) -> Result<PdfExtractResult, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let canon_str = canon.to_str().ok_or("Invalid path encoding")?.to_string();
    let cache = cache.inner().clone();
    let cancel = cancel.inner().clone();
    let pdf_scope = pdf::PdfExtractScope::parse(&scope);
    let gen = cancel.capture(pdf_scope);
    tauri::async_runtime::spawn_blocking(move || {
        run_blocking_pdf(|| extract_pdf_text(&canon_str, page, &cache, &cancel, pdf_scope, gen))
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


#[tauri::command]
async fn write_text_file(
    path: String,
    content: String,
    allowed: State<'_, AllowedPaths>,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid path: no parent directory".to_string())?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Invalid path: no file name".to_string())?;
    let canon_parent = std::fs::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;

    // Authorize writes ONLY via an explicitly-registered parent DIRECTORY (the
    // save-as flow registers the chosen directory). Deliberately NOT authorized
    // by the target file being in the allowlist: that set is populated by every
    // opened document, which would make every read path a write target too.
    let authorized = {
        let set = allowed
            .0
            .lock()
            .map_err(|_| "allowlist lock poisoned".to_string())?;
        set.contains(&canon_parent)
    };

    if !authorized {
        return Err("path not authorized".to_string());
    }

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

    tauri::async_runtime::spawn_blocking(move || {
        // Validate immediately before writing (minimizes the check→write TOCTOU
        // window) and reject a symlink leaf outright: Path::exists() follows
        // symlinks and returns false for a DANGLING one, which would otherwise let
        // fs::write follow it and create a file outside the authorized directory.
        match std::fs::symlink_metadata(&resolved) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err("path not authorized".to_string());
                }
                let canon_resolved = std::fs::canonicalize(&resolved)
                    .map_err(|e| format!("Invalid path: {e}"))?;
                if !canon_resolved.starts_with(&canon_parent) {
                    return Err("path not authorized".to_string());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // New file — no existing target to resolve; the parent is authorized.
            }
            Err(e) => return Err(format!("Invalid path: {e}")),
        }
        std::fs::write(&resolved, content.as_bytes()).map_err(|e| format!("Write failed: {e}"))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AllowedPaths::default())
        .manage(PdfCache::default())
        .manage(PdfExtractCancel::default())
        .manage(FileReadCancel::default())
        .invoke_handler(tauri::generate_handler![
            register_allowed_path,
            cancel_pdf_extract_cmd,
            cancel_file_read_cmd,
            pdf_page_count_cmd,
            extract_pdf_text_cmd,
            read_file_bytes,
            write_text_file,
            secrets::set_api_key,
            secrets::get_api_key,
            secrets::delete_api_key,
        ])
        .run(tauri::generate_context!());

    if let Err(e) = result {
        eprintln!("error while running tauri application: {e}");
        std::process::exit(1);
    }
}
