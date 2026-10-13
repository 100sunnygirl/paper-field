use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use serde_json::Value;

pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    /// Clearing a saved key writes an empty secret through `set`.
    #[allow(dead_code)]
    fn delete(&self, account: &str) -> Result<(), String>;
}

#[cfg(test)]
pub struct MemorySecretStore {
    map: Mutex<HashMap<String, String>>,
}

#[cfg(test)]
impl MemorySecretStore {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
        }
    }
}

#[cfg(test)]
impl SecretStore for MemorySecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self
            .map
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .get(account)
            .cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let mut map = self.map.lock().unwrap_or_else(|err| err.into_inner());
        if secret.is_empty() {
            map.remove(account);
        } else {
            map.insert(account.to_string(), secret.to_string());
        }
        Ok(())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.set(account, "")
    }
}

pub fn llm_account(provider_id: &str) -> String {
    format!("llm:{provider_id}")
}

pub const MINERU_ACCOUNT: &str = "mineru:token";

/// Service name in macOS Keychain and Windows Credential Manager.
///
/// This does not follow the bundle identifier. Entries saved while the app
/// was `com.paperfield.app` stay under `paper-field`, so the move to
/// `com.paperfield.notes` does not orphan them. Linux keeps the same accounts
/// in `secrets.json`, which the app-support copy migrates with the other files.
pub const KEYCHAIN_SERVICE: &str = "paper-field";

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub struct KeyringStore;

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SecretStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|err| err.to_string())?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.to_string()),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account).map_err(|err| err.to_string())?;
        if secret.is_empty() {
            return match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => Err(err.to_string()),
            };
        }
        entry.set_password(secret).map_err(|err| err.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.set(account, "")
    }
}

/// Linux builds (this dev VM) have no macOS Keychain. Secrets stay out of the
/// settings JSON, in a mode-0600 file. macOS and Windows use the keyring crate.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub struct FileSecretStore {
    path: std::path::PathBuf,
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl FileSecretStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("secrets.json"),
        }
    }

    fn load(&self) -> Result<HashMap<String, String>, String> {
        if !self.path.exists() {
            return Ok(HashMap::new());
        }
        let raw = fs::read_to_string(&self.path).map_err(|err| err.to_string())?;
        serde_json::from_str(&raw).map_err(|err| format!("密钥文件无法解析：{err}"))
    }

    fn save(&self, map: &HashMap<String, String>) -> Result<(), String> {
        let raw = serde_json::to_string(map).map_err(|err| err.to_string())?;
        crate::io_util::atomic_write(&self.path, raw.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl SecretStore for FileSecretStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.load()?.get(account).cloned())
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        let mut map = self.load()?;
        if secret.is_empty() {
            map.remove(account);
        } else {
            map.insert(account.to_string(), secret.to_string());
        }
        self.save(&map)
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        self.set(account, "")
    }
}

pub fn store_for(dir: &Path) -> Box<dyn SecretStore> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let _ = dir;
        Box::new(KeyringStore)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Box::new(FileSecretStore::new(dir))
    }
}

pub fn redact_secrets(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < chars.len() {
        if has_prefix(&chars[index..], "sk-") {
            let token = token_len(&chars[index + 3..], true);
            if token >= 4 {
                out.push_str("sk-…");
                index += 3 + token;
                continue;
            }
        }
        if has_prefix_ignore_case(&chars[index..], "bearer ") {
            let token = token_len(&chars[index + 7..], false);
            if token >= 4 {
                out.push_str("Bearer …");
                index += 7 + token;
                continue;
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn has_prefix(chars: &[char], prefix: &str) -> bool {
    let prefix: Vec<char> = prefix.chars().collect();
    chars.len() >= prefix.len() && chars[..prefix.len()] == prefix[..]
}

fn has_prefix_ignore_case(chars: &[char], prefix: &str) -> bool {
    let prefix: Vec<char> = prefix.chars().collect();
    if chars.len() < prefix.len() {
        return false;
    }
    chars[..prefix.len()]
        .iter()
        .zip(prefix.iter())
        .all(|(left, right)| left.eq_ignore_ascii_case(right))
}

fn token_len(chars: &[char], sk: bool) -> usize {
    chars
        .iter()
        .take_while(|ch| {
            if sk {
                ch.is_ascii_alphanumeric() || **ch == '_' || **ch == '-'
            } else {
                ch.is_ascii_alphanumeric() || matches!(ch, '-' | '.' | '_' | '~' | '+' | '/' | '=')
            }
        })
        .count()
}

/// Empty secret-shaped fields in a JSON document. Invalid JSON is redacted as text.
pub fn scrub_json_secrets(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return redact_secrets(raw);
    };
    scrub_value(&mut value);
    serde_json::to_string_pretty(&value).unwrap_or_else(|_| redact_secrets(raw))
}

fn scrub_value(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for key in ["apiKey", "api_key", "token", "authorization", "Authorization"] {
                if map.contains_key(key) {
                    map.insert(key.to_string(), Value::String(String::new()));
                }
            }
            for child in map.values_mut() {
                scrub_value(child);
            }
        }
        Value::Array(items) => {
            for item in items {
                scrub_value(item);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_service_stays_paper_field_across_bundle_id_change() {
        assert_eq!(KEYCHAIN_SERVICE, "paper-field");
        assert!(!KEYCHAIN_SERVICE.contains("com.paperfield"));
        assert_ne!(KEYCHAIN_SERVICE, crate::appdir::NEW_IDENTIFIER);
        assert_ne!(KEYCHAIN_SERVICE, crate::appdir::OLD_IDENTIFIER);
    }

    #[test]
    fn memory_store_round_trip_and_delete() {
        let store = MemorySecretStore::new();
        store.set("llm:p", "sk-test").unwrap();
        assert_eq!(store.get("llm:p").unwrap().as_deref(), Some("sk-test"));
        store.delete("llm:p").unwrap();
        assert_eq!(store.get("llm:p").unwrap(), None);
    }

    #[test]
    fn redacts_sk_and_bearer_fragments() {
        let raw = "Incorrect API key provided: sk-abcDEF123456 and Bearer sk-live-secret.tail";
        let cleaned = redact_secrets(raw);
        assert!(!cleaned.contains("sk-abcDEF123456"), "{cleaned}");
        assert!(cleaned.contains("sk-…"), "{cleaned}");
        assert!(!cleaned.to_ascii_lowercase().contains("bearer sk"), "{cleaned}");
        assert!(cleaned.contains("Bearer …"), "{cleaned}");
    }

    #[test]
    fn scrub_json_clears_nested_keys_but_keeps_other_fields() {
        let raw = r#"{"version":1,"apiKey":"sk-old","providers":[{"id":"p","apiKey":"sk-keep","model":"m"}]}"#;
        let cleaned = scrub_json_secrets(raw);
        assert!(!cleaned.contains("sk-old"), "{cleaned}");
        assert!(!cleaned.contains("sk-keep"), "{cleaned}");
        assert!(cleaned.contains("\"model\""), "{cleaned}");
    }
}
