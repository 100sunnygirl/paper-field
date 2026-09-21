use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_store::StoreExt;

struct LlmState {
    jobs: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LlmSettingsFile {
    base_url: String,
    model: String,
    api_key: String,
}

impl Default for LlmSettingsFile {
    fn default() -> Self {
        Self {
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-4o-mini".into(),
            api_key: String::new(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LlmSettingsPublic {
    base_url: String,
    model: String,
    has_key: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExportFile {
    relative_path: String,
    content: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resolve("", BaseDirectory::AppConfig)
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("llm-settings.json"))
}

fn read_settings(app: &AppHandle) -> Result<LlmSettingsFile, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(LlmSettingsFile::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn write_settings(app: &AppHandle, settings: &LlmSettingsFile) -> Result<(), String> {
    let path = settings_path(app)?;
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn persist_store(app: &AppHandle, settings: &LlmSettingsFile) {
    if let Ok(store) = app.store("llm-settings.json") {
        let _ = store.set("baseUrl", serde_json::Value::String(settings.base_url.clone()));
        let _ = store.set("model", serde_json::Value::String(settings.model.clone()));
        let _ = store.set(
            "hasKey",
            serde_json::Value::Bool(!settings.api_key.trim().is_empty()),
        );
        let _ = store.set("apiKey", serde_json::Value::String(settings.api_key.clone()));
        let _ = store.save();
    }
}

#[tauri::command]
fn llm_settings(app: AppHandle) -> Result<LlmSettingsPublic, String> {
    let settings = read_settings(&app)?;
    Ok(LlmSettingsPublic {
        base_url: settings.base_url,
        model: settings.model,
        has_key: !settings.api_key.trim().is_empty(),
    })
}

#[tauri::command]
fn save_llm_settings(
    app: AppHandle,
    base_url: String,
    model: String,
    api_key: Option<String>,
) -> Result<LlmSettingsPublic, String> {
    let mut settings = read_settings(&app)?;
    settings.base_url = if base_url.trim().is_empty() {
        "https://api.openai.com/v1".into()
    } else {
        base_url.trim().to_string()
    };
    settings.model = if model.trim().is_empty() {
        "gpt-4o-mini".into()
    } else {
        model.trim().to_string()
    };
    if let Some(key) = api_key {
        if !key.trim().is_empty() {
            settings.api_key = key.trim().to_string();
        }
    }
    write_settings(&app, &settings)?;
    persist_store(&app, &settings);
    Ok(LlmSettingsPublic {
        base_url: settings.base_url,
        model: settings.model,
        has_key: !settings.api_key.trim().is_empty(),
    })
}

#[tauri::command]
async fn llm_complete(
    app: AppHandle,
    state: State<'_, LlmState>,
    job_id: String,
    system_prompt: String,
    user_prompt: String,
) -> Result<String, String> {
    let settings = read_settings(&app)?;
    if settings.api_key.trim().is_empty() {
        return Err("NO_API_KEY".into());
    }
    let job_key = job_id.clone();
    let handle = tokio::spawn(async move {
        call_chat(&settings, &system_prompt, &user_prompt).await
    });
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.insert(job_key.clone(), handle.abort_handle());
    }
    let joined = handle.await.map_err(|_| "LLM job cancelled".to_string())?;
    if let Ok(mut jobs) = state.jobs.lock() {
        jobs.remove(&job_key);
    }
    joined
}

async fn call_chat(
    settings: &LlmSettingsFile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let url = format!(
        "{}/chat/completions",
        settings.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "model": settings.model,
        "temperature": 0.2,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });
    let response = client
        .post(url)
        .bearer_auth(settings.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("LLM HTTP {}: {}", status, text.chars().take(240).collect::<String>()));
    }
    let parsed: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    parsed["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "模型返回为空".into())
}

#[tauri::command]
fn llm_cancel(state: State<LlmState>, job_id: String) -> Result<(), String> {
    if let Ok(mut jobs) = state.jobs.lock() {
        if let Some(handle) = jobs.remove(&job_id) {
            handle.abort();
        }
    }
    Ok(())
}

#[tauri::command]
fn export_files(root: String, files: Vec<ExportFile>) -> Result<(), String> {
    let root = PathBuf::from(root);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    for file in files {
        if file.relative_path.contains("..") {
            return Err("invalid export path".into());
        }
        let dest = root.join(&file.relative_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if !dest.starts_with(&root) {
            return Err("invalid export path".into());
        }
        fs::write(dest, file.content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn build_menu(app: &tauri::App) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let new_paper = MenuItemBuilder::with_id("new-paper", "New Paper")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_domain = MenuItemBuilder::with_id("new-domain", "New Domain")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let mark_read = MenuItemBuilder::with_id("mark-read", "Mark Read")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&new_paper)
        .item(&new_domain)
        .separator()
        .item(&mark_read)
        .separator()
        .quit()
        .build()?;
    let field = MenuItemBuilder::with_id("mode-field", "FIELD 现场").build(app)?;
    let archive = MenuItemBuilder::with_id("mode-archive", "ARCHIVE 归档").build(app)?;
    let intake = MenuItemBuilder::with_id("mode-intake", "INTAKE 入库").build(app)?;
    let system = MenuItemBuilder::with_id("mode-system", "SYSTEM 系统").build(app)?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&field)
        .item(&archive)
        .item(&intake)
        .item(&system)
        .build()?;
    MenuBuilder::new(app).item(&file).item(&view).build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(LlmState {
            jobs: Mutex::new(HashMap::new()),
        })
        .setup(|app| {
            let menu = build_menu(app)?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            let _ = app.emit("menu://action", id);
        })
        .invoke_handler(tauri::generate_handler![
            llm_settings,
            save_llm_settings,
            llm_complete,
            llm_cancel,
            export_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running Paper Field");
}
