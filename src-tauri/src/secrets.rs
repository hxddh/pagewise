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

#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
    entry(&provider)?
        .set_password(&key)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_api_key(provider: String) -> Result<String, String> {
    match entry(&provider)?.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyring_roundtrip() {
        // Must be a known provider now that entry() validates the name.
        let provider = "custom".to_string();
        let key = format!("test-key-{}", std::process::id());
        set_api_key(provider.clone(), key.clone()).expect("set");
        let got = get_api_key(provider.clone()).expect("get");
        assert_eq!(got, key, "keychain roundtrip failed");
        delete_api_key(provider).expect("delete");
    }

    #[test]
    fn rejects_unknown_provider() {
        assert!(set_api_key("bogus".to_string(), "k".to_string()).is_err());
        assert!(set_api_key(String::new(), "k".to_string()).is_err());
    }
}
