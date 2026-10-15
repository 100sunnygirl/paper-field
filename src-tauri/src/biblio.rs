//! Optional bibliographic credentials.
//! Email is a normal setting (Crossref mailto and User-Agent only).
//! OpenAlex and Semantic Scholar keys stay in the secret store.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::io_util::atomic_write;
use crate::lookup_run::{self, BiblioAuth, OpenAlexBudget};
use crate::secrets::{self, SecretStore};

pub const OPENALEX_ACCOUNT: &str = "openalex:key";
pub const S2_ACCOUNT: &str = "s2:key";
const FILE_NAME: &str = "biblio-settings.json";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BiblioStatus {
    pub email: String,
    pub has_openalex_key: bool,
    pub has_s2_key: bool,
    pub openalex_remaining_usd: Option<f64>,
    pub openalex_limit_usd: Option<f64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiblioSaveInput {
    pub email: String,
    /// `None` keeps the saved key, `Some("")` clears it, any other string replaces it.
    pub openalex_key: Option<String>,
    pub s2_key: Option<String>,
}

fn settings_path(dir: &Path) -> std::path::PathBuf {
    dir.join(FILE_NAME)
}

fn read_email(dir: &Path) -> Result<String, String> {
    let path = settings_path(dir);
    if !path.exists() {
        return Ok(String::new());
    }
    let raw = fs::read_to_string(&path).map_err(|err| err.to_string())?;
    let value: serde_json::Value = serde_json::from_str(&raw).map_err(|err| format!("文献库设置无法解析：{err}"))?;
    let Some(object) = value.as_object() else {
        return Err("文献库设置不是对象".into());
    };
    Ok(object.get("email").and_then(|item| item.as_str()).unwrap_or("").trim().to_string())
}

fn nonempty(value: Option<String>) -> Option<String> {
    value.and_then(|text| {
        let trimmed = text.trim().to_string();
        if trimmed.is_empty() { None } else { Some(trimmed) }
    })
}

fn apply_key(store: &dyn SecretStore, account: &str, value: Option<&str>) -> Result<(), String> {
    let Some(secret) = value else { return Ok(()) };
    store.set(account, secret.trim())
}

pub fn load_auth_from(dir: &Path, store: &dyn SecretStore) -> Result<BiblioAuth, String> {
    let email = nonempty(Some(read_email(dir)?));
    Ok(BiblioAuth {
        email,
        openalex_key: nonempty(store.get(OPENALEX_ACCOUNT)?),
        s2_key: nonempty(store.get(S2_ACCOUNT)?),
    })
}

pub fn load_status_from(dir: &Path, store: &dyn SecretStore, budget: &OpenAlexBudget) -> Result<BiblioStatus, String> {
    let auth = load_auth_from(dir, store)?;
    Ok(BiblioStatus {
        email: auth.email.unwrap_or_default(),
        has_openalex_key: auth.openalex_key.is_some(),
        has_s2_key: auth.s2_key.is_some(),
        openalex_remaining_usd: budget.remaining_usd,
        openalex_limit_usd: budget.limit_usd,
    })
}

pub fn save_settings_from(
    dir: &Path,
    store: &dyn SecretStore,
    input: &BiblioSaveInput,
    budget: &OpenAlexBudget,
) -> Result<BiblioStatus, String> {
    apply_key(store, OPENALEX_ACCOUNT, input.openalex_key.as_deref())?;
    apply_key(store, S2_ACCOUNT, input.s2_key.as_deref())?;
    let email = input.email.trim();
    let body = serde_json::json!({ "email": email });
    let raw = serde_json::to_string_pretty(&body).map_err(|err| err.to_string())?;
    atomic_write(&settings_path(dir), raw.as_bytes())?;
    load_status_from(dir, store, budget)
}

pub fn load_auth(app: &AppHandle) -> Result<BiblioAuth, String> {
    let dir = crate::app_config_dir(app)?;
    let store = secrets::store_for(&dir);
    load_auth_from(&dir, store.as_ref())
}

#[tauri::command]
pub fn biblio_settings(app: AppHandle) -> Result<BiblioStatus, String> {
    let dir = crate::app_config_dir(&app)?;
    let store = secrets::store_for(&dir);
    load_status_from(&dir, store.as_ref(), &lookup_run::budget_snapshot())
}

#[tauri::command]
pub fn save_biblio_settings(app: AppHandle, input: BiblioSaveInput) -> Result<BiblioStatus, String> {
    let dir = crate::app_config_dir(&app)?;
    let store = secrets::store_for(&dir);
    save_settings_from(&dir, store.as_ref(), &input, &lookup_run::budget_snapshot())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemorySecretStore;

    fn scratch() -> std::path::PathBuf {
        crate::test_util::unique_temp_dir("paper-field-biblio")
    }

    #[test]
    fn missing_file_is_anonymous_and_corrupt_json_is_not_rewritten() {
        let dir = scratch();
        let store = MemorySecretStore::new();
        let auth = load_auth_from(&dir, &store).unwrap();
        assert!(auth.email.is_none());
        assert!(auth.openalex_key.is_none());
        fs::write(settings_path(&dir), "{").unwrap();
        assert!(load_auth_from(&dir, &store).is_err());
        assert_eq!(fs::read_to_string(settings_path(&dir)).unwrap(), "{");
    }

    #[test]
    fn email_is_a_file_and_keys_stay_in_the_secret_store() {
        let dir = scratch();
        let store = MemorySecretStore::new();
        let budget = OpenAlexBudget { remaining_usd: Some(0.9), limit_usd: Some(1.0) };
        let saved = save_settings_from(
            &dir,
            &store,
            &BiblioSaveInput {
                email: " reader@example.com ".into(),
                openalex_key: Some("oa-secret-key".into()),
                s2_key: Some("s2-secret-key".into()),
            },
            &budget,
        )
        .unwrap();
        assert_eq!(saved.email, "reader@example.com");
        assert!(saved.has_openalex_key);
        assert!(saved.has_s2_key);
        assert_eq!(saved.openalex_remaining_usd, Some(0.9));
        let raw = fs::read_to_string(settings_path(&dir)).unwrap();
        assert!(raw.contains("reader@example.com"));
        assert!(!raw.contains("oa-secret-key"), "{raw}");
        assert!(!raw.contains("s2-secret-key"), "{raw}");
        let kept = save_settings_from(
            &dir,
            &store,
            &BiblioSaveInput {
                email: "reader@example.com".into(),
                openalex_key: None,
                s2_key: Some(String::new()),
            },
            &budget,
        )
        .unwrap();
        assert!(kept.has_openalex_key);
        assert!(!kept.has_s2_key);
        let auth = load_auth_from(&dir, &store).unwrap();
        assert_eq!(auth.openalex_key.as_deref(), Some("oa-secret-key"));
        assert!(auth.s2_key.is_none());
    }
}
