//! What local OCR has read, kept on disk per file (14.0).
//!
//! Recognising a scanned page costs seconds of CPU, and every page of a scan
//! needs it before search, citations and highlights work there. Doing that
//! again on every open would make a 300-page scan feel new each time, so the
//! words and their boxes are written here, one JSON file per document.
//!
//! Keyed by the content fingerprint (`file_identity`), not the path: a renamed
//! or moved scan keeps what was read on it, and a rewritten file misses. The
//! fingerprint is validated into a file name here, never trusted as one — it
//! comes from the webview.
//!
//! The front end owns the format; this only stores, returns and prunes it.

use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

/// A document's cache may not exceed this. A 1,000-page scan encodes to ~20 MB.
const MAX_FILE_BYTES: usize = 48 * 1024 * 1024;
/// The whole directory is pruned back to this, least recently written first.
const MAX_DIR_BYTES: u64 = 256 * 1024 * 1024;
/// Serializes OCR cache writes and directory clears so an in-flight flush can
/// never race `ocr_cache_clear` (`remove_dir_all`) or overwrite a sibling section.
static OCR_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn lock_ocr() -> std::sync::MutexGuard<'static, ()> {
    match OCR_LOCK.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn merge_section_json(existing_raw: Option<&str>, section: &str, pages_json: &str) -> Result<Vec<u8>, String> {
    let pages_val: Value =
        serde_json::from_str(pages_json).map_err(|e| format!("Invalid OCR section JSON: {e}"))?;
    if !pages_val.is_array() {
        return Err("Invalid OCR section JSON: expected array".to_string());
    }
    let mut sections = Map::new();
    if let Some(raw) = existing_raw {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            if parsed.get("v").and_then(Value::as_u64) == Some(1) {
                if let (Some(langs), Some(pages)) = (
                    parsed.get("langs").and_then(Value::as_str),
                    parsed.get("pages").filter(|p| p.is_array()),
                ) {
                    sections.insert(langs.to_string(), pages.clone());
                }
            } else if parsed.get("v").and_then(Value::as_u64) == Some(2) {
                if let Some(obj) = parsed.get("sections").and_then(Value::as_object) {
                    for (k, v) in obj {
                        if v.is_array() {
                            sections.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
        }
    }
    sections.insert(section.to_string(), pages_val);
    let merged = json!({ "v": 2, "sections": sections });
    let bytes = serde_json::to_vec(&merged).map_err(|e| format!("Failed to encode OCR cache: {e}"))?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("OCR cache entry too large".to_string());
    }
    Ok(bytes)
}

/// `fnv1a64:<16 hex>:<length>` → `fnv1a64-<16 hex>-<length>.json`, or None.
pub fn cache_file_name(identity: &str) -> Option<String> {
    let mut parts = identity.split(':');
    let (Some("fnv1a64"), Some(hash), Some(len), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    let hex = hash.len() == 16 && hash.bytes().all(|b| b.is_ascii_hexdigit());
    let digits = !len.is_empty() && len.len() <= 20 && len.bytes().all(|b| b.is_ascii_digit());
    (hex && digits).then(|| format!("fnv1a64-{}-{len}.json", hash.to_ascii_lowercase()))
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("ocr"))
        .map_err(|e| format!("No app data directory: {e}"))
}

fn cache_path(app: &AppHandle, identity: &str) -> Result<PathBuf, String> {
    let name = cache_file_name(identity).ok_or("Invalid document identity")?;
    Ok(cache_dir(app)?.join(name))
}

/// Delete the least recently written files until the directory fits `budget`.
/// `keep` is never deleted: it is the file just written.
pub fn prune(dir: &Path, budget: u64, keep: &Path) -> std::io::Result<()> {
    let mut files: Vec<(SystemTime, u64, PathBuf)> = std::fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let path = e.path();
            let json = path.extension().is_some_and(|x| x == "json");
            (meta.is_file() && json).then(|| {
                (
                    meta.modified().unwrap_or(SystemTime::UNIX_EPOCH),
                    meta.len(),
                    path,
                )
            })
        })
        .collect();
    let mut total: u64 = files.iter().map(|f| f.1).sum();
    files.sort_by_key(|f| f.0);
    for (_, len, path) in files {
        if total <= budget {
            break;
        }
        if path == keep {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
    Ok(())
}

/// Write via a sibling temp file, fsync and a rename, so a crash mid-write
/// leaves the previous copy rather than half a JSON document — the stores'
/// own write (21.0: this one renamed an unsynced temp file).
pub fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    crate::store_io::write_atomic(path, content)
}

#[tauri::command]
pub async fn ocr_cache_read(app: AppHandle, identity: String) -> Result<Option<String>, String> {
    let path = cache_path(&app, &identity)?;
    tauri::async_runtime::spawn_blocking(move || match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read OCR cache: {e}")),
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

#[tauri::command]
pub async fn ocr_cache_write(
    app: AppHandle,
    identity: String,
    json: String,
    section: Option<String>,
) -> Result<(), String> {
    if json.len() > MAX_FILE_BYTES {
        return Err("OCR cache entry too large".to_string());
    }
    let path = cache_path(&app, &identity)?;
    let dir = cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_ocr();
        std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create OCR cache: {e}"))?;
        let payload: Vec<u8> = if let Some(sec) = section {
            let existing = match std::fs::read_to_string(&path) {
                Ok(s) => Some(s),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                Err(e) => return Err(format!("Failed to read existing OCR cache: {e}")),
            };
            merge_section_json(existing.as_deref(), &sec, &json)?
        } else {
            json.into_bytes()
        };
        write_atomic(&path, &payload)
            .map_err(|e| format!("Failed to write OCR cache: {e}"))?;
        // Best-effort: a failed prune costs disk, not correctness.
        let _ = prune(&dir, MAX_DIR_BYTES, &path);
        Ok(())
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

/// Size of the cache, in bytes and documents — for the settings panel.
#[tauri::command]
pub async fn ocr_cache_stats(app: AppHandle) -> Result<(u64, u64), String> {
    let dir = cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Ok((0, 0));
        };
        let (mut bytes, mut docs) = (0u64, 0u64);
        for e in entries.filter_map(Result::ok) {
            if let Ok(meta) = e.metadata() {
                if meta.is_file() && e.path().extension().is_some_and(|x| x == "json") {
                    bytes += meta.len();
                    docs += 1;
                }
            }
        }
        Ok((bytes, docs))
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

#[tauri::command]
pub async fn ocr_cache_clear(app: AppHandle) -> Result<(), String> {
    let dir = cache_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock_ocr();
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Failed to clear OCR cache: {e}")),
        }
    })
    .await
    .map_err(|e| format!("Task join failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_becomes_a_plain_file_name() {
        assert_eq!(
            cache_file_name("fnv1a64:00ffAA11bb22cc33:1234").as_deref(),
            Some("fnv1a64-00ffaa11bb22cc33-1234.json")
        );
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in [
            "",
            "fnv1a64:00ff:12",
            "fnv1a64:00ffaa11bb22cc3g:12",
            "fnv1a64:00ffaa11bb22cc33:",
            "fnv1a64:00ffaa11bb22cc33:12:x",
            "fnv1a64:00ffaa11bb22cc33:../x",
            "sha1:00ffaa11bb22cc33:12",
            "../../etc/passwd",
        ] {
            assert_eq!(cache_file_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn prune_drops_the_oldest_but_never_the_newest() {
        let dir = std::env::temp_dir().join(format!("pagewise-ocr-prune-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let names = ["a.json", "b.json", "c.json"];
        for (i, n) in names.iter().enumerate() {
            let p = dir.join(n);
            write_atomic(&p, &[b'x'; 100]).unwrap();
            let t = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000 + i as u64);
            std::fs::File::options()
                .write(true)
                .open(&p)
                .unwrap()
                .set_modified(t)
                .unwrap();
        }
        // The oldest is the one just written: it survives, the next oldest go.
        let keep = dir.join("a.json");
        prune(&dir, 150, &keep).unwrap();
        assert!(keep.exists());
        assert!(!dir.join("b.json").exists());
        assert!(!dir.join("c.json").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
