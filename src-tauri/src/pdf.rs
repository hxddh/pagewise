use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

#[derive(Debug, Clone, Serialize)]
pub struct PageText {
    pub page: u32,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PdfExtractResult {
    pub pages: Vec<PageText>,
    pub total_pages: u32,
}

/// Per-path cache of the fully parsed page texts, keyed by path and keyed
/// (invalidated) by the file's last-modified time. This avoids re-parsing the
/// entire document on every single-page request (previously O(N) parses for N
/// single-page reads of the same file).
#[derive(Default)]
pub struct PdfCache(Mutex<HashMap<PathBuf, (SystemTime, Vec<String>)>>);

fn parse_pages(path: &str, cache: &PdfCache) -> Result<Vec<String>, String> {
    let key = PathBuf::from(path);
    let mtime = std::fs::metadata(&key)
        .and_then(|m| m.modified())
        .map_err(|e| format!("Failed to read PDF metadata: {e}"))?;

    let mut guard = cache
        .0
        .lock()
        .map_err(|_| "PDF cache lock poisoned".to_string())?;

    if let Some((cached_mtime, cached_pages)) = guard.get(&key) {
        if *cached_mtime == mtime {
            return Ok(cached_pages.clone());
        }
    }

    let pages_raw =
        pdf_extract::extract_text_by_pages(path).map_err(|e| format!("PDF extract failed: {e}"))?;

    guard.insert(key, (mtime, pages_raw.clone()));
    Ok(pages_raw)
}

pub fn extract_pdf_text(
    path: &str,
    page: Option<u32>,
    cache: &PdfCache,
) -> Result<PdfExtractResult, String> {
    let pages_raw = parse_pages(path, cache)?;

    let all_pages: Vec<PageText> = pages_raw
        .into_iter()
        .enumerate()
        .map(|(idx, text)| PageText {
            page: (idx + 1) as u32,
            text,
        })
        .collect();

    let total_pages = all_pages.len() as u32;

    let pages = match page {
        // Guard the requested index against the actual parsed page count.
        Some(p) if p >= 1 && (p as usize) <= all_pages.len() => {
            vec![all_pages[(p - 1) as usize].clone()]
        }
        Some(p) => {
            return Err(format!("Page {p} out of range (1-{total_pages})"));
        }
        None => all_pages,
    };

    Ok(PdfExtractResult { pages, total_pages })
}
