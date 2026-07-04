mod ocr;
mod pdf;
mod secrets;

use pdf::{extract_pdf_text, PdfExtractResult};

#[tauri::command]
fn extract_pdf_text_cmd(path: String, page: Option<u32>) -> Result<PdfExtractResult, String> {
    extract_pdf_text(&path, page)
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Read failed: {e}"))
}

#[tauri::command]
fn ocr_image(path: String) -> Result<String, String> {
    ocr::ocr_image(&path)
}

#[tauri::command]
fn ocr_bytes(data: Vec<u8>) -> Result<String, String> {
    ocr::ocr_bytes(data)
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| format!("Write failed: {e}"))
}

#[tauri::command]
fn check_tesseract() -> bool {
    std::process::Command::new("tesseract")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
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
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
