mod ocr;
mod pdf;
mod secrets;

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use pdf::{extract_pdf_text, PdfCache, PdfExtractResult};
use serde::Serialize;
use tauri::State;

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

#[tauri::command]
async fn register_allowed_path(path: String, state: State<'_, AllowedPaths>) -> Result<(), String> {
    let canon = canonicalize(&path)?;
    let mut set = state
        .0
        .lock()
        .map_err(|_| "allowlist lock poisoned".to_string())?;
    set.insert(canon);
    Ok(())
}

#[tauri::command]
async fn extract_pdf_text_cmd(
    path: String,
    page: Option<u32>,
    allowed: State<'_, AllowedPaths>,
    cache: State<'_, PdfCache>,
) -> Result<PdfExtractResult, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let canon_str = canon.to_str().ok_or("Invalid path encoding")?.to_string();
    let cache = cache.inner().clone();
    tauri::async_runtime::spawn_blocking(move || extract_pdf_text(&canon_str, page, &cache))
        .await
        .map_err(|e| format!("Task join failed: {e}"))?
}

#[tauri::command]
async fn read_file_bytes(path: String, allowed: State<'_, AllowedPaths>) -> Result<Vec<u8>, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&canon).map_err(|e| format!("Read failed: {e}"))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

#[tauri::command]
async fn ocr_image(path: String, allowed: State<'_, AllowedPaths>) -> Result<String, String> {
    let canon = ensure_allowed(&allowed, &path)?;
    let canon_str = canon.to_str().ok_or("Invalid path encoding")?.to_string();
    tauri::async_runtime::spawn_blocking(move || ocr::ocr_image(&canon_str))
        .await
        .map_err(|e| format!("Task join failed: {e}"))?
}

#[tauri::command]
async fn ocr_bytes(data: Vec<u8>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || ocr::ocr_bytes(data))
        .await
        .map_err(|e| format!("Task join failed: {e}"))?
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

    let authorized = {
        let set = allowed
            .0
            .lock()
            .map_err(|_| "allowlist lock poisoned".to_string())?;
        set.contains(&canon_parent) || set.contains(&canon_parent.join(file_name))
    };

    if !authorized {
        return Err("path not authorized".to_string());
    }

    let resolved = canon_parent.join(file_name);
    let canon_resolved =
        std::fs::canonicalize(&resolved).map_err(|e| format!("Invalid path: {e}"))?;

    if !canon_resolved.starts_with(&canon_parent) {
        return Err("path not authorized".to_string());
    }

    let content = content;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&canon_resolved, content.as_bytes()).map_err(|e| format!("Write failed: {e}"))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

#[derive(Debug, Clone, Serialize)]
struct TesseractStatus {
    installed: bool,
    chi_sim: bool,
}

#[tauri::command]
async fn check_tesseract() -> TesseractStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let installed = std::process::Command::new("tesseract")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        let chi_sim = installed && ocr::has_chi_sim();
        TesseractStatus { installed, chi_sim }
    })
    .await
    .unwrap_or(TesseractStatus {
        installed: false,
        chi_sim: false,
    })
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
