use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
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

/// Cap on cached documents, mirroring the frontend docCache bound so a long
/// session cannot grow native memory without limit.
const MAX_CACHED_DOCS: usize = 12;

#[derive(Default)]
struct CacheInner {
    map: HashMap<PathBuf, (SystemTime, Arc<Vec<String>>)>,
    /// LRU order (oldest first) used for eviction.
    order: Vec<PathBuf>,
}

impl CacheInner {
    fn touch(&mut self, key: &PathBuf) {
        if !self.map.contains_key(key) {
            return;
        }
        self.order.retain(|k| k != key);
        self.order.push(key.clone());
    }

    fn get(&mut self, key: &PathBuf) -> Option<(SystemTime, Arc<Vec<String>>)> {
        if self.map.contains_key(key) {
            self.touch(key);
        }
        self.map.get(key).cloned()
    }

    fn insert(&mut self, key: PathBuf, mtime: SystemTime, pages: Arc<Vec<String>>) {
        if self.map.insert(key.clone(), (mtime, pages)).is_none() {
            self.order.push(key.clone());
        } else {
            self.touch(&key);
        }
        while self.map.len() > MAX_CACHED_DOCS {
            if self.order.is_empty() {
                break;
            }
            let oldest = self.order.remove(0);
            self.map.remove(&oldest);
        }
    }
}

#[derive(Clone)]
pub struct PdfCache(Arc<Mutex<CacheInner>>);

impl Default for PdfCache {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(CacheInner::default())))
    }
}

impl PdfCache {
    fn lock_map(&self) -> Result<std::sync::MutexGuard<'_, CacheInner>, String> {
        self.0.lock().map_err(|_| "PDF cache lock poisoned".to_string())
    }
}

fn parse_pages(path: &str, cache: &PdfCache) -> Result<Arc<Vec<String>>, String> {
    let key = PathBuf::from(path);
    let mtime = std::fs::metadata(&key)
        .and_then(|m| m.modified())
        .map_err(|e| format!("Failed to read PDF metadata: {e}"))?;

    {
        let mut guard = cache.lock_map()?;
        if let Some((cached_mtime, cached_pages)) = guard.get(&key) {
            if cached_mtime == mtime {
                return Ok(cached_pages);
            }
        }
    }

    let pages_raw =
        pdf_extract::extract_text_by_pages(path).map_err(|e| format!("PDF extract failed: {e}"))?;
    let arc = Arc::new(pages_raw);

    let mut guard = cache.lock_map()?;
    if let Some((cached_mtime, cached_pages)) = guard.get(&key) {
        if cached_mtime == mtime {
            return Ok(cached_pages);
        }
    }
    guard.insert(key, mtime, Arc::clone(&arc));
    Ok(arc)
}

pub fn extract_pdf_text(
    path: &str,
    page: Option<u32>,
    cache: &PdfCache,
) -> Result<PdfExtractResult, String> {
    let pages_raw = parse_pages(path, cache)?;
    let total_pages = pages_raw.len() as u32;

    let pages: Vec<PageText> = match page {
        Some(p) if p >= 1 && (p as usize) <= pages_raw.len() => {
            vec![PageText {
                page: p,
                text: pages_raw[(p - 1) as usize].clone(),
            }]
        }
        Some(p) => {
            return Err(format!("Page {p} out of range (1-{total_pages})"));
        }
        None => pages_raw
            .iter()
            .enumerate()
            .map(|(idx, text)| PageText {
                page: (idx + 1) as u32,
                text: text.clone(),
            })
            .collect(),
    };

    Ok(PdfExtractResult { pages, total_pages })
}
