mod mineru;
mod mineru_api;

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

pub(crate) fn app_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .resolve("", BaseDirectory::AppConfig)
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join("llm-settings.json"))
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
        // 历史版本曾把明文 apiKey 镜像进插件存储的磁盘 JSON；
        // 只停止写入无法清除既有残留，这里每次保存都主动删除并落盘。
        let _ = store.delete("apiKey");
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
    // 三态：None=保留已存 key、Some("")=显式清除、Some(x)=写入。
    if let Some(key) = api_key {
        let trimmed = key.trim().to_string();
        settings.api_key = trimmed;
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

/// LLM 请求策略（对齐 OpenAI 官方 SDK 默认行为：max_retries=2，仅重试瞬时错误）。
const LLM_MAX_RETRIES: u32 = 2;
const LLM_BACKOFF_BASE_MS: u64 = 800;
const LLM_BACKOFF_JITTER_MS: u64 = 400;
/// Retry-After 超过该值视为额度类限流而非瞬时拥塞，直接失败（lobe-chat #13572 的教训）。
const LLM_RETRY_AFTER_CAP_SECS: u64 = 30;

static LLM_HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn llm_http_client() -> &'static reqwest::Client {
    LLM_HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(120))
            .use_rustls_tls()
            .build()
            .expect("build llm http client")
    })
}

/// 单次请求的可重试性分类；finish_reason 类错误一律不重试。
enum ChatError {
    /// 非 2xx：状态码 + 响应体原文 + 服务端要求的等待秒数（如有）。
    Http { status: u16, body: String, retry_after: Option<u64> },
    /// 连接失败 / 超时等传输层错误。
    Network(String),
    /// finish_reason=length：JSON 可能被截断（官方文档：JSON mode 只在不截断时保证合法）。
    Truncated,
    /// finish_reason=content_filter。
    ContentFilter,
    /// 响应里没有 content。
    EmptyContent,
}

fn should_retry_status(status: u16) -> bool {
    status == 408 || status == 429 || status >= 500
}

/// 指数退避 + 抖动（官方 Cookbook 建议加 jitter 防惊群）：800ms、1600ms 基数 + 0-400ms 抖动。
fn backoff_delay_ms(attempt: u32) -> u64 {
    let jitter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_millis() as u64 % LLM_BACKOFF_JITTER_MS)
        .unwrap_or(0);
    (LLM_BACKOFF_BASE_MS << attempt.min(4)) + jitter
}

fn parse_retry_after_secs(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok().filter(|s| *s > 0)
}

/// OpenAI 兼容端点的标准错误体 {"error":{"message":..}}；解析失败时退回原文前 240 字符。
fn extract_error_detail(body: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = parsed["error"]["message"].as_str() {
            return message.chars().take(240).collect();
        }
    }
    body.chars().take(240).collect()
}

/// 把状态码 + 细节翻译成用户可行动的中文提示。
fn friendly_llm_error(status: u16, detail: String) -> String {
    match status {
        401 | 403 => format!("LLM 鉴权失败：请检查设置页的 API Key（{detail}）"),
        404 => format!("接口不存在：请检查 Base URL 与模型名（{detail}）"),
        429 => format!("请求被限流或额度不足（{detail}）"),
        s if s >= 500 => format!("LLM 服务端错误（HTTP {s}）：{detail}"),
        s => format!("LLM HTTP {s}：{detail}"),
    }
}

/// 部分第三方 OpenAI 兼容端点不支持 response_format；命中时去掉该字段重试一次。
fn is_response_format_rejection(status: u16, body: &str) -> bool {
    if status != 400 {
        return false;
    }
    let lower = body.to_ascii_lowercase();
    lower.contains("response_format") || lower.contains("json_object")
}

async fn chat_once(
    settings: &LlmSettingsFile,
    system_prompt: &str,
    user_prompt: &str,
    use_json_mode: bool,
) -> Result<String, ChatError> {
    let url = format!(
        "{}/chat/completions",
        settings.base_url.trim_end_matches('/')
    );
    let mut body = serde_json::json!({
        "model": settings.model,
        "temperature": 0.2,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_prompt }
        ]
    });
    if use_json_mode {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }
    let response = llm_http_client()
        .post(url)
        .bearer_auth(settings.api_key.trim())
        .json(&body)
        .send()
        .await
        .map_err(|e| ChatError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_retry_after_secs);
    let text = response
        .text()
        .await
        .map_err(|e| ChatError::Network(e.to_string()))?;
    if !(200..300).contains(&status) {
        return Err(ChatError::Http { status, body: text, retry_after });
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| ChatError::Network(e.to_string()))?;
    let finish_reason = parsed["choices"][0]["finish_reason"].as_str();
    if finish_reason == Some("length") {
        return Err(ChatError::Truncated);
    }
    if finish_reason == Some("content_filter") {
        return Err(ChatError::ContentFilter);
    }
    parsed["choices"][0]["message"]["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .ok_or(ChatError::EmptyContent)
}

async fn call_chat(
    settings: &LlmSettingsFile,
    system_prompt: &str,
    user_prompt: &str,
) -> Result<String, String> {
    let mut use_json_mode = true;
    let mut attempt: u32 = 0;
    loop {
        match chat_once(settings, system_prompt, user_prompt, use_json_mode).await {
            Ok(content) => return Ok(content),
            Err(ChatError::Http { status, body, retry_after }) => {
                // response_format 不被支持：去掉字段立刻重试一次（不消耗退避预算）。
                if use_json_mode && is_response_format_rejection(status, &body) {
                    use_json_mode = false;
                    continue;
                }
                let detail = extract_error_detail(&body);
                if !should_retry_status(status) || attempt >= LLM_MAX_RETRIES {
                    return Err(friendly_llm_error(status, detail));
                }
                let delay = if let Some(secs) = retry_after {
                    // Retry-After 过长 → 大概率额度耗尽类限流，重试只会白等（lobe-chat #13572 教训）。
                    if secs > LLM_RETRY_AFTER_CAP_SECS {
                        return Err(format!(
                            "请求被限流（服务端要求等待 {secs} 秒），已停止重试：{detail}"
                        ));
                    }
                    secs * 1000
                } else {
                    backoff_delay_ms(attempt)
                };
                tokio::time::sleep(Duration::from_millis(delay)).await;
                attempt += 1;
            }
            // 传输层错误可重试；finish_reason / 空内容是确定性失败，直接返回。
            Err(ChatError::Network(message)) => {
                if attempt >= LLM_MAX_RETRIES {
                    return Err(format!("LLM 网络错误：{message}"));
                }
                tokio::time::sleep(Duration::from_millis(backoff_delay_ms(attempt))).await;
                attempt += 1;
            }
            Err(ChatError::Truncated) => {
                return Err("模型输出被截断（finish_reason=length），JSON 可能不完整。请重试，或在设置中换用输出上限更高的模型。".into());
            }
            Err(ChatError::ContentFilter) => {
                return Err("模型拒绝了这次请求（内容过滤）。".into());
            }
            Err(ChatError::EmptyContent) => return Err("模型返回为空".into()),
        }
    }
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
            export_files,
            mineru::mineru_settings,
            mineru::save_mineru_settings,
            mineru::mineru_test,
            mineru::mineru_probe,
            mineru::list_pdfs,
            mineru::normalize_pdf,
            mineru::open_pdf,
            mineru::mineru_submit,
            mineru::mineru_parse_statuses,
            mineru::mineru_markdown
        ])
        .run(tauri::generate_context!())
        .expect("error while running Paper Field");
}

#[cfg(test)]
mod llm_tests {
    use super::*;

    #[test]
    fn should_retry_only_transient_statuses() {
        // 官方 SDK 语义：408/429/5xx 可重试；4xx 客户端错误不重试。
        for status in [408u16, 429, 500, 502, 503] {
            assert!(should_retry_status(status), "{status} 应可重试");
        }
        for status in [400u16, 401, 403, 404, 422] {
            assert!(!should_retry_status(status), "{status} 不应重试");
        }
    }

    #[test]
    fn backoff_is_bounded_with_jitter() {
        for attempt in 0..3 {
            let delay = backoff_delay_ms(attempt);
            let base = LLM_BACKOFF_BASE_MS << attempt;
            assert!(delay >= base, "attempt {attempt}: {delay} < {base}");
            assert!(delay < base + LLM_BACKOFF_JITTER_MS, "attempt {attempt}: {delay}");
        }
    }

    #[test]
    fn retry_after_parses_seconds_only() {
        assert_eq!(parse_retry_after_secs("7"), Some(7));
        assert_eq!(parse_retry_after_secs(" 30 "), Some(30));
        assert_eq!(parse_retry_after_secs("0"), None);
        assert_eq!(parse_retry_after_secs("Wed, 21 Oct 2015 07:28:00 GMT"), None);
    }

    #[test]
    fn error_detail_prefers_standard_error_shape() {
        let body = r#"{"error":{"message":"Incorrect API key provided: sk-xxx","type":"invalid_request_error","code":"invalid_api_key"}}"#;
        assert_eq!(
            extract_error_detail(body),
            "Incorrect API key provided: sk-xxx"
        );
        // 非标准体退回原文截断
        assert_eq!(extract_error_detail("plain text"), "plain text");
    }

    #[test]
    fn friendly_errors_map_to_actionable_chinese() {
        assert!(friendly_llm_error(401, "bad key".into()).contains("API Key"));
        assert!(friendly_llm_error(404, "no route".into()).contains("Base URL"));
        assert!(friendly_llm_error(429, "slow down".into()).contains("限流"));
        assert!(friendly_llm_error(500, "boom".into()).contains("服务端"));
        assert!(friendly_llm_error(400, "x".into()).starts_with("LLM HTTP 400"));
    }

    #[test]
    fn response_format_rejection_detected_from_400_body() {
        assert!(is_response_format_rejection(
            400,
            r#"{"error":{"message":"'response_format' is not supported"}}"#
        ));
        assert!(is_response_format_rejection(400, "json_object not supported"));
        assert!(!is_response_format_rejection(401, "response_format"));
        assert!(!is_response_format_rejection(400, "invalid model"));
    }
}
