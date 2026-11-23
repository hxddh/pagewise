//! Lightweight, zero-dependency watcher for the single active open document (30.0).
//!
//! Why a dedicated single-file stat loop instead of an OS recursive directory
//! watcher:
//! - PageWise ever watches at most ONE granted file (the open document), and
//!   sleeps on a `Condvar` at 0% CPU whenever no document is open.
//! - Non-atomic compilers (`pdflatex`, `xelatex`, `typst`) truncate the `.pdf`
//!   to 0 bytes and stream chunks over hundreds of milliseconds. Raw `inotify`
//!   / `FSEvents` fire mid-truncation, which would reload a half-written PDF
//!   and flash `pdf-damaged`.
//! - Polling `std::fs::metadata` once every 850ms (~1 syscall) and requiring
//!   both stamp stability (300ms quiet window) and a complete `%%EOF` trailer
//!   for PDFs works identically across macOS, Windows, Linux, WSL, and network
//!   drives with zero extra crate dependencies.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::doc_check;
use crate::grants::{self, AllowedPaths};

const POLL_INTERVAL: Duration = Duration::from_millis(850);
const QUIET_WINDOW: Duration = Duration::from_millis(300);
const MAX_STABILIZE_STEPS: usize = 10;
const PDF_TAIL_WINDOW: u64 = 1024;

#[derive(Clone, Serialize)]
pub struct DocumentModifiedEvent {
    pub path: String,
    pub stamp: String,
}

struct WatchedEntry {
    canon: PathBuf,
    display_path: String,
    last_stamp: String,
}

struct WatchInner {
    state: Mutex<Option<WatchedEntry>>,
    wake: Condvar,
    worker_started: OnceLock<()>,
}

#[derive(Clone)]
pub struct ActiveFileWatch(Arc<WatchInner>);

impl Default for ActiveFileWatch {
    fn default() -> Self {
        Self(Arc::new(WatchInner {
            state: Mutex::new(None),
            wake: Condvar::new(),
            worker_started: OnceLock::new(),
        }))
    }
}

/// Check whether `path` is a non-empty file and, if it starts with `%PDF-`,
/// carries a `%%EOF` marker in its final kilobyte (not mid-compile truncated).
pub fn is_complete_document_on_disk(path: &Path) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    let len = meta.len();
    if len == 0 || len > doc_check::MAX_DOCUMENT_BYTES {
        return false;
    }
    let mut head = [0u8; 1024];
    let Ok(n_head) = file.read(&mut head) else {
        return false;
    };
    let Some(kind) = doc_check::sniff(&head[..n_head]) else {
        return false;
    };
    if kind == doc_check::DocumentKind::Pdf {
        let tail_start = len.saturating_sub(PDF_TAIL_WINDOW);
        if file.seek(SeekFrom::Start(tail_start)).is_err() {
            return false;
        }
        let mut tail = Vec::with_capacity(PDF_TAIL_WINDOW as usize);
        if file.read_to_end(&mut tail).is_err() {
            return false;
        }
        return tail.windows(5).any(|w| w == b"%%EOF");
    }
    true
}

impl ActiveFileWatch {
    pub fn watch(&self, app: &AppHandle, canon: PathBuf, stamp: String) {
        self.ensure_worker(app.clone());
        let display_path = grants::for_front_end(&canon);
        let mut guard = match self.0.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        *guard = Some(WatchedEntry {
            canon,
            display_path,
            last_stamp: stamp,
        });
        self.0.wake.notify_all();
    }

    pub fn unwatch_if_matches(&self, canon: &Path) {
        let key = doc_check::clean_path_key(canon);
        let mut guard = match self.0.state.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if guard
            .as_ref()
            .is_some_and(|w| doc_check::clean_path_key(&w.canon) == key)
        {
            *guard = None;
            self.0.wake.notify_all();
        }
    }

    fn ensure_worker(&self, app: AppHandle) {
        let inner = Arc::clone(&self.0);
        self.0.worker_started.get_or_init(move || {
            let _ = std::thread::Builder::new()
                .name("pagewise-file-watch".into())
                .spawn(move || worker_loop(inner, app));
        });
    }
}

fn worker_loop(inner: Arc<WatchInner>, app: AppHandle) {
    loop {
        let snapshot = {
            let mut guard = match inner.state.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            while guard.is_none() {
                guard = match inner.wake.wait(guard) {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
            }
            let (guard, _) = match inner.wake.wait_timeout(guard, POLL_INTERVAL) {
                Ok(pair) => pair,
                Err(p) => p.into_inner(),
            };
            guard.as_ref().map(|w| (w.canon.clone(), w.display_path.clone(), w.last_stamp.clone()))
        };

        let Some((canon, display_path, known_stamp)) = snapshot else {
            continue;
        };

        let Ok(meta) = std::fs::metadata(&canon) else {
            continue;
        };
        let Ok(mut candidate_stamp) = doc_check::stamp_of_meta(&meta) else {
            continue;
        };
        if candidate_stamp == known_stamp {
            continue;
        }

        // Wait for writer quiescence + valid trailer before notifying UI.
        let mut ready = false;
        for _ in 0..MAX_STABILIZE_STEPS {
            std::thread::sleep(QUIET_WINDOW);
            // Abort early if the user switched or closed the document meanwhile.
            let still_watching = {
                let guard = match inner.state.lock() {
                    Ok(g) => g,
                    Err(p) => p.into_inner(),
                };
                guard
                    .as_ref()
                    .is_some_and(|w| w.canon == canon && w.last_stamp == known_stamp)
            };
            if !still_watching {
                break;
            }
            let Ok(next_meta) = std::fs::metadata(&canon) else {
                break;
            };
            let Ok(next_stamp) = doc_check::stamp_of_meta(&next_meta) else {
                break;
            };
            if next_stamp == candidate_stamp && is_complete_document_on_disk(&canon) {
                ready = true;
                break;
            }
            candidate_stamp = next_stamp;
        }

        if !ready {
            continue;
        }

        let should_emit = {
            let mut guard = match inner.state.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if let Some(w) = guard.as_mut() {
                if w.canon == canon && w.last_stamp != candidate_stamp {
                    w.last_stamp = candidate_stamp.clone();
                    true
                } else {
                    false
                }
            } else {
                false
            }
        };

        if should_emit {
            let _ = app.emit(
                "pagewise://document-modified",
                DocumentModifiedEvent {
                    path: display_path,
                    stamp: candidate_stamp,
                },
            );
        }
    }
}

#[tauri::command]
pub fn watch_document_cmd(
    path: String,
    stamp: String,
    app: AppHandle,
    allowed: State<'_, AllowedPaths>,
    watcher: State<'_, ActiveFileWatch>,
) -> Result<(), String> {
    let canon = crate::ensure_allowed(&allowed, &path)?;
    watcher.watch(&app, canon, stamp);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn complete_pdf_requires_eof_trailer_while_truncated_pdf_waits() {
        let dir = std::env::temp_dir().join(format!("pagewise-watch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let pdf = dir.join("draft.pdf");

        // Mid-compile truncated PDF (has header, missing %%EOF): must NOT trigger reload.
        std::fs::File::create(&pdf)
            .unwrap()
            .write_all(b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n")
            .unwrap();
        assert!(!is_complete_document_on_disk(&pdf));

        // Finished PDF with %%EOF: ready for hot reload.
        std::fs::File::create(&pdf)
            .unwrap()
            .write_all(b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\n%%EOF\n")
            .unwrap();
        assert!(is_complete_document_on_disk(&pdf));

        // Empty 0-byte truncated file: never ready.
        std::fs::File::create(&pdf).unwrap();
        assert!(!is_complete_document_on_disk(&pdf));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
