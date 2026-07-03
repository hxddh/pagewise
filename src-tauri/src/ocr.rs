use std::io::Write;
use std::process::Command;

const TESSERACT_HINT: &str = "Install Tesseract: brew install tesseract tesseract-lang";

fn run_tesseract_on_path(path: &str) -> Result<String, String> {
    let output = Command::new("tesseract")
        .arg(path)
        .arg("stdout")
        .arg("-l")
        .arg("eng+chi_sim")
        .output()
        .map_err(|e| format!("{TESSERACT_HINT} ({e})"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Tesseract failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn ocr_image(path: &str) -> Result<String, String> {
    if !std::path::Path::new(path).exists() {
        return Err(format!("File not found: {path}"));
    }
    run_tesseract_on_path(path)
}

pub fn ocr_bytes(data: Vec<u8>) -> Result<String, String> {
    let img = image::load_from_memory(&data).map_err(|e| format!("Invalid image bytes: {e}"))?;

    let mut tmp = tempfile::Builder::new()
        .prefix("pagewise-ocr-")
        .suffix(".png")
        .tempfile()
        .map_err(|e| format!("Failed to create temp file: {e}"))?;

    img.write_to(&mut tmp, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to write temp image: {e}"))?;

    tmp.flush()
        .map_err(|e| format!("Failed to flush temp image: {e}"))?;

    let path = tmp.path().to_string_lossy().to_string();
    run_tesseract_on_path(&path)
}
