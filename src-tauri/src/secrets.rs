use keyring::Entry;

const SERVICE: &str = "pagewise";

/// Providers the frontend is allowed to store keys for. Rejecting anything else
/// avoids junk/typo entries piling up in the OS keychain.
const KNOWN_PROVIDERS: &[&str] = &["openai", "deepseek", "openrouter", "ollama", "custom"];

fn validate_provider(provider: &str) -> Result<(), String> {
    if provider.trim().is_empty() {
        return Err("Provider must not be empty".to_string());
    }
    if !KNOWN_PROVIDERS.contains(&provider) {
        return Err(format!("Unknown provider: {provider}"));
    }
    Ok(())
}

fn entry(provider: &str) -> Result<Entry, String> {
    validate_provider(provider)?;
    Entry::new(SERVICE, &format!("api-key/{provider}")).map_err(|e| e.to_string())
}

fn set_api_key_impl(provider: &str, key: &str) -> Result<(), String> {
    entry(provider)?.set_password(key).map_err(|e| e.to_string())
}

fn get_api_key_impl(provider: &str) -> Result<String, String> {
    match entry(provider)?.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

fn delete_api_key_impl(provider: &str) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Keychain access can block on an OS prompt (macOS) or a Secret Service DBus
// round-trip (Linux); run it off the main thread so the window never freezes.
#[tauri::command]
pub async fn set_api_key(provider: String, key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || set_api_key_impl(&provider, &key))
        .await
        .map_err(|e| format!("keychain task failed: {e}"))?
}

#[tauri::command]
pub async fn get_api_key(provider: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || get_api_key_impl(&provider))
        .await
        .map_err(|e| format!("keychain task failed: {e}"))?
}

#[tauri::command]
pub async fn delete_api_key(provider: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_api_key_impl(&provider))
        .await
        .map_err(|e| format!("keychain task failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Does this error mean the environment has no keychain at all?
    ///
    /// Deliberately narrow: it matches the Secret Service simply not being
    /// there, which is the shape of a headless Linux runner. A keychain that
    /// exists and misbehaves must still fail the test.
    fn keychain_unavailable(err: &str) -> bool {
        err.contains("org.freedesktop.secrets")
    }

    #[test]
    fn keyring_roundtrip() {
        // Must be a known provider now that entry() validates the name.
        let provider = "custom";
        let key = format!("test-key-{}", std::process::id());
        match set_api_key_impl(provider, &key) {
            Ok(()) => {}
            // Step aside where there is no keychain to talk to, rather than
            // deleting a test that does real work on every machine that has
            // one — including the macOS runner that builds releases.
            Err(e) if keychain_unavailable(&e) => {
                eprintln!("skipping keyring roundtrip: no OS keychain here ({e})");
                return;
            }
            Err(e) => panic!("set: {e}"),
        }
        let got = get_api_key_impl(provider).expect("get");
        assert_eq!(got, key, "keychain roundtrip failed");
        delete_api_key_impl(provider).expect("delete");
    }

    #[test]
    fn only_a_missing_secret_service_counts_as_unavailable() {
        assert!(keychain_unavailable(
            "Platform secure storage failure: DBus error: The name \
             org.freedesktop.secrets was not provided by any .service files"
        ));
        // A real keychain returning a real error is not a reason to skip.
        assert!(!keychain_unavailable("Platform secure storage failure: access denied"));
        assert!(!keychain_unavailable("No entry found"));
    }

    #[test]
    fn rejects_unknown_provider() {
        assert!(set_api_key_impl("bogus", "k").is_err());
        assert!(set_api_key_impl("", "k").is_err());
    }
}
