use keyring::Entry;

const SERVICE: &str = "pagewise";

fn entry(provider: &str) -> Result<Entry, String> {
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
        let provider = format!("test-provider-{}", std::process::id());
        let key = format!("test-key-{}", std::process::id());
        set_api_key(provider.clone(), key.clone()).expect("set");
        let got = get_api_key(provider.clone()).expect("get");
        assert_eq!(got, key, "keychain roundtrip failed");
        delete_api_key(provider).expect("delete");
    }
}
