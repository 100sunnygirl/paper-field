//! LLM 多提供商接入：预设 + 顺序故障转移 + 测试连接 + 模型发现 + 轻量用量统计。
//!
//! - llm-settings.json v2：providers 数组顺序即回退顺序；密钥在 macOS Keychain / Windows 凭据管理器（其他平台为 0600 的 secrets.json），设置文件与 .v1.bak 不留明文；
//! - 旧版扁平格式（无 version 字段的 {baseUrl, model, apiKey}）读入时自动迁移为
//!   一条 provider 记录（baseUrl 反查预设），备份 llm-settings.json.v1.bak 后写回 v2；
//! - llm_complete 依序尝试「启用且密钥就绪」的提供商：单提供商内保留有界重试
//!   （408/429/5xx/网络错误至多重试 2 次、指数退避+抖动、Retry-After>30s 判死）、
//!   response_format 被拒时去掉字段立即重试一次；401/403/404 与重试耗尽直接换下一家，
//!   全部失败返回聚合中文错误；用户取消（abort）立即传播，不被吞也不转移；
//! - 用量：成功把响应 usage 计入 requests 与 tokens，任一提供商 HTTP 失败计 errors，
//!   累加在 LlmState 内存并持久化到 llm-usage.json（与设置文件分开）。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::app_config_dir;
use crate::io_util::atomic_write;
use crate::secrets::{llm_account, redact_secrets, scrub_json_secrets, store_for};

// ---------- 预设反查表（仅迁移用；唯一权威在 TS 侧 src/lib/settings.ts） ----------

pub(crate) struct LlmPreset {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) base_url: &'static str,
    pub(crate) requires_key: bool,
}

const PRESETS: &[LlmPreset] = &[
    LlmPreset { id: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", requires_key: true },
    LlmPreset { id: "deepseek", label: "DeepSeek", base_url: "https://api.deepseek.com/v1", requires_key: true },
    LlmPreset { id: "moonshot", label: "Kimi (Moonshot)", base_url: "https://api.moonshot.cn/v1", requires_key: true },
    LlmPreset { id: "zhipu", label: "智谱 GLM", base_url: "https://open.bigmodel.cn/api/paas/v4", requires_key: true },
    LlmPreset { id: "qwen", label: "通义千问", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", requires_key: true },
    LlmPreset { id: "siliconflow", label: "SiliconFlow", base_url: "https://api.siliconflow.cn/v1", requires_key: true },
    LlmPreset { id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", requires_key: true },
    LlmPreset { id: "ollama", label: "Ollama 本地", base_url: "http://localhost:11434/v1", requires_key: false },
    LlmPreset { id: "lmstudio", label: "LM Studio", base_url: "http://localhost:1234/v1", requires_key: false },
];

/// baseUrl 前缀 -> 预设：先做精确 / 路径前缀匹配，再退回主机名匹配
/// （覆盖用户只填裸域名的写法，如 https://api.deepseek.com）。
fn preset_for_base_url(base_url: &str) -> Option<&'static LlmPreset> {
    let normalized = normalize_base(base_url);
    if normalized.is_empty() {
        return None;
    }
    PRESETS
        .iter()
        .find(|preset| {
            let base = normalize_base(preset.base_url);
            normalized == base || normalized.starts_with(&format!("{base}/"))
        })
        .or_else(|| {
            let host = url_host(&normalized);
            if host.is_empty() {
                return None;
            }
            PRESETS
                .iter()
                .find(|preset| url_host(&normalize_base(preset.base_url)) == host)
        })
}

fn normalize_base(value: &str) -> String {
    value.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn url_host(value: &str) -> String {
    let rest = value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
        .unwrap_or(value);
    rest.split('/')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
}

// ---------- 设置：v2 结构、v1 迁移、读写 ----------

/// llm-settings.json v2 磁盘格式（含密钥；密钥只存本机，永不进对前端的返回）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmFileV2 {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub providers: Vec<ProviderCfg>,
}

impl Default for LlmFileV2 {
    fn default() -> Self {
        Self { version: 2, providers: Vec::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCfg {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub preset_id: Option<String>,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub model: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub requires_key: bool,
    #[serde(default)]
    pub api_key: String,
}

/// 旧版（v1）扁平磁盘格式，仅为迁移保留；字段全部可缺省以容忍历史镜像写入的残缺文件。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LlmFileV1 {
    base_url: String,
    model: String,
    api_key: String,
}

/// v1 缺省时沿用的旧默认值（与改造前 LlmSettingsFile::default 一致）。
const V1_DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const V1_DEFAULT_MODEL: &str = "gpt-4o-mini";

/// 前端保存入参（全量替换）：apiKey 三态——None=保留已存（按 id 匹配）、
/// Some("")=清除、Some(x)=写入。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSaveInput {
    #[serde(default)]
    pub providers: Vec<ProviderInput>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    #[serde(default)]
    id: String,
    #[serde(default)]
    preset_id: Option<String>,
    #[serde(default)]
    label: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    model: String,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default = "default_true")]
    requires_key: bool,
    #[serde(default)]
    api_key: Option<String>,
}

impl Default for ProviderInput {
    fn default() -> Self {
        Self {
            id: String::new(),
            preset_id: None,
            label: String::new(),
            base_url: String::new(),
            model: String::new(),
            enabled: true,
            requires_key: true,
            api_key: None,
        }
    }
}

/// 对外视图：apiKey 永不回显，只返回 hasKey。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmSettingsPublic {
    version: u32,
    providers: Vec<ProviderPublic>,
    usage: HashMap<String, UsageEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderPublic {
    id: String,
    preset_id: Option<String>,
    label: String,
    base_url: String,
    model: String,
    enabled: bool,
    has_key: bool,
    requires_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmTestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub message: String,
}

fn default_true() -> bool {
    true
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join("llm-settings.json"))
}

fn usage_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join("llm-usage.json"))
}

fn write_public_llm(path: &Path, file: &LlmFileV2) -> Result<(), String> {
    let mut public = file.clone();
    for provider in &mut public.providers {
        provider.api_key.clear();
    }
    let raw = serde_json::to_string_pretty(&public).map_err(|err| err.to_string())?;
    atomic_write(path, raw.as_bytes())
}

fn write_file_at(path: &Path, file: &LlmFileV2) -> Result<(), String> {
    let store = store_for(path.parent().unwrap_or_else(|| Path::new(".")));
    for provider in &file.providers {
        store.set(&llm_account(&provider.id), provider.api_key.trim())?;
    }
    write_public_llm(path, file)
}

/// 解析设置原文。坏 JSON 或 v2 形态损坏时返回错误并保留原文件，不当成 v1 迁移。
/// 无 version 的对象仍按 v1 扁平格式迁移。version>2 直接报错。
fn parse_settings(raw: &str) -> Result<(LlmFileV2, bool), String> {
    let value: Value = serde_json::from_str(raw)
        .map_err(|err| format!("LLM 设置无法解析，已保留原文件：{err}"))?;
    if !value.is_object() {
        return Err("LLM 设置不是 JSON 对象，已保留原文件".into());
    }
    match value.get("version").and_then(Value::as_u64) {
        Some(2) => {
            let file = serde_json::from_value::<LlmFileV2>(value)
                .map_err(|err| format!("LLM 设置无法解析，已保留原文件：{err}"))?;
            Ok((file, false))
        }
        Some(version) => Err(format!("LLM 设置版本过新（v{version}），请升级应用后再试")),
        None => Ok((migrate_v1(&value), true)),
    }
}

/// v1 扁平 → v2 单 provider：presetId 由 baseUrl 反查预设（查不到为 null/自定义），
/// label 取预设名或「自定义服务」，Key 原样保留，默认启用。
fn migrate_v1(value: &Value) -> LlmFileV2 {
    let v1: LlmFileV1 = serde_json::from_value(value.clone()).unwrap_or_default();
    let base_url = fallback(v1.base_url.trim(), V1_DEFAULT_BASE_URL);
    let model = fallback(v1.model.trim(), V1_DEFAULT_MODEL);
    let preset = preset_for_base_url(&base_url);
    LlmFileV2 {
        version: 2,
        providers: vec![ProviderCfg {
            id: new_provider_id(),
            preset_id: preset.map(|p| p.id.to_string()),
            label: preset
                .map(|p| p.label.to_string())
                .unwrap_or_else(|| "自定义服务".into()),
            base_url,
            model,
            enabled: true,
            requires_key: preset.map(|p| p.requires_key).unwrap_or(true),
            api_key: v1.api_key.trim().to_string(),
        }],
    }
}

/// 读取（含迁移）：v1 → 先备份 llm-settings.json.v1.bak（仅一次）→ 写回 v2。
/// 抽成基于路径的函数，便于测试备份与回写行为。
fn scrub_settings_backup(path: &Path) -> Result<(), String> {
    let bak = backup_path(path);
    if !bak.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&bak).map_err(|err| format!("读取 LLM 设置备份失败：{err}"))?;
    let cleaned = scrub_json_secrets(&raw);
    if cleaned != raw {
        atomic_write(&bak, cleaned.as_bytes())?;
    }
    Ok(())
}

fn write_scrubbed_backup(path: &Path, raw: &str) -> Result<(), String> {
    let bak = backup_path(path);
    let scrubbed = scrub_json_secrets(raw);
    if bak.exists() {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let stamped = PathBuf::from(format!("{bak}.{millis}", bak = bak.display()));
        atomic_write(&stamped, scrubbed.as_bytes())?;
    } else {
        atomic_write(&bak, scrubbed.as_bytes())?;
    }
    scrub_settings_backup(path)
}

fn read_or_migrate_at(path: &Path) -> Result<LlmFileV2, String> {
    if !path.exists() {
        return Ok(LlmFileV2::default());
    }
    let raw = fs::read_to_string(path).map_err(|err| format!("读取 LLM 设置失败：{err}"))?;
    scrub_settings_backup(path)?;
    let (mut file, migrated) = parse_settings(&raw)?;
    let store = store_for(path.parent().unwrap_or_else(|| Path::new(".")));
    let mut lifted = false;
    for provider in &mut file.providers {
        let key = provider.api_key.trim().to_string();
        if !key.is_empty() {
            store.set(&llm_account(&provider.id), &key)?;
            lifted = true;
        } else if let Some(secret) = store.get(&llm_account(&provider.id))? {
            provider.api_key = secret;
        }
    }
    if migrated || lifted {
        if migrated {
            write_scrubbed_backup(path, &raw)?;
        }
        file.version = 2;
        write_public_llm(path, &file)?;
    }
    Ok(file)
}

/// 备份名沿用 mineru-settings 的「仅一次」语义：llm-settings.json.v1.bak。
fn backup_path(path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.v1.bak", path.to_string_lossy()))
}

fn read_file(app: &AppHandle) -> Result<LlmFileV2, String> {
    read_or_migrate_at(&settings_file(app)?)
}

/// 全量替换式保存：空 id / 重复 id 兜底生成新 id（保证回退与用量按 id 可区分）；
/// apiKey 三态按 id 匹配旧记录；空 label 回落「自定义服务」。
fn normalize_input(input: &LlmSaveInput, existing: &LlmFileV2) -> LlmFileV2 {
    let mut seen: Vec<String> = Vec::new();
    let mut providers = Vec::with_capacity(input.providers.len());
    for p in &input.providers {
        let mut id = p.id.trim().to_string();
        if id.is_empty() || seen.iter().any(|s| s == &id) {
            id = new_provider_id();
        }
        seen.push(id.clone());
        let old = existing.providers.iter().find(|e| e.id == id);
        let api_key = match p.api_key.as_deref() {
            None => old.map(|e| e.api_key.clone()).unwrap_or_default(),
            Some(value) if value.trim().is_empty() => String::new(),
            Some(value) => value.trim().to_string(),
        };
        providers.push(ProviderCfg {
            id,
            preset_id: p
                .preset_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            label: fallback(p.label.trim(), "自定义服务"),
            base_url: p.base_url.trim().to_string(),
            model: p.model.trim().to_string(),
            enabled: p.enabled,
            requires_key: p.requires_key,
            api_key,
        });
    }
    LlmFileV2 { version: 2, providers }
}

fn fallback<'a>(value: &'a str, default_value: &'a str) -> String {
    if value.is_empty() {
        default_value.to_string()
    } else {
        value.to_string()
    }
}

/// 回退候选：enabled 且（requiresKey ? 已存 Key : 免 Key），顺序即尝试顺序。
fn usable_providers(file: &LlmFileV2) -> Vec<ProviderCfg> {
    file.providers
        .iter()
        .filter(|p| p.enabled && (!p.requires_key || !p.api_key.trim().is_empty()))
        .cloned()
        .collect()
}

fn to_public(file: &LlmFileV2, usage: HashMap<String, UsageEntry>) -> LlmSettingsPublic {
    LlmSettingsPublic {
        version: 2,
        providers: file
            .providers
            .iter()
            .map(|p| ProviderPublic {
                id: p.id.clone(),
                preset_id: p.preset_id.clone(),
                label: p.label.clone(),
                base_url: p.base_url.clone(),
                model: p.model.clone(),
                enabled: p.enabled,
                has_key: !p.api_key.trim().is_empty(),
                requires_key: p.requires_key,
            })
            .collect(),
        usage,
    }
}

/// 不引入 uuid 依赖的本地 id 生成：时间戳纳秒 + 进程内计数器 + 地址熵，
/// splitmix64 混合成 v4 形态的 UUID 字符串（仅用于本机文件内区分记录）。
fn new_provider_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let entropy = &COUNTER as *const AtomicU64 as u64;
    let mut bytes = [0u8; 16];
    for (index, chunk) in bytes.chunks_mut(8).enumerate() {
        let mixed = splitmix64(
            nanos
                ^ seq
                    .wrapping_mul(0x9E37_79B9_7F4A_7C15)
                    .wrapping_add(entropy)
                ^ (index as u64).wrapping_mul(0xA076_1D64_78BD_642F),
        );
        for (offset, byte) in chunk.iter_mut().enumerate() {
            *byte = (mixed >> (offset * 8)) as u8;
        }
    }
    // UUID v4 的版本与变体位
    bytes[6] = (bytes[6] & 0x0F) | 0x40;
    bytes[8] = (bytes[8] & 0x3F) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn splitmix64(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = x;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

// ---------- 用量：内存 + llm-usage.json ----------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    #[serde(default)]
    pub requests: u64,
    #[serde(default)]
    pub errors: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    /// 最近一次使用（成功或失败）的 Unix 毫秒时间戳。
    #[serde(default)]
    pub last_used_at: Option<u64>,
}

impl UsageEntry {
    /// 成功：requests +1，usage 里给出的 tokens 累加（缺 usage 字段按 0 记）。
    fn record_success(&mut self, input_tokens: Option<u64>, output_tokens: Option<u64>) {
        self.requests += 1;
        self.input_tokens += input_tokens.unwrap_or(0);
        self.output_tokens += output_tokens.unwrap_or(0);
        self.last_used_at = Some(now_millis());
    }

    /// 任一提供商 HTTP 失败：errors +1（网络/确定性失败不计）。
    fn record_error(&mut self) {
        self.errors += 1;
        self.last_used_at = Some(now_millis());
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// LlmState 里的用量内存：首次访问时从 llm-usage.json 惰性加载，之后只增改并回写。
#[derive(Default)]
struct UsageMemory {
    loaded: bool,
    entries: HashMap<String, UsageEntry>,
}

struct JobBook {
    handles: HashMap<String, tokio::task::AbortHandle>,
    cancelled: HashMap<String, ()>,
}

pub struct LlmState {
    jobs: Mutex<JobBook>,
    usage: Mutex<UsageMemory>,
}

impl LlmState {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(JobBook {
                handles: HashMap::new(),
                cancelled: HashMap::new(),
            }),
            usage: Mutex::new(UsageMemory::default()),
        }
    }
}

impl Default for LlmState {
    fn default() -> Self {
        Self::new()
    }
}

/// 锁中毒不致命（只会丢统计），直接恢复数据继续。
fn lock_usage(state: &LlmState) -> MutexGuard<'_, UsageMemory> {
    state.usage.lock().unwrap_or_else(|e| e.into_inner())
}

fn read_usage_at(path: &Path) -> HashMap<String, UsageEntry> {
    if !path.exists() {
        return HashMap::new();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_usage_at(path: &Path, entries: &HashMap<String, UsageEntry>) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| format!("写入 LLM 用量文件失败：{e}"))
}

/// 只读快照（供 llm_settings / save_llm_settings 合并返回）。
fn usage_snapshot(app: &AppHandle, state: &LlmState) -> HashMap<String, UsageEntry> {
    let Ok(path) = usage_file(app) else {
        return HashMap::new();
    };
    let mut guard = lock_usage(state);
    if !guard.loaded {
        guard.entries = read_usage_at(&path);
        guard.loaded = true;
    }
    guard.entries.clone()
}

fn record_usage(
    app: &AppHandle,
    state: &LlmState,
    provider_id: &str,
    update: impl FnOnce(&mut UsageEntry),
) {
    let Ok(path) = usage_file(app) else {
        return;
    };
    let mut guard = lock_usage(state);
    if !guard.loaded {
        guard.entries = read_usage_at(&path);
        guard.loaded = true;
    }
    update(guard.entries.entry(provider_id.to_string()).or_default());
    let snapshot = guard.entries.clone();
    let _ = write_usage_at(&path, &snapshot);
}

// ---------- HTTP 策略（沿单端点时代的有界重试与降级） ----------

/// LLM 请求策略（对齐 OpenAI 官方 SDK 默认行为：max_retries=2，仅重试瞬时错误）。
const LLM_MAX_RETRIES: u32 = 2;
const LLM_BACKOFF_BASE_MS: u64 = 800;
const LLM_BACKOFF_JITTER_MS: u64 = 400;
/// Retry-After 超过该值视为额度类限流而非瞬时拥塞，直接判该提供商失败（lobe-chat #13572 的教训）。
const LLM_RETRY_AFTER_CAP_SECS: u64 = 30;
/// 测试连接 / 拉模型列表的外层超时（共享客户端总超时 120s，对交互式操作太长）。
const LLM_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

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
    let detail = if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = parsed["error"]["message"].as_str() {
            message.chars().take(240).collect()
        } else {
            body.chars().take(240).collect()
        }
    } else {
        body.chars().take(240).collect::<String>()
    };
    redact_secrets(&detail)
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

/// 单次 HTTP 失败在「单提供商重试循环」里的处置（故障转移分类的纯函数核心）。
enum HttpDisposition {
    /// 408/429/5xx 且 Retry-After 在阈值内：同端点退避重试。
    Retry,
    /// 400/401/403/404 等客户端错误：同端点重试无意义，立即换下一家。
    Switch,
    /// Retry-After 超过阈值：额度类限流，判该提供商失败（外层同样换下一家）。
    Dead,
}

fn http_disposition(status: u16, retry_after: Option<u64>) -> HttpDisposition {
    if retry_after.map(|secs| secs > LLM_RETRY_AFTER_CAP_SECS).unwrap_or(false) {
        return HttpDisposition::Dead;
    }
    if should_retry_status(status) {
        HttpDisposition::Retry
    } else {
        HttpDisposition::Switch
    }
}

struct ChatSuccess {
    content: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

async fn chat_once(
    provider: &ProviderCfg,
    system_prompt: Option<&str>,
    user_prompt: &str,
    use_json_mode: bool,
    temperature: f64,
    max_tokens: Option<u32>,
) -> Result<ChatSuccess, ChatError> {
    let url = format!(
        "{}/chat/completions",
        provider.base_url.trim_end_matches('/')
    );
    let mut messages = Vec::new();
    if let Some(system) = system_prompt {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": user_prompt }));
    let mut body = json!({
        "model": provider.model,
        "temperature": temperature,
        "messages": messages,
    });
    if let Some(max) = max_tokens {
        body["max_tokens"] = json!(max);
    }
    if use_json_mode {
        body["response_format"] = serde_json::json!({ "type": "json_object" });
    }
    let response = llm_http_client()
        .post(url)
        .bearer_auth(provider.api_key.trim())
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
    let content = parsed["choices"][0]["message"]["content"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
        .ok_or(ChatError::EmptyContent)?;
    Ok(ChatSuccess {
        content,
        input_tokens: parsed["usage"]["prompt_tokens"].as_u64(),
        output_tokens: parsed["usage"]["completion_tokens"].as_u64(),
    })
}

/// 单提供商的最终失败：message 为中文可行动信息，http_failure 标记是否计入用量 errors。
struct ProviderError {
    message: String,
    http_failure: bool,
}

impl ProviderError {
    fn http(message: String) -> Self {
        Self { message, http_failure: true }
    }

    fn non_http(message: String) -> Self {
        Self { message, http_failure: false }
    }
}

/// 单提供商内的有界重试循环（对外即「这一家的最终结果」）：
/// - response_format 被拒（400 且提及该字段）：去掉字段立即重试一次（不消耗退避预算）；
/// - 408/429/5xx/网络错误：指数退避 + 抖动重试至多 2 次，Retry-After 阈值内按服务端要求等待；
/// - 401/403/404 与重试耗尽：立即以失败返回（外层换下一家）。
async fn call_provider(
    provider: &ProviderCfg,
    system_prompt: Option<&str>,
    user_prompt: &str,
) -> Result<ChatSuccess, ProviderError> {
    let mut use_json_mode = true;
    let mut attempt: u32 = 0;
    loop {
        match chat_once(provider, system_prompt, user_prompt, use_json_mode, 0.2, None).await {
            Ok(success) => return Ok(success),
            Err(ChatError::Http { status, body, retry_after }) => {
                if use_json_mode && is_response_format_rejection(status, &body) {
                    use_json_mode = false;
                    continue;
                }
                let detail = extract_error_detail(&body);
                match http_disposition(status, retry_after) {
                    HttpDisposition::Dead => {
                        let secs = retry_after.unwrap_or(0);
                        return Err(ProviderError::http(format!(
                            "请求被限流（服务端要求等待 {secs} 秒），已停止重试：{detail}"
                        )));
                    }
                    HttpDisposition::Switch => {
                        return Err(ProviderError::http(friendly_llm_error(status, detail)));
                    }
                    HttpDisposition::Retry => {
                        if attempt >= LLM_MAX_RETRIES {
                            return Err(ProviderError::http(friendly_llm_error(status, detail)));
                        }
                        let delay = match retry_after {
                            Some(secs) => secs * 1000,
                            None => backoff_delay_ms(attempt),
                        };
                        tokio::time::sleep(Duration::from_millis(delay)).await;
                        attempt += 1;
                    }
                }
            }
            // 传输层错误可重试；finish_reason / 空内容是确定性失败，直接返回。
            Err(ChatError::Network(message)) => {
                if attempt >= LLM_MAX_RETRIES {
                    return Err(ProviderError::non_http(format!("LLM 网络错误：{message}")));
                }
                tokio::time::sleep(Duration::from_millis(backoff_delay_ms(attempt))).await;
                attempt += 1;
            }
            Err(ChatError::Truncated) => {
                return Err(ProviderError::non_http(
                    "模型输出被截断（finish_reason=length），JSON 可能不完整。请重试，或在设置中换用输出上限更高的模型。"
                        .into(),
                ));
            }
            Err(ChatError::ContentFilter) => {
                return Err(ProviderError::non_http("模型拒绝了这次请求（内容过滤）。".into()));
            }
            Err(ChatError::EmptyContent) => {
                return Err(ProviderError::non_http("模型返回为空".into()));
            }
        }
    }
}

/// 顺序故障转移的落点描述：成功方（含用量）或全部失败方的逐家错误。
enum JobOutcome {
    Success {
        content: String,
        provider_id: String,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    Failed(Vec<ProviderFailure>),
}

struct ProviderFailure {
    provider_id: String,
    label: String,
    message: String,
    http_failure: bool,
}

async fn complete_with_fallback(
    candidates: &[ProviderCfg],
    system_prompt: &str,
    user_prompt: &str,
) -> JobOutcome {
    let mut failures = Vec::new();
    for provider in candidates {
        match call_provider(provider, Some(system_prompt), user_prompt).await {
            Ok(success) => {
                return JobOutcome::Success {
                    content: success.content,
                    provider_id: provider.id.clone(),
                    input_tokens: success.input_tokens,
                    output_tokens: success.output_tokens,
                };
            }
            Err(err) => failures.push(ProviderFailure {
                provider_id: provider.id.clone(),
                label: provider.label.clone(),
                message: err.message,
                http_failure: err.http_failure,
            }),
        }
    }
    JobOutcome::Failed(failures)
}

/// 聚合错误（风格同 mineru.rs 的 aggregate_failures）：「<label>：<原因>；<label>：<原因>」。
/// 空 label 兜底「未命名服务」，不留空冒号。
fn aggregate_failures(failures: &[ProviderFailure]) -> String {
    failures
        .iter()
        .map(|f| {
            let label = if f.label.trim().is_empty() { "未命名服务" } else { &f.label };
            format!("{label}：{}", f.message)
        })
        .collect::<Vec<_>>()
        .join("；")
}

/// GET {base}/models 返回的 data[].id：去空、去重、排序。
fn parse_model_ids(value: &Value) -> Vec<String> {
    let mut ids: Vec<String> = value["data"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|item| item["id"].as_str())
                .filter(|id| !id.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    ids
}

// ---------- Tauri 命令（settings 一律从磁盘读，密钥不出网） ----------

#[tauri::command]
pub async fn llm_settings(
    app: AppHandle,
    state: State<'_, LlmState>,
) -> Result<LlmSettingsPublic, String> {
    let file = read_file(&app)?;
    Ok(to_public(&file, usage_snapshot(&app, &state)))
}

#[tauri::command]
pub async fn save_llm_settings(
    app: AppHandle,
    state: State<'_, LlmState>,
    settings: LlmSaveInput,
) -> Result<LlmSettingsPublic, String> {
    let existing = read_file(&app)?;
    let file = normalize_input(&settings, &existing);
    write_file_at(&settings_file(&app)?, &file)?;
    Ok(to_public(&file, usage_snapshot(&app, &state)))
}

/// 单提供商测试连接：读盘上该 provider，POST 一次极小请求测延迟（不重试、不带 response_format）。
#[tauri::command]
pub async fn llm_test(app: AppHandle, provider_id: String) -> Result<LlmTestResult, String> {
    let file = read_file(&app)?;
    let provider = file
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| "找不到该 LLM 提供商，请先保存配置".to_string())?;
    if provider.requires_key && provider.api_key.trim().is_empty() {
        return Ok(LlmTestResult {
            ok: false,
            latency_ms: 0,
            message: "尚未保存 API Key，请先填写并保存".into(),
        });
    }
    let started = Instant::now();
    let result = tokio::time::timeout(
        LLM_PROBE_TIMEOUT,
        chat_once(provider, None, "Reply with: ok", false, 0.0, Some(8)),
    )
    .await;
    let latency_ms = started.elapsed().as_millis() as u64;
    let ok = matches!(&result, Ok(Ok(_)));
    let message = match result {
        Err(_) => "连接超时（30 秒无响应），请检查 Base URL 与网络".to_string(),
        Ok(Ok(_)) => format!("测试通过：{} 正常响应", provider.model),
        Ok(Err(ChatError::Http { status, body, .. })) => {
            friendly_llm_error(status, extract_error_detail(&body))
        }
        Ok(Err(ChatError::Network(message))) => format!("LLM 网络错误：{message}"),
        Ok(Err(ChatError::Truncated)) => "模型输出被截断".to_string(),
        Ok(Err(ChatError::ContentFilter)) => "模型拒绝了这次请求（内容过滤）".to_string(),
        Ok(Err(ChatError::EmptyContent)) => "模型返回为空".to_string(),
    };
    Ok(LlmTestResult { ok, latency_ms, message })
}

/// 模型发现：GET {base}/models（有 Key 时带 Bearer），解析 data[].id 去重排序。
#[tauri::command]
pub async fn llm_list_models(
    app: AppHandle,
    provider_id: String,
) -> Result<Vec<String>, String> {
    let file = read_file(&app)?;
    let provider = file
        .providers
        .iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| "找不到该 LLM 提供商，请先保存配置".to_string())?;
    if provider.requires_key && provider.api_key.trim().is_empty() {
        return Err("尚未保存 API Key，无法拉取模型列表".into());
    }
    let url = format!("{}/models", provider.base_url.trim_end_matches('/'));
    let mut request = llm_http_client().get(url);
    if !provider.api_key.trim().is_empty() {
        request = request.bearer_auth(provider.api_key.trim());
    }
    let response = tokio::time::timeout(LLM_PROBE_TIMEOUT, request.send())
        .await
        .map_err(|_| "获取模型列表超时（30 秒），请检查网络".to_string())?
        .map_err(|e| format!("获取模型列表失败：{e}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取模型列表失败：{e}"))?;
    if !(200..300).contains(&status) {
        return Err(friendly_llm_error(status, extract_error_detail(&text)));
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|e| format!("模型列表无法解析：{e}"))?;
    Ok(parse_model_ids(&parsed))
}

#[tauri::command]
pub async fn llm_complete(
    app: AppHandle,
    state: State<'_, LlmState>,
    job_id: String,
    system_prompt: String,
    user_prompt: String,
) -> Result<String, String> {
    let file = read_file(&app)?;
    let candidates = usable_providers(&file);
    if candidates.is_empty() {
        return Err("NO_API_KEY".into());
    }
    let job_key = job_id.clone();
    // 取消传播：先占位再放行请求，避免 cancel 落在 spawn 与登记 abort handle 之间。
    let (permit_tx, permit_rx) = tokio::sync::oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let _ = permit_rx.await;
        complete_with_fallback(&candidates, &system_prompt, &user_prompt).await
    });
    {
        let mut jobs = state.jobs.lock().unwrap_or_else(|err| err.into_inner());
        if jobs.cancelled.remove(&job_key).is_some() {
            drop(jobs);
            handle.abort();
            return Err("LLM job cancelled".into());
        }
        jobs.handles.insert(job_key.clone(), handle.abort_handle());
    }
    let _ = permit_tx.send(());
    let outcome = handle.await.map_err(|_| "LLM job cancelled".to_string())?;
    {
        let mut jobs = state.jobs.lock().unwrap_or_else(|err| err.into_inner());
        jobs.handles.remove(&job_key);
    }
    match outcome {
        JobOutcome::Success { content, provider_id, input_tokens, output_tokens } => {
            record_usage(&app, &state, &provider_id, |entry| {
                entry.record_success(input_tokens, output_tokens)
            });
            Ok(content)
        }
        JobOutcome::Failed(failures) => {
            for failure in failures.iter().filter(|f| f.http_failure) {
                record_usage(&app, &state, &failure.provider_id, |entry| entry.record_error());
            }
            Err(aggregate_failures(&failures))
        }
    }
}

#[tauri::command]
pub fn llm_cancel(state: State<LlmState>, job_id: String) -> Result<(), String> {
    let mut jobs = state.jobs.lock().unwrap_or_else(|err| err.into_inner());
    if let Some(handle) = jobs.handles.remove(&job_id) {
        handle.abort();
    } else {
        jobs.cancelled.insert(job_id, ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = crate::test_util::unique_temp_dir(&format!("pf-llm-{tag}"));
        dir
    }

    fn cfg(id: &str, enabled: bool, requires_key: bool, api_key: &str) -> ProviderCfg {
        ProviderCfg {
            id: id.into(),
            preset_id: None,
            label: format!("服务{id}"),
            base_url: "https://api.deepseek.com/v1".into(),
            model: "deepseek-chat".into(),
            enabled,
            requires_key,
            api_key: api_key.into(),
        }
    }

    // ---------- 迁移：v1 扁平 -> v2、Key 保留、.bak ----------

    #[test]
    fn migrate_v1_flat_keeps_key_and_maps_preset() {
        let raw = r#"{"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-old"}"#;
        let (file, migrated) = parse_settings(raw).unwrap();
        assert!(migrated);
        assert_eq!(file.version, 2);
        assert_eq!(file.providers.len(), 1);
        let p = &file.providers[0];
        assert_eq!(p.preset_id.as_deref(), Some("deepseek"));
        assert_eq!(p.label, "DeepSeek");
        assert_eq!(p.base_url, "https://api.deepseek.com/v1");
        assert_eq!(p.model, "deepseek-chat");
        assert_eq!(p.api_key, "sk-old", "迁移必须保留 Key");
        assert!(p.enabled);
        assert!(p.requires_key);
        assert!(!p.id.is_empty());
    }

    #[test]
    fn migrate_v1_clobbered_store_format_still_recovers_fields() {
        // 历史镜像写入的键值格式（无 version/apiKey）曾让启动解析失败；
        // 现在走迁移路径宽容恢复 baseUrl/model（apiKey 缺省为空）。
        let raw = r#"{"hasKey":true,"model":"deepseek-flash","baseUrl":"https://api.deepseek.com"}"#;
        let (file, migrated) = parse_settings(raw).unwrap();
        assert!(migrated);
        let p = &file.providers[0];
        assert_eq!(p.model, "deepseek-flash");
        assert_eq!(p.base_url, "https://api.deepseek.com");
        assert_eq!(p.api_key, "");
        // 裸域名靠主机名反查也能命中预设
        assert_eq!(p.preset_id.as_deref(), Some("deepseek"));
    }

    #[test]
    fn migrate_v1_custom_base_without_preset() {
        let raw = r#"{"baseUrl":"https://llm.example.com/v1","model":"m","apiKey":"k"}"#;
        let (file, migrated) = parse_settings(raw).unwrap();
        assert!(migrated);
        let p = &file.providers[0];
        assert!(p.preset_id.is_none(), "反查不到预设时 presetId 为 null");
        assert_eq!(p.label, "自定义服务");
        assert!(p.requires_key, "自定义默认需 Key");
        assert_eq!(p.api_key, "k");
    }

    #[test]
    fn migrate_v1_local_presets_are_key_free() {
        for (base, id, label) in [
            ("http://localhost:11434/v1", "ollama", "Ollama 本地"),
            ("http://localhost:1234/v1", "lmstudio", "LM Studio"),
        ] {
            let raw = format!(r#"{{"baseUrl":"{base}","model":"llama3","apiKey":""}}"#);
            let (file, _) = parse_settings(&raw).unwrap();
            let p = &file.providers[0];
            assert_eq!(p.preset_id.as_deref(), Some(id), "{base}");
            assert_eq!(p.label, label);
            assert!(!p.requires_key, "{base} 本地服务免 Key");
        }
    }

    #[test]
    fn migrate_v1_empty_object_falls_back_to_openai_defaults() {
        let (file, migrated) = parse_settings("{}").unwrap();
        assert!(migrated);
        let p = &file.providers[0];
        assert_eq!(p.base_url, V1_DEFAULT_BASE_URL);
        assert_eq!(p.model, V1_DEFAULT_MODEL);
        assert_eq!(p.preset_id.as_deref(), Some("openai"));
        assert_eq!(p.api_key, "");
    }

    #[test]
    fn corrupt_json_is_not_treated_as_v1() {
        for raw in ["not json at all", "null", "[]"] {
            let err = parse_settings(raw).unwrap_err();
            assert!(err.contains("保留原文件") || err.contains("无法解析") || err.contains("不是 JSON"), "{raw}: {err}");
        }
    }

    #[test]
    fn read_or_migrate_at_backs_up_v1_and_rewrites_v2() {
        let dir = temp_dir("migrate");
        let path = dir.join("llm-settings.json");
        let v1_raw = r#"{"baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-old"}"#;
        fs::write(&path, v1_raw).unwrap();

        let file = read_or_migrate_at(&path).unwrap();
        assert_eq!(file.providers[0].api_key, "sk-old");

        let bak = dir.join("llm-settings.json.v1.bak");
        assert!(bak.exists(), "应生成备份 {}", bak.display());
        let bak_raw = fs::read_to_string(&bak).unwrap();
        assert!(bak_raw.contains("deepseek-chat"), "备份保留非密钥字段：{bak_raw}");
        assert!(!bak_raw.contains("sk-old"), "备份也要抹掉 Key：{bak_raw}");

        let rewritten = fs::read_to_string(&path).unwrap();
        assert!(rewritten.contains("\"version\": 2"), "写回 v2：{rewritten}");
        assert!(!rewritten.contains("sk-old"), "明文 Key 不得留在设置文件：{rewritten}");

        // 二次读取从密钥库取回 Key，不再改写备份。
        let again = read_or_migrate_at(&path).unwrap();
        assert_eq!(again.providers[0].api_key, "sk-old");
        assert!(!fs::read_to_string(&bak).unwrap().contains("sk-old"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_or_migrate_at_missing_file_returns_empty_v2() {
        let dir = temp_dir("missing");
        let path = dir.join("llm-settings.json");
        let file = read_or_migrate_at(&path).unwrap();
        assert_eq!(file.version, 2);
        assert!(file.providers.is_empty());
        assert!(!path.exists(), "不落盘");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn parse_settings_dispatches_by_version_and_rejects_newer() {
        let v2_raw = r#"{"version":2,"providers":[{"id":"p1"}]}"#;
        let (file, migrated) = parse_settings(v2_raw).unwrap();
        assert!(!migrated);
        assert_eq!(file.version, 2);

        // 更高版本静默迁移会把用户数据洗掉，必须显式报错
        let err = parse_settings(r#"{"version":3,"providers":[]}"#).unwrap_err();
        assert!(err.contains("版本过新"), "{err}");
    }

    #[test]
    fn parse_v2_corrupt_fields_are_left_untouched() {
        for raw in [r#"{"version":2,"providers":"oops"}"#, r#"{"version":2,"providers":[{"id":123}]}"#] {
            let err = parse_settings(raw).unwrap_err();
            assert!(err.contains("无法解析") || err.contains("保留原文件"), "{raw}: {err}");
        }
    }

    #[test]
    fn read_or_migrate_at_refuses_corrupt_v2_without_rewriting() {
        let dir = temp_dir("corrupt-v2");
        let path = dir.join("llm-settings.json");
        let corrupt = r#"{"version":2,"providers":"oops"}"#;
        fs::write(&path, corrupt).unwrap();

        let err = read_or_migrate_at(&path).unwrap_err();
        assert!(err.contains("无法解析") || err.contains("保留原文件"), "{err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), corrupt, "坏文件必须原样保留");
        assert!(!dir.join("llm-settings.json.v1.bak").exists());
        fs::remove_dir_all(&dir).ok();
    }

    // ---------- v2 宽容解析（迁自 lib.rs settings_file_tests） ----------

    #[test]
    fn v2_parse_tolerates_partial_provider_fields() {
        let raw = r#"{"version":2,"providers":[{"id":"p1","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat"},{"id":"p2"}]}"#;
        let (file, migrated) = parse_settings(raw).unwrap();
        assert!(!migrated);
        assert_eq!(file.providers.len(), 2);
        assert_eq!(file.providers[0].preset_id, None);
        assert!(file.providers[0].enabled, "缺省视为启用");
        assert!(file.providers[0].requires_key);
        assert_eq!(file.providers[0].api_key, "");
        assert_eq!(file.providers[1].base_url, "");
        assert_eq!(file.providers[1].label, "");
    }

    // ---------- 三态 Key 与保存归一 ----------

    fn save_input_one(id: &str, api_key: Option<&str>) -> LlmSaveInput {
        LlmSaveInput {
            providers: vec![ProviderInput {
                id: id.into(),
                preset_id: Some("deepseek".into()),
                label: "DeepSeek".into(),
                base_url: "https://api.deepseek.com/v1".into(),
                model: "deepseek-chat".into(),
                enabled: true,
                requires_key: true,
                api_key: api_key.map(str::to_string),
            }],
        }
    }

    #[test]
    fn normalize_input_api_key_three_states() {
        let mut existing = LlmFileV2::default();
        existing.providers.push(cfg("p1", true, true, "sk-keep"));

        // None → 按 id 保留已存 Key
        let file = normalize_input(&save_input_one("p1", None), &existing);
        assert_eq!(file.providers[0].api_key, "sk-keep");
        // Some("") → 显式清除
        let file = normalize_input(&save_input_one("p1", Some("")), &existing);
        assert_eq!(file.providers[0].api_key, "");
        // Some(" sk-new ") → trim 后写入
        let file = normalize_input(&save_input_one("p1", Some(" sk-new ")), &existing);
        assert_eq!(file.providers[0].api_key, "sk-new");
        // 未知 id + None → 无旧记录可保留，视为空
        let file = normalize_input(&save_input_one("fresh", None), &existing);
        assert_eq!(file.providers[0].api_key, "");
    }

    #[test]
    fn save_input_wire_format_uses_camel_case_and_optional_key() {
        // apiKey 缺省 / null 都是 None（保留语义）
        let parsed: LlmSaveInput = serde_json::from_str(
            r#"{"providers":[{"id":"p1","presetId":"deepseek","label":"DeepSeek","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","enabled":true,"requiresKey":true}]}"#,
        )
        .unwrap();
        assert_eq!(parsed.providers.len(), 1);
        assert!(parsed.providers[0].api_key.is_none());

        let parsed: LlmSaveInput = serde_json::from_str(
            r#"{"providers":[{"id":"p1","apiKey":null,"label":"x","enabled":false}]}"#,
        )
        .unwrap();
        assert!(parsed.providers[0].api_key.is_none());
        assert!(!parsed.providers[0].enabled, "显式 false 生效");
    }

    #[test]
    fn normalize_input_generates_ids_for_blank_and_duplicate() {
        let input = LlmSaveInput {
            providers: vec![
                ProviderInput { id: "  ".into(), ..Default::default() },
                ProviderInput { id: "  ".into(), ..Default::default() },
                ProviderInput { id: "dup".into(), ..Default::default() },
                ProviderInput { id: "dup".into(), ..Default::default() },
            ],
        };
        let file = normalize_input(&input, &LlmFileV2::default());
        let ids: Vec<&String> = file.providers.iter().map(|p| &p.id).collect();
        assert!(ids.iter().all(|id| !id.trim().is_empty()));
        let mut unique = ids.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(unique.len(), ids.len(), "id 不得重复：{ids:?}");
        assert_eq!(file.version, 2);
        assert_eq!(file.providers[0].label, "自定义服务", "空 label 兜底");
        assert!(file.providers[0].requires_key);
    }

    // ---------- 公共视图 ----------

    #[test]
    fn public_view_hides_key_and_reports_has_key() {
        let mut file = LlmFileV2::default();
        file.providers.push(cfg("p1", true, true, "sk-x"));
        file.providers.push(cfg("p2", false, false, "  "));

        let mut usage = HashMap::new();
        let mut entry = UsageEntry::default();
        entry.record_success(Some(120), Some(80));
        usage.insert("p1".to_string(), entry);

        let raw = serde_json::to_value(to_public(&file, usage)).unwrap();
        assert_eq!(raw["version"], 2);
        assert!(raw["providers"][0]["hasKey"].as_bool().unwrap());
        assert!(
            raw["providers"][0].get("apiKey").is_none(),
            "密钥字段绝不出现在公共视图"
        );
        assert_eq!(raw["providers"][0]["presetId"], serde_json::Value::Null);
        assert!(!raw["providers"][1]["hasKey"].as_bool().unwrap());
        assert_eq!(raw["usage"]["p1"]["requests"], 1);
        assert_eq!(raw["usage"]["p1"]["inputTokens"], 120);
        assert_eq!(raw["usage"]["p1"]["outputTokens"], 80);
        assert!(raw["usage"]["p1"]["lastUsedAt"].is_u64());
    }

    // ---------- 故障转移分类 ----------

    #[test]
    fn http_disposition_switches_on_client_errors_and_retries_transient() {
        // 401/403/404（以及 400/422）同端点重试无意义：直接换下一家
        for status in [400u16, 401, 403, 404, 422] {
            assert!(
                matches!(http_disposition(status, None), HttpDisposition::Switch),
                "{status} 应立即换下一家"
            );
        }
        // 408/429/5xx：同端点退避重试
        for status in [408u16, 429, 500, 502, 503] {
            assert!(
                matches!(http_disposition(status, None), HttpDisposition::Retry),
                "{status} 应重试"
            );
        }
        // Retry-After 超过 30s：额度类限流，判该提供商失败
        assert!(matches!(http_disposition(429, Some(31)), HttpDisposition::Dead));
        assert!(matches!(http_disposition(503, Some(120)), HttpDisposition::Dead));
        // 阈值边界：30s 仍走重试
        assert!(matches!(http_disposition(429, Some(30)), HttpDisposition::Retry));
        assert!(matches!(http_disposition(429, Some(5)), HttpDisposition::Retry));
    }

    #[test]
    fn usable_providers_filters_by_enabled_and_key() {
        let mut file = LlmFileV2::default();
        file.providers.push(cfg("off", false, true, "k")); // 已停用
        file.providers.push(cfg("nokey", true, true, "  ")); // 需 Key 但没 Key
        file.providers.push(cfg("keyed", true, true, "sk"));
        file.providers.push(cfg("local", true, false, "")); // 免 Key
        let ids: Vec<String> = usable_providers(&file)
            .iter()
            .map(|p| p.id.clone())
            .collect();
        assert_eq!(ids, vec!["keyed".to_string(), "local".to_string()], "顺序即回退顺序");
    }

    #[test]
    fn aggregate_failures_lists_each_provider_in_chinese() {
        let failures = vec![
            ProviderFailure {
                provider_id: "a".into(),
                label: "DeepSeek".into(),
                message: "LLM 鉴权失败：请检查设置页的 API Key（bad key）".into(),
                http_failure: true,
            },
            ProviderFailure {
                provider_id: "b".into(),
                label: "智谱 GLM".into(),
                message: "LLM 服务端错误（HTTP 500）：boom".into(),
                http_failure: true,
            },
        ];
        let message = aggregate_failures(&failures);
        assert!(message.starts_with("DeepSeek："), "{message}");
        assert!(message.contains("智谱 GLM："), "{message}");
        assert_eq!(message.matches('；').count(), 1, "多家之间用分号：{message}");
        // 空 label 兜底，不留空冒号
        let anonymous = vec![ProviderFailure {
            provider_id: "c".into(),
            label: "".into(),
            message: "x".into(),
            http_failure: false,
        }];
        assert!(aggregate_failures(&anonymous).starts_with("未命名服务："));
    }

    // ---------- 用量记账 ----------

    #[test]
    fn usage_entry_accounts_success_and_http_errors() {
        let mut entry = UsageEntry::default();
        entry.record_success(Some(120), Some(80));
        entry.record_success(None, None); // 响应缺 usage 字段也计一次请求
        assert_eq!(entry.requests, 2);
        assert_eq!(entry.input_tokens, 120);
        assert_eq!(entry.output_tokens, 80);
        assert!(entry.last_used_at.is_some());
        assert_eq!(entry.errors, 0);

        entry.record_error();
        entry.record_error();
        assert_eq!(entry.errors, 2);
        assert_eq!(entry.requests, 2, "失败不增加请求数");
    }

    #[test]
    fn usage_file_round_trip_and_tolerant_read() {
        let dir = temp_dir("usage");
        let path = dir.join("llm-usage.json");
        let mut map = HashMap::new();
        let mut entry = UsageEntry::default();
        entry.record_success(Some(10), Some(5));
        map.insert("p1".to_string(), entry);
        write_usage_at(&path, &map).unwrap();

        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"inputTokens\": 10"), "camelCase 落盘：{raw}");
        assert!(raw.contains("\"lastUsedAt\""), "{raw}");
        assert!(!raw.contains("llm-settings"), "用量与设置分开：{raw}");

        let back = read_usage_at(&path);
        assert_eq!(back["p1"].requests, 1);
        assert_eq!(back["p1"].input_tokens, 10);
        assert_eq!(back["p1"].output_tokens, 5);

        // 残缺文件宽容读取：坏 JSON → 空 map，不 panic
        fs::write(&path, "not json").unwrap();
        assert!(read_usage_at(&path).is_empty());
        // 缺省字段补零
        fs::write(&path, r#"{"p2":{"requests":3}}"#).unwrap();
        let partial = read_usage_at(&path);
        assert_eq!(partial["p2"].requests, 3);
        assert_eq!(partial["p2"].errors, 0);
        fs::remove_dir_all(&dir).ok();
    }

    // ---------- 模型列表解析 ----------

    #[test]
    fn parse_model_ids_dedups_and_sorts() {
        let value: Value = serde_json::from_str(
            r#"{"data":[{"id":"z-model"},{"id":"a-model"},{"id":"a-model"},{"object":"model"},{"id":""}]}"#,
        )
        .unwrap();
        assert_eq!(
            parse_model_ids(&value),
            vec!["a-model".to_string(), "z-model".to_string()]
        );
        // data 缺失 / 非数组 → 空列表
        assert!(parse_model_ids(&json!({})).is_empty());
        assert!(parse_model_ids(&json!({"data": "oops"})).is_empty());
    }

    // ---------- 预设反查 ----------

    #[test]
    fn preset_lookup_by_exact_prefix_and_host() {
        assert_eq!(preset_for_base_url("https://api.deepseek.com/v1").map(|p| p.id), Some("deepseek"));
        assert_eq!(preset_for_base_url("https://api.deepseek.com/v1/").map(|p| p.id), Some("deepseek"));
        assert_eq!(preset_for_base_url("https://api.deepseek.com").map(|p| p.id), Some("deepseek"));
        assert_eq!(
            preset_for_base_url("https://dashscope.aliyuncs.com/compatible-mode/v1").map(|p| p.id),
            Some("qwen")
        );
        assert_eq!(
            preset_for_base_url("https://open.bigmodel.cn/api/paas/v4").map(|p| p.id),
            Some("zhipu")
        );
        assert_eq!(preset_for_base_url("http://localhost:11434/v1").map(|p| p.id), Some("ollama"));
        assert_eq!(preset_for_base_url("  https://api.moonshot.cn/v1  ").map(|p| p.id), Some("moonshot"));
        // 前缀相似但主机不同 / 空值 → 反查不到
        assert!(preset_for_base_url("https://api.openai.com.evil.com/v1").is_none());
        assert!(preset_for_base_url("https://my-proxy.example.com/v1").is_none());
        assert!(preset_for_base_url("").is_none());
    }

    // ---------- id 生成 ----------

    #[test]
    fn new_provider_id_looks_like_uuid_and_is_unique() {
        let a = new_provider_id();
        let b = new_provider_id();
        assert_ne!(a, b);
        for id in [a, b] {
            let parts: Vec<&str> = id.split('-').collect();
            assert_eq!(
                parts.iter().map(|p| p.len()).collect::<Vec<_>>(),
                vec![8, 4, 4, 4, 12],
                "{id}"
            );
            assert!(id.chars().all(|c| c.is_ascii_hexdigit() || c == '-'), "{id}");
            assert!(parts[2].starts_with('4'), "v4 版本位：{id}");
        }
    }

    // ---------- 迁自 lib.rs llm_tests 的原有行为 ----------

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
