use pdf_extract::{output_doc_page, Document, PlainTextOutput};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PdfExtractScope {
    Load,
    Agent,
}

impl PdfExtractScope {
    pub fn parse(s: &str) -> Self {
        match s {
            "agent" => PdfExtractScope::Agent,
            _ => PdfExtractScope::Load,
        }
    }
}

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

/// Per-scope cancel generations — load abort must not kill agent tool reads.
#[derive(Clone, Default)]
pub struct PdfExtractCancel {
    load: Arc<AtomicU64>,
    agent: Arc<AtomicU64>,
}

impl PdfExtractCancel {
    pub fn bump_scope(&self, scope: PdfExtractScope) {
        let atom = match scope {
            PdfExtractScope::Load => &self.load,
            PdfExtractScope::Agent => &self.agent,
        };
        atom.fetch_add(1, Ordering::SeqCst);
    }

    pub fn capture(&self, scope: PdfExtractScope) -> u64 {
        let atom = match scope {
            PdfExtractScope::Load => &self.load,
            PdfExtractScope::Agent => &self.agent,
        };
        atom.load(Ordering::SeqCst)
    }

    fn is_stale(&self, scope: PdfExtractScope, captured: u64) -> bool {
        self.capture(scope) != captured
    }
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
        self.0
            .lock()
            .map_err(|_| "PDF cache lock poisoned".to_string())
    }
}

fn map_pdf_err(e: impl std::fmt::Display) -> String {
    format!("PDF extract failed: {e}")
}

fn cancelled() -> String {
    "PDF extract cancelled".to_string()
}

fn decrypt_if_needed(doc: &mut Document) -> Result<(), String> {
    if !doc.is_encrypted() {
        return Ok(());
    }
    doc.decrypt("")
        .map_err(|e| format!("Encrypted PDF requires a password: {e}"))
}

fn load_document(path: &str) -> Result<Document, String> {
    let mut doc = Document::load(path).map_err(map_pdf_err)?;
    decrypt_if_needed(&mut doc)?;
    Ok(doc)
}

fn page_count(doc: &Document) -> u32 {
    doc.get_pages().len() as u32
}

fn extract_page_text(doc: &Document, page: u32) -> Result<String, String> {
    let mut s = String::new();
    {
        let mut output = PlainTextOutput::new(&mut s);
        output_doc_page(doc, &mut output, page).map_err(map_pdf_err)?;
    }
    Ok(s)
}

fn file_mtime(path: &str) -> Result<SystemTime, String> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .map_err(|e| format!("Failed to read PDF metadata: {e}"))
}

fn cached_pages(path: &str, cache: &PdfCache) -> Result<Option<Arc<Vec<String>>>, String> {
    let key = PathBuf::from(path);
    let mtime = file_mtime(path)?;
    let mut guard = cache.lock_map()?;
    if let Some((cached_mtime, cached_pages)) = guard.get(&key) {
        if cached_mtime == mtime {
            return Ok(Some(cached_pages));
        }
    }
    Ok(None)
}

fn parse_all_pages(
    path: &str,
    cache: &PdfCache,
    cancel: &PdfExtractCancel,
    scope: PdfExtractScope,
    gen: u64,
) -> Result<Arc<Vec<String>>, String> {
    if cancel.is_stale(scope, gen) {
        return Err(cancelled());
    }

    if let Some(cached) = cached_pages(path, cache)? {
        return Ok(cached);
    }

    let doc = load_document(path)?;
    if cancel.is_stale(scope, gen) {
        return Err(cancelled());
    }

    let total = page_count(&doc);
    let mut pages_raw = Vec::with_capacity(total as usize);
    for page in 1..=total {
        if cancel.is_stale(scope, gen) {
            return Err(cancelled());
        }
        pages_raw.push(extract_page_text(&doc, page)?);
    }

    let key = PathBuf::from(path);
    let mtime = file_mtime(path)?;
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

fn extract_single_page(
    path: &str,
    page: u32,
    cancel: &PdfExtractCancel,
    scope: PdfExtractScope,
    gen: u64,
) -> Result<PdfExtractResult, String> {
    if cancel.is_stale(scope, gen) {
        return Err(cancelled());
    }

    let doc = load_document(path)?;
    if cancel.is_stale(scope, gen) {
        return Err(cancelled());
    }

    let total_pages = page_count(&doc);
    if page < 1 || page > total_pages {
        return Err(format!("Page {page} out of range (1-{total_pages})"));
    }

    let text = extract_page_text(&doc, page)?;
    if cancel.is_stale(scope, gen) {
        return Err(cancelled());
    }

    Ok(PdfExtractResult {
        pages: vec![PageText { page, text }],
        total_pages,
    })
}

pub fn pdf_page_count(
    path: &str,
    cancel: &PdfExtractCancel,
    scope: PdfExtractScope,
    gen: u64,
) -> Result<u32, String> {
    if cancel.is_stale(scope, gen) {
        return Err(cancelled());
    }
    let doc = load_document(path)?;
    if cancel.is_stale(scope, gen) {
        return Err(cancelled());
    }
    Ok(page_count(&doc))
}

pub fn extract_pdf_text(
    path: &str,
    page: Option<u32>,
    cache: &PdfCache,
    cancel: &PdfExtractCancel,
    scope: PdfExtractScope,
    gen: u64,
) -> Result<PdfExtractResult, String> {
    if cancel.is_stale(scope, gen) {
        return Err(cancelled());
    }

    match page {
        Some(p) => {
            if let Some(pages_raw) = cached_pages(path, cache)? {
                if p >= 1 && (p as usize) <= pages_raw.len() {
                    return Ok(PdfExtractResult {
                        pages: vec![PageText {
                            page: p,
                            text: pages_raw[(p - 1) as usize].clone(),
                        }],
                        total_pages: pages_raw.len() as u32,
                    });
                }
            }
            extract_single_page(path, p, cancel, scope, gen)
        }
        None => {
            let pages_raw = parse_all_pages(path, cache, cancel, scope, gen)?;
            let total_pages = pages_raw.len() as u32;
            let pages = pages_raw
                .iter()
                .enumerate()
                .map(|(idx, text)| PageText {
                    page: (idx + 1) as u32,
                    text: text.clone(),
                })
                .collect();
            Ok(PdfExtractResult { pages, total_pages })
        }
    }
}
