use std::collections::{BTreeMap, BTreeSet};
#[cfg(any(target_os = "macos", test))]
use std::io::Write;
#[cfg(any(target_os = "macos", test))]
use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
#[cfg(any(target_os = "macos", test))]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Manager;

const SERVICE: &str = "pagewise";
#[cfg(any(not(target_os = "macos"), test))]
const VAULT_ACCOUNT: &str = "api-keys-v2";
/// Stored under `app_data_dir` on macOS ad-hoc builds (27.0, Scheme A).
/// Deliberately NOT `.json`: `store_io::store_file_name` rejects non-`.json`
/// names, so no script in the webview can read or write this file directly.
#[cfg(any(target_os = "macos", test))]
pub(crate) const VAULT_FILE_NAME: &str = "api-keys.vault";

/// Providers the frontend is allowed to store keys for. Rejecting anything else
/// avoids junk/typo entries piling up in the credential store.
const KNOWN_PROVIDERS: &[&str] = &["openai", "deepseek", "openrouter", "ollama", "custom"];
/// Upper bound on a single API key so the consolidated Windows Credential
/// Manager `CRED_MAX_CREDENTIAL_BLOB_SIZE` (2,560 bytes) is never overrun by an
/// accidental clipboard paste (28.0).
const MAX_API_KEY_BYTES: usize = 2048;

/// Process-wide mutex serializing all credential reads/writes so concurrent
/// `spawn_blocking` callers never race on vault updates or stack duplicate OS
/// keychain prompts.
static VAULT_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
#[cfg(any(target_os = "macos", test))]
static VAULT_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct VaultPayload {
    #[serde(default)]
    keys: BTreeMap<String, String>,
    #[serde(default)]
    migrated: BTreeSet<String>,
}

fn lock_vault() -> std::sync::MutexGuard<'static, ()> {
    match VAULT_LOCK.lock() {
        Ok(g) => g,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn validate_provider(provider: &str) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("Provider must not be empty".to_string());
    }
    if !KNOWN_PROVIDERS.contains(&provider) {
        return Err(format!("Unknown provider: {provider}"));
    }
    Ok(())
}

fn legacy_entry(provider: &str) -> Result<Entry, String> {
    validate_provider(provider)?;
    Entry::new(SERVICE, &format!("api-key/{provider}")).map_err(|e| e.to_string())
}

#[cfg(any(not(target_os = "macos"), test))]
fn vault_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, VAULT_ACCOUNT).map_err(|e| e.to_string())
}

#[cfg(any(target_os = "macos", test))]
fn vault_backup_path(path: &Path) -> std::path::PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(".bak");
    std::path::PathBuf::from(os)
}

#[cfg(any(target_os = "macos", test))]
fn read_vault_file(path: &Path) -> Result<VaultPayload, String> {
    match std::fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<VaultPayload>(&bytes) {
            Ok(v) => Ok(v),
            Err(primary_err) => {
                // Fall back to rolling `.bak` when the primary vault was corrupted externally (30.0).
                let bak = vault_backup_path(path);
                if let Ok(bak_bytes) = std::fs::read(&bak) {
                    if let Ok(recovered) = serde_json::from_slice::<VaultPayload>(&bak_bytes) {
                        let _ = write_vault_file(path, &recovered);
                        return Ok(recovered);
                    }
                }
                Err(format!(
                    "Corrupt credential vault {}: {primary_err}",
                    path.display()
                ))
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let bak = vault_backup_path(path);
            if let Ok(bak_bytes) = std::fs::read(&bak) {
                if let Ok(recovered) = serde_json::from_slice::<VaultPayload>(&bak_bytes) {
                    let _ = write_vault_file(path, &recovered);
                    return Ok(recovered);
                }
            }
            Ok(VaultPayload::default())
        }
        Err(e) => Err(format!("Failed to read credential vault {}: {e}", path.display())),
    }
}

#[cfg(any(target_os = "macos", test))]
fn read_vault_file_for_mutation(path: &Path) -> Result<VaultPayload, String> {
    match read_vault_file(path) {
        Ok(v) => Ok(v),
        // Never permanently lock the user out of Settings when overwriting or deleting
        // a key on a corrupted vault that has no valid `.bak` (30.0).
        Err(e) if e.starts_with("Corrupt credential vault") => Ok(VaultPayload::default()),
        Err(e) => Err(e),
    }
}

#[cfg(any(target_os = "macos", test))]
fn write_vault_file(path: &Path, payload: &VaultPayload) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create credential directory: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
    }
    // Preserve last known-good vault in `.bak` (`0600`) before replacing `path`.
    if let Ok(existing) = std::fs::read(path) {
        if serde_json::from_slice::<VaultPayload>(&existing).is_ok() {
            let bak = vault_backup_path(path);
            let mut bak_opts = std::fs::OpenOptions::new();
            bak_opts.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                bak_opts.mode(0o600);
            }
            if let Ok(mut bf) = bak_opts.open(&bak) {
                let _ = bf.write_all(&existing).and_then(|()| bf.sync_all());
            }
        }
    }
    let bytes =
        serde_json::to_vec(payload).map_err(|e| format!("Vault serialize failed: {e}"))?;
    let seq = VAULT_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    // Uses `store_io`'s `.pagewise-<pid>-<n>.tmp` format numbered from `2 << 40`
    // so `store_io::sweep_stale_temps` purges any crashed vault temp at launch (28.0).
    let tmp = parent.join(format!(
        ".pagewise-{}-{}.tmp",
        std::process::id(),
        (2u64 << 40) + seq
    ));

    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut file = opts
        .open(&tmp)
        .map_err(|e| format!("Failed to open temp vault: {e}"))?;
    if let Err(e) = file.write_all(&bytes).and_then(|()| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Failed to write credential vault: {e}"));
    }
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    let mut attempt = 0u32;
    let renamed = loop {
        match std::fs::rename(&tmp, path) {
            Ok(()) => break Ok(()),
            Err(e)
                if cfg!(windows)
                    && e.kind() == std::io::ErrorKind::PermissionDenied
                    && attempt < 4 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(5 << attempt));
                attempt += 1;
            }
            Err(e) => break Err(e),
        }
    };
    if let Err(e) = renamed {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("Failed to commit credential vault: {e}"));
    }
    if let Ok(dir) = std::fs::File::open(parent) {
        let _ = dir.sync_all();
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn set_file_vault_key(dir: &Path, provider: &str, key: &str) -> Result<(), String> {
    validate_provider(provider)?;
    if key.len() > MAX_API_KEY_BYTES {
        return Err("API key exceeds maximum length".to_string());
    }
    let _guard = lock_vault();
    let path = dir.join(VAULT_FILE_NAME);
    let mut vault = read_vault_file_for_mutation(&path)?;
    vault.keys.insert(provider.to_string(), key.to_string());
    vault.migrated.insert(provider.to_string());
    write_vault_file(&path, &vault)
}

#[cfg(any(target_os = "macos", test))]
fn get_file_vault_key<L, D>(
    dir: &Path,
    provider: &str,
    legacy_lookup: L,
    legacy_delete: D,
) -> Result<String, String>
where
    L: FnOnce(&str) -> Result<Option<String>, String>,
    D: FnOnce(&str),
{
    validate_provider(provider)?;
    let _guard = lock_vault();
    let path = dir.join(VAULT_FILE_NAME);
    let mut vault = read_vault_file(&path)?;
    if let Some(existing) = vault.keys.get(provider) {
        return Ok(existing.clone());
    }
    if vault.migrated.contains(provider) {
        return Ok(String::new());
    }
    match legacy_lookup(provider)? {
        Some(found) => {
            if !found.is_empty() {
                vault.keys.insert(provider.to_string(), found.clone());
            }
            vault.migrated.insert(provider.to_string());
            // Persist the migrated key to `api-keys.vault` BEFORE deleting the
            // legacy Keychain item so a failed disk write never destroys the
            // only stored copy of the credential.
            write_vault_file(&path, &vault)?;
            legacy_delete(provider);
            Ok(found)
        }
        None => {
            vault.migrated.insert(provider.to_string());
            write_vault_file(&path, &vault)?;
            Ok(String::new())
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn delete_file_vault_key<F>(dir: &Path, provider: &str, legacy_delete: F) -> Result<(), String>
where
    F: FnOnce(&str),
{
    validate_provider(provider)?;
    let _guard = lock_vault();
    let path = dir.join(VAULT_FILE_NAME);
    let mut vault = read_vault_file_for_mutation(&path)?;
    let already_migrated = vault.migrated.contains(provider);
    vault.keys.remove(provider);
    vault.migrated.insert(provider.to_string());
    write_vault_file(&path, &vault)?;
    if !already_migrated {
        legacy_delete(provider);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn legacy_keychain_lookup(provider: &str) -> Result<Option<String>, String> {
    let entry = legacy_entry(provider)?;
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(target_os = "macos")]
fn legacy_keychain_delete(provider: &str) {
    if let Ok(entry) = legacy_entry(provider) {
        let _ = entry.delete_credential();
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn read_keychain_vault() -> Result<VaultPayload, String> {
    match vault_entry()?.get_password() {
        Ok(raw) => {
            serde_json::from_str(&raw).map_err(|e| format!("Corrupt credential vault: {e}"))
        }
        Err(keyring::Error::NoEntry) => Ok(VaultPayload::default()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn write_keychain_vault(vault: &VaultPayload) -> Result<(), String> {
    let raw = serde_json::to_string(vault).map_err(|e| e.to_string())?;
    vault_entry()?.set_password(&raw).map_err(|e| e.to_string())
}

#[cfg(any(not(target_os = "macos"), test))]
fn read_keychain_vault_for_mutation() -> Result<VaultPayload, String> {
    match read_keychain_vault() {
        Ok(v) => Ok(v),
        Err(e) if e.starts_with("Corrupt credential vault") => Ok(VaultPayload::default()),
        Err(e) => Err(e),
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn set_keychain_key_impl(provider: &str, key: &str) -> Result<(), String> {
    validate_provider(provider)?;
    if key.len() > MAX_API_KEY_BYTES {
        return Err("API key exceeds maximum length".to_string());
    }
    let _guard = lock_vault();
    let mut vault = read_keychain_vault_for_mutation()?;
    vault.keys.insert(provider.to_string(), key.to_string());
    vault.migrated.insert(provider.to_string());
    write_keychain_vault(&vault)
}

#[cfg(any(not(target_os = "macos"), test))]
fn get_keychain_key_impl(provider: &str) -> Result<String, String> {
    validate_provider(provider)?;
    let _guard = lock_vault();
    let mut vault = read_keychain_vault()?;
    if let Some(existing) = vault.keys.get(provider) {
        return Ok(existing.clone());
    }
    if vault.migrated.contains(provider) {
        return Ok(String::new());
    }
    let legacy = legacy_entry(provider)?;
    match legacy.get_password() {
        Ok(found) => {
            if !found.is_empty() {
                vault.keys.insert(provider.to_string(), found.clone());
            }
            vault.migrated.insert(provider.to_string());
            write_keychain_vault(&vault)?;
            let _ = legacy.delete_credential();
            Ok(found)
        }
        Err(keyring::Error::NoEntry) => {
            vault.migrated.insert(provider.to_string());
            let _ = write_keychain_vault(&vault);
            Ok(String::new())
        }
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(any(not(target_os = "macos"), test))]
fn delete_keychain_key_impl(provider: &str) -> Result<(), String> {
    validate_provider(provider)?;
    let _guard = lock_vault();
    let mut vault = read_keychain_vault_for_mutation()?;
    let already_migrated = vault.migrated.contains(provider);
    vault.keys.remove(provider);
    vault.migrated.insert(provider.to_string());
    if vault.keys.is_empty() {
        match vault_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    } else {
        write_keychain_vault(&vault)?;
    }
    if !already_migrated {
        if let Ok(legacy) = legacy_entry(provider) {
            let _ = legacy.delete_credential();
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn app_vault_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("No app data directory: {e}"))
}

// Credential access runs off the main thread so disk fsync (macOS) or a Secret
// Service DBus round-trip (Linux) never freezes the window.
#[tauri::command]
pub async fn set_api_key(app: AppHandle, provider: String, key: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let dir = app_vault_dir(&app)?;
    #[cfg(not(target_os = "macos"))]
    let _ = &app;

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            set_file_vault_key(&dir, &provider, &key)
        }
        #[cfg(not(target_os = "macos"))]
        {
            set_keychain_key_impl(&provider, &key)
        }
    })
    .await
    .map_err(|e| format!("keychain task failed: {e}"))?
}

#[tauri::command]
pub async fn get_api_key(app: AppHandle, provider: String) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    let dir = app_vault_dir(&app)?;
    #[cfg(not(target_os = "macos"))]
    let _ = &app;

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            get_file_vault_key(&dir, &provider, legacy_keychain_lookup, legacy_keychain_delete)
        }
        #[cfg(not(target_os = "macos"))]
        {
            get_keychain_key_impl(&provider)
        }
    })
    .await
    .map_err(|e| format!("keychain task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_api_key(app: AppHandle, provider: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let dir = app_vault_dir(&app)?;
    #[cfg(not(target_os = "macos"))]
    let _ = &app;

    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            delete_file_vault_key(&dir, &provider, legacy_keychain_delete)
        }
        #[cfg(not(target_os = "macos"))]
        {
            delete_keychain_key_impl(&provider)
        }
    })
    .await
    .map_err(|e| format!("keychain task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn keychain_unavailable(err: &str) -> bool {
        err.contains("org.freedesktop.secrets") || err.contains("No default store")
    }

    #[test]
    fn file_vault_roundtrip_permissions_and_one_shot_legacy_migration() {
        let dir = std::env::temp_dir().join(format!("pagewise-vault-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);

        let legacy_calls = AtomicUsize::new(0);
        let legacy_deletes = AtomicUsize::new(0);
        // First read imports from legacy once, persists to `api-keys.vault`, then deletes legacy.
        let imported = get_file_vault_key(
            &dir,
            "deepseek",
            |_| {
                legacy_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some("sk-migrated".to_string()))
            },
            |_| {
                legacy_deletes.fetch_add(1, Ordering::SeqCst);
            },
        )
        .expect("import");
        assert_eq!(imported, "sk-migrated");
        assert_eq!(legacy_calls.load(Ordering::SeqCst), 1);
        assert_eq!(legacy_deletes.load(Ordering::SeqCst), 1);

        // If persisting the vault fails (e.g. `dir` is a regular file), legacy_delete MUST NOT run.
        let unwritable = dir.join("not-a-directory");
        std::fs::write(&unwritable, b"file").unwrap();
        let failed_deletes = AtomicUsize::new(0);
        let write_err = get_file_vault_key(
            &unwritable,
            "openrouter",
            |_| Ok(Some("sk-preserve".to_string())),
            |_| {
                failed_deletes.fetch_add(1, Ordering::SeqCst);
            },
        );
        assert!(write_err.is_err());
        assert_eq!(failed_deletes.load(Ordering::SeqCst), 0);

        // Subsequent reads hit `api-keys.vault` directly without touching legacy keychain.
        let cached = get_file_vault_key(
            &dir,
            "deepseek",
            |_| {
                legacy_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some("sk-should-not-run".to_string()))
            },
            |_| unreachable!(),
        )
        .expect("cached");
        assert_eq!(cached, "sk-migrated");
        assert_eq!(legacy_calls.load(Ordering::SeqCst), 1);

        // Missing legacy key is also recorded as migrated so it is never asked twice.
        let missing = get_file_vault_key(
            &dir,
            "openai",
            |_| {
                legacy_calls.fetch_add(1, Ordering::SeqCst);
                Ok(None)
            },
            |_| unreachable!(),
        )
        .expect("missing");
        assert_eq!(missing, "");
        let missing_again = get_file_vault_key(
            &dir,
            "openai",
            |_| {
                legacy_calls.fetch_add(1, Ordering::SeqCst);
                Ok(Some("sk-never".to_string()))
            },
            |_| unreachable!(),
        )
        .expect("missing again");
        assert_eq!(missing_again, "");
        assert_eq!(legacy_calls.load(Ordering::SeqCst), 2);

        // Write + overwrite + delete keep strict 0600 permissions on Unix.
        set_file_vault_key(&dir, "openai", "sk-fresh").expect("set");
        assert_eq!(
            get_file_vault_key(&dir, "openai", |_| unreachable!(), |_| unreachable!()).unwrap(),
            "sk-fresh"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(VAULT_FILE_NAME))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "vault file must be owner-only 0600, got {mode:o}");
        }

        delete_file_vault_key(&dir, "openai", |_| unreachable!("already migrated"))
            .expect("delete");
        assert_eq!(
            get_file_vault_key(&dir, "openai", |_| unreachable!(), |_| unreachable!()).unwrap(),
            ""
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_file_is_not_reachable_through_store_commands() {
        assert!(crate::store_io::store_file_name(VAULT_FILE_NAME).is_none());
    }

    #[test]
    fn keyring_roundtrip() {
        let provider = "custom";
        let key = format!("test-key-{}", std::process::id());
        match set_keychain_key_impl(provider, &key) {
            Ok(()) => {}
            Err(e) if keychain_unavailable(&e) => {
                eprintln!("skipping keyring roundtrip: no OS keychain here ({e})");
                return;
            }
            Err(e) => panic!("set: {e}"),
        }
        let got = get_keychain_key_impl(provider).expect("get");
        assert_eq!(got, key, "keychain roundtrip failed");
        delete_keychain_key_impl(provider).expect("delete");
    }

    #[test]
    fn only_a_missing_secret_service_counts_as_unavailable() {
        assert!(keychain_unavailable(
            "Platform secure storage failure: DBus error: The name \
             org.freedesktop.secrets was not provided by any .service files"
        ));
        assert!(!keychain_unavailable("Platform secure storage failure: access denied"));
        assert!(!keychain_unavailable("No entry found"));
    }

    #[test]
    fn rejects_unknown_provider() {
        let dir = std::env::temp_dir().join(format!("pagewise-vault-bad-{}", std::process::id()));
        assert!(set_file_vault_key(&dir, "bogus", "k").is_err());
        assert!(set_file_vault_key(&dir, "", "k").is_err());
    }

    #[test]
    fn recovers_corrupt_vault_from_backup_and_never_locks_out_mutations() {
        let dir = std::env::temp_dir().join(format!("pagewise-vault-heal-{}", std::process::id()));
        let vault_path = dir.join(VAULT_FILE_NAME);
        let bak_path = vault_backup_path(&vault_path);

        set_file_vault_key(&dir, "openai", "sk-first").expect("set first");
        set_file_vault_key(&dir, "deepseek", "sk-second").expect("set second (writes .bak)");
        assert!(bak_path.exists(), "expected rolling .bak file");

        // Corrupt the primary vault file: read_vault_file recovers from `.bak` (`sk-first`).
        std::fs::write(&vault_path, b"{truncated").unwrap();
        let recovered =
            get_file_vault_key(&dir, "openai", |_| unreachable!(), |_| unreachable!()).unwrap();
        assert_eq!(recovered, "sk-first");

        // Corrupt BOTH primary and `.bak`: set_file_vault_key and delete_file_vault_key
        // self-heal instead of permanently locking the user out of Settings.
        std::fs::write(&vault_path, b"{broken-1").unwrap();
        std::fs::write(&bak_path, b"{broken-2").unwrap();
        set_file_vault_key(&dir, "openrouter", "sk-fresh").expect("self-heal set");
        assert_eq!(
            get_file_vault_key(&dir, "openrouter", |_| unreachable!(), |_| unreachable!()).unwrap(),
            "sk-fresh"
        );
        delete_file_vault_key(&dir, "openrouter", |_| {}).expect("self-heal delete");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
