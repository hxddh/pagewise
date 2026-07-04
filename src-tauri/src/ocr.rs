use std::io::{Cursor, Write};
use std::process::Command;

use image::{ImageReader, Limits};

const TESSERACT_HINT: &str = "Install Tesseract: brew install tesseract tesseract-lang";

// Decode guardrails to avoid OOM from decompression-bomb / maliciously huge
// images. Dimensions cover typical scanned pages with wide headroom; the
// allocation cap bounds total decode memory.
const MAX_IMAGE_DIM: u32 = 20_000;
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024; // 512 MiB

/// Return the list of tesseract language codes available on this machine.
fn available_langs() -> Vec<String> {
    let output = match Command::new("tesseract").arg("--list-langs").output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    // First line is a header ("List of available languages ...").
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// Whether the Simplified Chinese language pack is installed.
pub fn has_chi_sim() -> bool {
    available_langs().iter().any(|l| l == "chi_sim")
}

/// Choose the OCR language string. Falls back to English only when the
/// Simplified Chinese pack is missing, so OCR still works rather than failing.
fn ocr_lang() -> &'static str {
    if has_chi_sim() {
        "eng+chi_sim"
    } else {
        "eng"
    }
}

fn run_tesseract_on_path(path: &str) -> Result<String, String> {
    let output = Command::new("tesseract")
        .arg(path)
        .arg("stdout")
        .arg("-l")
        .arg(ocr_lang())
        .output()
        .map_err(|e| format!("{TESSERACT_HINT} ({e})"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Tesseract failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Decode image bytes with size/allocation limits enforced.
fn decode_limited(data: &[u8]) -> Result<image::DynamicImage, String> {
    let mut reader = ImageReader::new(Cursor::new(data))
        .with_guessed_format()
        .map_err(|e| format!("Invalid image bytes: {e}"))?;

    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIM);
    limits.max_image_height = Some(MAX_IMAGE_DIM);
    limits.max_alloc = Some(MAX_DECODE_ALLOC);
    reader.limits(limits);

    reader
        .decode()
        .map_err(|e| format!("Invalid or oversized image: {e}"))
}

pub fn ocr_image(path: &str) -> Result<String, String> {
    if !std::path::Path::new(path).exists() {
        return Err(format!("File not found: {path}"));
    }
    let data = std::fs::read(path).map_err(|e| format!("Failed to read image: {e}"))?;
    ocr_bytes(data)
}

pub fn ocr_bytes(data: Vec<u8>) -> Result<String, String> {
    let img = decode_limited(&data)?;

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
