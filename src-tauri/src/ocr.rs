use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use image::{ImageReader, Limits};

const TESSERACT_HINT: &str = "Install Tesseract: brew install tesseract tesseract-lang";

const MAX_IMAGE_DIM: u32 = 20_000;
const MAX_DECODE_ALLOC: u64 = 512 * 1024 * 1024;
const TESSERACT_TIMEOUT: Duration = Duration::from_secs(120);

static OCR_LANG: OnceLock<String> = OnceLock::new();
static CHI_SIM: OnceLock<bool> = OnceLock::new();

fn available_langs() -> Vec<String> {
    let output = match Command::new("tesseract").arg("--list-langs").output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

pub fn has_chi_sim() -> bool {
    *CHI_SIM.get_or_init(|| available_langs().iter().any(|l| l == "chi_sim"))
}

fn ocr_lang() -> &'static str {
    OCR_LANG.get_or_init(|| {
        if has_chi_sim() {
            "eng+chi_sim".to_string()
        } else {
            "eng".to_string()
        }
    })
}

fn run_tesseract_stdin(data: &[u8]) -> Result<String, String> {
    let mut child = Command::new("tesseract")
        .arg("stdin")
        .arg("stdout")
        .arg("-l")
        .arg(ocr_lang())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{TESSERACT_HINT} ({e})"))?;

    {
        let stdin = child.stdin.take();
        let write_result = if let Some(mut stdin) = stdin {
            stdin
                .write_all(data)
                .map_err(|e| format!("Failed to write tesseract stdin: {e}"))
        } else {
            Err("Failed to open tesseract stdin".to_string())
        };
        if let Err(e) = write_result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    }

    let deadline = Instant::now() + TESSERACT_TIMEOUT;
    let output = loop {
        match child.try_wait() {
            Ok(Some(_status)) => break child
                .wait_with_output()
                .map_err(|e| format!("Tesseract failed: {e}"))?,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Tesseract timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Tesseract failed: {e}"));
            }
        }
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Tesseract failed: {stderr}"));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn decode_limited(data: &[u8]) -> Result<image::DynamicImage, String> {
    let mut reader = ImageReader::new(std::io::Cursor::new(data))
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
    let meta = std::fs::metadata(path).map_err(|e| format!("Failed to read image: {e}"))?;
    if meta.len() > MAX_DECODE_ALLOC {
        return Err(format!("Image file too large (>{MAX_DECODE_ALLOC} bytes)"));
    }
    let data = std::fs::read(path).map_err(|e| format!("Failed to read image: {e}"))?;
    ocr_bytes(data)
}

pub fn ocr_bytes(data: Vec<u8>) -> Result<String, String> {
    // Try stdin pipeline first (no temp file).
    if let Ok(text) = run_tesseract_stdin(&data) {
        if !text.is_empty() {
            return Ok(text);
        }
    }

    // Fallback: decode + temp PNG for formats tesseract stdin rejects.
    let img = decode_limited(&data)?;
    let mut png_bytes: Vec<u8> = Vec::new();
    img.write_to(
        &mut std::io::Cursor::new(&mut png_bytes),
        image::ImageFormat::Png,
    )
    .map_err(|e| format!("Failed to encode image: {e}"))?;

    run_tesseract_stdin(&png_bytes)
}
