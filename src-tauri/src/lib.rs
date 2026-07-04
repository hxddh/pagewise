mod ocr;
mod pdf;
mod secrets;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use pdf::{extract_pdf_text, PdfCache, PdfExtractResult};
use serde::Serialize;
use tauri::State;

/// Managed state holding the set of authorized absolute (canonicalized) paths.
/// Every file-touching command must verify the incoming path against this set.
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

/// Canonicalize an existing path, mapping errors to a stable message.
fn canonicalize(path: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(path).map_err(|e| format!("Invalid path: {e}"))
}

/// Ensure `path` (which must already exist) is in the allowlist.
fn ensure_allowed(allowed: &AllowedPaths, path: &str) -> Result<PathBuf, String> {
    let canon = canonicalize(path)?;
    if !allowed.contains(&canon)? {
        return Err("path not authorized".to_string());
    }
    Ok(canon)
}

/// Register a path as authorized. Canonicalizes then inserts it into the set.
#[tauri::command]
fn register_allowed_path(path: String, state: State<AllowedPaths>) -> Result<(), String> {
    let canon = canonicalize(&path)?;
    let mut set = state
        .0
        .lock()
        .map_err(|_| "allowlist lock poisoned".to_string())?;
    set.insert(canon);
    Ok(())
}

#[tauri::command]
fn extract_pdf_text_cmd(
    path: String,
    page: Option<u32>,
    allowed: State<AllowedPaths>,
    cache: State<PdfCache>,
) -> Result<PdfExtractResult, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let canon_str = canon.to_str().ok_or("Invalid path encoding")?;
    extract_pdf_text(canon_str, page, &cache)
}

#[tauri::command]
fn read_file_bytes(path: String, allowed: State<AllowedPaths>) -> Result<Vec<u8>, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    std::fs::read(&canon).map_err(|e| format!("Read failed: {e}"))
}

#[tauri::command]
fn ocr_image(path: String, allowed: State<AllowedPaths>) -> Result<String, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let canon_str = canon.to_str().ok_or("Invalid path encoding")?;
    ocr::ocr_image(canon_str)
}

#[tauri::command]
fn ocr_bytes(data: Vec<u8>) -> Result<String, String> {
    ocr::ocr_bytes(data)
}

#[tauri::command]
fn write_text_file(
    path: String,
    content: String,
    allowed: State<AllowedPaths>,
) -> Result<(), String> {
    // Save-as picks a new (possibly non-existent) file, so allow either the
    // file itself or its parent directory to be authorized.
    let target = PathBuf::from(&path);
    let parent = target
        .parent()
        .ok_or_else(|| "Invalid path: no parent directory".to_string())?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Invalid path: no file name".to_string())?;
    let canon_parent = std::fs::canonicalize(parent).map_err(|e| format!("Invalid path: {e}"))?;

    let authorized = {
        let set = allowed
            .0
            .lock()
            .map_err(|_| "allowlist lock poisoned".to_string())?;
        // Parent dir authorized, OR the fully-resolved file path authorized.
        set.contains(&canon_parent) || set.contains(&canon_parent.join(file_name))
    };

    if !authorized {
        return Err("path not authorized".to_string());
    }

    // Write to the resolved path (parent is canonical, filename preserved).
    let resolved = canon_parent.join(file_name);
    std::fs::write(&resolved, content.as_bytes()).map_err(|e| format!("Write failed: {e}"))
}

#[derive(Debug, Clone, Serialize)]
struct TesseractStatus {
    /// Whether the `tesseract` binary is installed and runnable.
    installed: bool,
    /// Whether the `chi_sim` (Simplified Chinese) language pack is available.
    chi_sim: bool,
}

#[tauri::command]
fn check_tesseract() -> TesseractStatus {
    let installed = std::process::Command::new("tesseract")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let chi_sim = installed && ocr::has_chi_sim();

    TesseractStatus { installed, chi_sim }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(AllowedPaths::default())
        .manage(PdfCache::default())
        .invoke_handler(tauri::generate_handler![
            register_allowed_path,
            extract_pdf_text_cmd,
            read_file_bytes,
            ocr_image,
            ocr_bytes,
            write_text_file,
            check_tesseract,
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
