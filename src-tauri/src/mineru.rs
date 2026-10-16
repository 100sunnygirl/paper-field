//! MinerU 三源接入：本地 CLI（unix socket）、SSH 远程（doclib.sock）、官方 API（mineru.net）。
//!
//! - 全部命令 async，ssh/scp/curl 与本地进程都包在参数化超时里，绝不阻塞主线程；
//! - 恢复语义：`mineru_parse_statuses` / `mineru_markdown` 的 provider 必填、不自动回退
//!   （doclib short_id 与官方 API batch_id 属不同命名空间，中途换源只能重新提交）；
//! - 跨源切换的唯一入口是 `mineru_submit(provider=None)`：按 order 逐源探测并提交，
//!   失败自动试下一源，全部失败返回聚合中文错误。
#![deny(clippy::string_slice)]

use std::collections::HashMap;
use std::fs;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::app_config_dir;
use crate::mineru_api::ApiClient;
use crate::platform;
use crate::transport::{DoclibTransport, SshResolved};

/// 超时常量（with_timeout 的生产值；测试可注入短值）。
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const SUBMIT_TIMEOUT: Duration = Duration::from_secs(180);
pub(crate) const POLL_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const FETCH_TIMEOUT: Duration = Duration::from_secs(300);

/// curl 自身 --max-time（比外层超时略小，作为第二道防线）。
/// PROBE 需容纳 doclib /status 的慢响应：实测 4.0.5 空闲即 ~5.5s，繁忙时超 8s。
const CURL_PROBE: u64 = 15;
const CURL_SUBMIT: u64 = 170;
const CURL_POLL: u64 = 55;
const CURL_FETCH: u64 = 290;

/// ssh ConnectTimeout：探测 5s，正式提交 20s。
const SSH_CONNECT_NORMAL: u64 = 20;
const SSH_CONNECT_PROBE: u64 = 5;

/// 参数化超时封装：超时后 future 被 drop，配合 kill_on_drop 会杀掉子进程。
pub(crate) async fn with_timeout<T>(
    dur: Duration,
    fut: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    match tokio::time::timeout(dur, fut).await {
        Ok(result) => result,
        Err(_) => Err(format!("操作超时（超过 {} 秒），已自动中止", dur.as_secs())),
    }
}

// ---------- 设置：v2 结构、v1 迁移、读写 ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCfg {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_socket")]
    pub socket_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCfg {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    #[serde(default)]
    pub user: String,
    #[serde(default)]
    pub identity_file: String,
    #[serde(default = "default_socket")]
    pub socket_path: String,
    #[serde(default = "default_inbox")]
    pub inbox_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCfg {
    #[serde(default)]
    pub token: String,
    #[serde(default = "default_model_version")]
    pub model_version: String,
    #[serde(default = "default_language")]
    pub language: String,
    #[serde(default = "default_true")]
    pub enable_formula: bool,
    #[serde(default = "default_true")]
    pub enable_table: bool,
}

/// mineru-settings.json v2（磁盘格式；不含派生字段 configured）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MineruFileV2 {
    #[serde(default)]
    pub version: u32,
    #[serde(default = "default_order")]
    pub order: Vec<String>,
    #[serde(default = "default_local_cfg")]
    pub local: LocalCfg,
    #[serde(default = "default_ssh_cfg")]
    pub ssh: SshCfg,
    #[serde(default = "default_api_cfg")]
    pub api: ApiCfg,
    #[serde(default = "default_tier")]
    pub tier: String,
    #[serde(default = "default_page_range")]
    pub page_range: String,
}

/// 旧版（v1）磁盘格式，仅为迁移保留。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MineruFileV1 {
    mode: String,
    #[serde(default)]
    socket_path: String,
    #[serde(default)]
    ssh_host: String,
    #[serde(default)]
    ssh_port: u16,
    #[serde(default)]
    ssh_user: String,
    #[serde(default)]
    identity_file: String,
    #[serde(default)]
    remote_inbox: String,
    #[serde(default)]
    tier: String,
    #[serde(default)]
    page_range: String,
}

/// 前端保存入参：token 三态（None=保留、Some("")=清除、Some(x)=写入）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalInput {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    socket_path: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshInput {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: u16,
    #[serde(default)]
    user: String,
    #[serde(default)]
    identity_file: String,
    #[serde(default)]
    socket_path: String,
    #[serde(default)]
    inbox_dir: String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiInput {
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    model_version: Option<String>,
    #[serde(default)]
    language: Option<String>,
    #[serde(default)]
    enable_formula: Option<bool>,
    #[serde(default)]
    enable_table: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MineruInputV2 {
    #[serde(default)]
    order: Vec<String>,
    #[serde(default)]
    local: LocalInput,
    #[serde(default)]
    ssh: SshInput,
    #[serde(default)]
    api: ApiInput,
    #[serde(default)]
    tier: String,
    #[serde(default)]
    page_range: String,
}

/// 对外视图：token 永不回显，只返回 hasToken；configured 为派生字段。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MineruPublic {
    version: u32,
    order: Vec<String>,
    local: LocalPublic,
    ssh: SshPublic,
    api: ApiPublic,
    tier: String,
    page_range: String,
    configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPublic {
    enabled: bool,
    socket_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SshPublic {
    enabled: bool,
    host: String,
    port: u16,
    user: String,
    identity_file: String,
    socket_path: String,
    inbox_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiPublic {
    has_token: bool,
    model_version: String,
    language: String,
    enable_formula: bool,
    enable_table: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
    /// 实际使用的来源："local" | "ssh" | "api"。
    pub provider: String,
    /// 本地路径（local）/远程路径（ssh），api 为空串。
    pub remote_path: String,
    /// doclib short_id / 官方 API batch_id。
    pub short_id: String,
    /// doclib 数字 id 字符串化；api 为空。
    pub parse_ids: Vec<String>,
    pub status: String,
    /// doclib tier；api 为 model_version。
    pub tier: String,
    /// `pf-cred-v1:` plus the SHA-256 of the submit-time credential payload.
    pub cred_fingerprint: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParsePoll {
    pub id: String,
    pub status: String,
    pub error: Option<String>,
    /// 进度「已解析页/总页数」（官方 API 提供；doclib 为 None）。
    pub progress: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub provider: String,
    pub ok: bool,
    pub latency_ms: u64,
    pub message: String,
}

/// pick_provider 的注入探针（与前端 mineruPlan.pickProviderFromHealths 同义）。
#[derive(Clone, Debug)]
pub struct HealthProbe {
    pub provider: String,
    pub ok: bool,
    pub message: String,
}

fn default_socket() -> String {
    "~/.mineru/doclib.sock".into()
}

fn default_order() -> Vec<String> {
    vec!["local".into(), "ssh".into(), "api".into()]
}

fn default_local_cfg() -> LocalCfg {
    LocalCfg {
        enabled: false,
        socket_path: default_socket(),
    }
}

fn default_ssh_cfg() -> SshCfg {
    SshCfg {
        enabled: false,
        host: String::new(),
        port: default_ssh_port(),
        user: String::new(),
        identity_file: String::new(),
        socket_path: default_socket(),
        inbox_dir: default_inbox(),
    }
}

fn default_api_cfg() -> ApiCfg {
    ApiCfg {
        token: String::new(),
        model_version: default_model_version(),
        language: default_language(),
        enable_formula: true,
        enable_table: true,
    }
}

fn default_inbox() -> String {
    "~/.mineru/paper-field-inbox".into()
}

fn default_ssh_port() -> u16 {
    22
}

fn default_model_version() -> String {
    "pipeline".into()
}

fn default_language() -> String {
    "ch".into()
}

fn default_true() -> bool {
    true
}

fn default_tier() -> String {
    "standard".into()
}

fn default_page_range() -> String {
    "all".into()
}

fn default_file_v2() -> MineruFileV2 {
    MineruFileV2 {
        version: 2,
        order: default_order(),
        local: default_local_cfg(),
        ssh: default_ssh_cfg(),
        api: default_api_cfg(),
        tier: default_tier(),
        page_range: default_page_range(),
    }
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join("mineru-settings.json"))
}

/// 解析设置原文；v1 自动迁移为 v2，迁移失败必须报错（静默回退会丢用户 SSH 配置）。
/// 返回 (文件, 是否发生了迁移)。
fn parse_settings(raw: &str) -> Result<(MineruFileV2, bool), String> {
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("MinerU 设置无法解析：{e}"))?;
    match value.get("version").and_then(Value::as_u64) {
        Some(2) => {
            let file: MineruFileV2 =
                serde_json::from_value(value).map_err(|e| format!("MinerU 设置无法解析：{e}"))?;
            Ok((file, false))
        }
        _ => Ok((migrate_v1(&value)?, true)),
    }
}

/// v1 → v2 迁移：
/// - mode=local → local.enabled；mode=ssh → ssh.enabled；mode=off → 三源全 disabled；
/// - v1 的 socket_path 同时写入 local 与 ssh（旧版两种模式共用该字段）；
/// - order 初始为 [启用的源, 其余按 local→ssh→api]。
fn migrate_v1(value: &Value) -> Result<MineruFileV2, String> {
    let v1: MineruFileV1 = serde_json::from_value(value.clone())
        .map_err(|e| format!("旧版 MinerU 设置无法迁移：{e}"))?;
    let socket = fallback(v1.socket_path.trim(), &default_socket());
    let local_enabled = v1.mode.trim() == "local";
    let ssh_enabled = v1.mode.trim() == "ssh";
    let mut order = Vec::new();
    if ssh_enabled {
        order.push("ssh".to_string());
    }
    if local_enabled {
        order.push("local".to_string());
    }
    for name in ["local", "ssh", "api"] {
        if !order.iter().any(|x| x == name) {
            order.push(name.to_string());
        }
    }
    Ok(MineruFileV2 {
        version: 2,
        order,
        local: LocalCfg {
            enabled: local_enabled,
            socket_path: socket.clone(),
        },
        ssh: SshCfg {
            enabled: ssh_enabled,
            host: v1.ssh_host.trim().to_string(),
            port: if v1.ssh_port == 0 { 22 } else { v1.ssh_port },
            user: v1.ssh_user.trim().to_string(),
            identity_file: v1.identity_file.trim().to_string(),
            socket_path: socket,
            inbox_dir: fallback(v1.remote_inbox.trim(), &default_inbox()),
        },
        api: ApiCfg {
            token: String::new(),
            model_version: default_model_version(),
            language: default_language(),
            enable_formula: true,
            enable_table: true,
        },
        tier: if matches!(v1.tier.trim(), "flash" | "basic" | "standard" | "advanced") {
            v1.tier.trim().to_string()
        } else {
            default_tier()
        },
        page_range: if valid_page_range(v1.page_range.trim()) {
            v1.page_range.trim().to_string()
        } else {
            default_page_range()
        },
    })
}

/// 读取设置；若发生 v1→v2 迁移，先把原文件备份为 mineru-settings.v1.bak（仅一次）再回写 v2。
fn read_file(app: &AppHandle) -> Result<MineruFileV2, String> {
    let path = settings_file(app)?;
    if !path.exists() {
        return Ok(default_file_v2());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取 MinerU 设置失败：{e}"))?;
    scrub_mineru_backup(&path)?;
    let (mut file, migrated) = parse_settings(&raw)?;
    let store = crate::secrets::store_for(path.parent().unwrap_or_else(|| Path::new(".")));
    let mut lifted = false;
    if !file.api.token.trim().is_empty() {
        store.set(crate::secrets::MINERU_ACCOUNT, file.api.token.trim())?;
        lifted = true;
    } else if let Some(token) = store.get(crate::secrets::MINERU_ACCOUNT)? {
        file.api.token = token;
    }
    if migrated || lifted {
        if migrated {
            let bak = path.with_extension("v1.bak");
            if !bak.exists() {
                crate::io_util::atomic_write(&bak, crate::secrets::scrub_json_secrets(&raw).as_bytes())?;
            } else {
                scrub_mineru_backup(&path)?;
            }
        }
        file.version = 2;
        write_public_mineru(&path, &file)?;
    }
    Ok(file)
}

fn scrub_mineru_backup(path: &Path) -> Result<(), String> {
    let bak = path.with_extension("v1.bak");
    if !bak.exists() {
        return Ok(());
    }
    let raw = fs::read_to_string(&bak).map_err(|err| err.to_string())?;
    let cleaned = crate::secrets::scrub_json_secrets(&raw);
    if cleaned != raw {
        crate::io_util::atomic_write(&bak, cleaned.as_bytes())?;
    }
    Ok(())
}

fn write_public_mineru(path: &Path, file: &MineruFileV2) -> Result<(), String> {
    let mut public = file.clone();
    public.api.token.clear();
    let raw = serde_json::to_string_pretty(&public).map_err(|err| err.to_string())?;
    crate::io_util::atomic_write(path, raw.as_bytes())
}

fn write_file_at(path: &Path, file: &MineruFileV2) -> Result<(), String> {
    let store = crate::secrets::store_for(path.parent().unwrap_or_else(|| Path::new(".")));
    store.set(crate::secrets::MINERU_ACCOUNT, file.api.token.trim())?;
    write_public_mineru(path, file)
}

/// 修正 order：过滤非法项与重复项，补全缺失来源（按 local→ssh→api 追加）。
fn normalize_order(raw: &[String]) -> Vec<String> {
    let mut order: Vec<String> = Vec::new();
    for name in raw {
        let name = name.trim();
        if matches!(name, "local" | "ssh" | "api") && !order.iter().any(|x| x == name) {
            order.push(name.to_string());
        }
    }
    for name in ["local", "ssh", "api"] {
        if !order.iter().any(|x| x == name) {
            order.push(name.to_string());
        }
    }
    order
}

fn normalize_input(input: &MineruInputV2, existing: &MineruFileV2) -> MineruFileV2 {
    let local = LocalCfg {
        enabled: input.local.enabled,
        socket_path: fallback(input.local.socket_path.trim(), &default_socket()),
    };
    let ssh = SshCfg {
        enabled: input.ssh.enabled,
        host: input.ssh.host.trim().to_string(),
        port: if input.ssh.port == 0 {
            22
        } else {
            input.ssh.port
        },
        user: input.ssh.user.trim().to_string(),
        identity_file: input.ssh.identity_file.trim().to_string(),
        socket_path: fallback(input.ssh.socket_path.trim(), &default_socket()),
        inbox_dir: fallback(input.ssh.inbox_dir.trim(), &default_inbox()),
    };
    // token 三态：None=保留已存、Some("")=清除、Some(x)=写入。
    let token = match input.api.token.as_deref() {
        None => existing.api.token.clone(),
        Some(value) if value.trim().is_empty() => String::new(),
        Some(value) => value.trim().to_string(),
    };
    let api = ApiCfg {
        token,
        model_version: match input.api.model_version.as_deref().map(str::trim) {
            Some("vlm") => "vlm".into(),
            _ => "pipeline".into(),
        },
        language: match input.api.language.as_deref().map(str::trim) {
            Some("en") => "en".into(),
            _ => "ch".into(),
        },
        enable_formula: input.api.enable_formula.unwrap_or(true),
        enable_table: input.api.enable_table.unwrap_or(true),
    };
    let tier = match input.tier.trim() {
        "flash" | "basic" | "standard" | "advanced" => input.tier.trim().to_string(),
        _ => default_tier(),
    };
    let page_range = if valid_page_range(input.page_range.trim()) {
        input.page_range.trim().to_string()
    } else {
        default_page_range()
    };
    MineruFileV2 {
        version: 2,
        order: normalize_order(&input.order),
        local,
        ssh,
        api,
        tier,
        page_range,
    }
}

/// api 来源的“启用”由 token 非空决定（api 块没有 enabled 字段）。
fn provider_enabled(file: &MineruFileV2, name: &str) -> bool {
    match name {
        "local" => file.local.enabled,
        "ssh" => file.ssh.enabled,
        "api" => !file.api.token.trim().is_empty(),
        _ => false,
    }
}

/// order 中处于启用状态的来源，保持用户配置的顺序。
fn enabled_order(file: &MineruFileV2) -> Vec<String> {
    file.order
        .iter()
        .filter(|name| provider_enabled(file, name))
        .cloned()
        .collect()
}

fn is_configured(file: &MineruFileV2) -> bool {
    !enabled_order(file).is_empty()
}

fn to_public(file: &MineruFileV2) -> MineruPublic {
    MineruPublic {
        version: 2,
        order: file.order.clone(),
        local: LocalPublic {
            enabled: file.local.enabled,
            socket_path: file.local.socket_path.clone(),
        },
        ssh: SshPublic {
            enabled: file.ssh.enabled,
            host: file.ssh.host.clone(),
            port: file.ssh.port,
            user: file.ssh.user.clone(),
            identity_file: file.ssh.identity_file.clone(),
            socket_path: file.ssh.socket_path.clone(),
            inbox_dir: file.ssh.inbox_dir.clone(),
        },
        api: ApiPublic {
            has_token: !file.api.token.trim().is_empty(),
            model_version: file.api.model_version.clone(),
            language: file.api.language.clone(),
            enable_formula: file.api.enable_formula,
            enable_table: file.api.enable_table,
        },
        tier: file.tier.clone(),
        page_range: file.page_range.clone(),
        configured: is_configured(file),
    }
}

/// 保存前校验：ssh 启用时 host/user/私钥必须可用。
fn validate_config(file: &MineruFileV2, home: &Path) -> Result<(), String> {
    if file.ssh.enabled {
        if !valid_host(&file.ssh.host) {
            return Err("SSH 主机无效".into());
        }
        if !valid_user(&file.ssh.user) {
            return Err("SSH 用户无效".into());
        }
        if !file.ssh.identity_file.is_empty() {
            let path = expand_local_path(&file.ssh.identity_file, home);
            if !path.is_file() {
                return Err(format!("私钥不存在：{}", path.display()));
            }
        }
    }
    Ok(())
}

fn fallback(value: &str, default_value: &str) -> String {
    if value.is_empty() {
        default_value.to_string()
    } else {
        value.to_string()
    }
}

fn valid_host(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 200
        && !value.contains([' ', '\n', '\r', '\'', '"', '@', ':'])
}

fn valid_user(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

fn valid_page_range(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ',' || c == '-')
}

fn valid_doc_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn valid_paper_id(value: &str) -> bool {
    value.len() == 36 && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// doclib 数字解析 id 的字符串形式（防路径注入：只允许纯数字）。
fn valid_parse_ids(ids: &[String]) -> bool {
    ids.iter()
        .all(|id| !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_digit()))
}

fn expand_local_path(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        let mut expanded = home.to_path_buf();
        for component in rest.split('/') {
            expanded.push(component);
        }
        expanded
    } else {
        PathBuf::from(path)
    }
}

pub fn provider_label(name: &str) -> &'static str {
    match name {
        "local" => "本地 CLI",
        "ssh" => "SSH 远程",
        "api" => "官方 API",
        _ => "未知来源",
    }
}

// ---------- Provider 抽象 ----------

impl SshResolved {
    fn from_cfg(cfg: &SshCfg, home: &Path) -> Self {
        let identity = if cfg.identity_file.is_empty() {
            None
        } else {
            Some(
                expand_local_path(&cfg.identity_file, home)
                    .to_string_lossy()
                    .to_string(),
            )
        };
        Self {
            host: cfg.host.clone(),
            port: cfg.port,
            user: cfg.user.clone(),
            identity,
            socket_path: cfg.socket_path.clone(),
            inbox_dir: cfg.inbox_dir.clone(),
        }
    }

    fn ensure(&self) -> Result<(), String> {
        if !valid_host(&self.host) {
            return Err("SSH 主机无效或未填写".into());
        }
        if !valid_user(&self.user) {
            return Err("SSH 用户无效或未填写".into());
        }
        Ok(())
    }
}

pub enum Provider {
    Local { socket_path: PathBuf },
    Ssh(SshResolved),
    Api(ApiClient),
}

impl Provider {
    fn build_ssh(ssh: &SshCfg, home: &Path) -> Result<Provider, String> {
        Ok(Provider::Ssh(SshResolved::from_cfg(ssh, home)))
    }

    fn doclib_target(&self) -> Result<DoclibTransport, String> {
        match self {
            Provider::Local { socket_path } => {
                if !socket_path.exists() {
                    return Err(format!("找不到 MinerU socket：{}", socket_path.display()));
                }
                Ok(DoclibTransport::Local(
                    socket_path.to_string_lossy().to_string(),
                ))
            }
            Provider::Ssh(ssh) => {
                ssh.ensure()?;
                Ok(DoclibTransport::Ssh(ssh.clone()))
            }
            Provider::Api(_) => Err("官方 API 来源不走 doclib 接口".into()),
        }
    }

    /// 健康检查（探测超时 10s；ssh 探测时 ConnectTimeout 降为 5s）。
    pub async fn health(&self) -> Result<String, String> {
        match self {
            Provider::Api(api) => with_timeout(PROBE_TIMEOUT, api.health()).await,
            Provider::Local { .. } | Provider::Ssh(_) => {
                let via_ssh = matches!(self, Provider::Ssh(_));
                let target = self.doclib_target()?;
                with_timeout(PROBE_TIMEOUT, async move {
                    let body = target
                        .request(
                            "GET",
                            "/api/v1/server/status",
                            None,
                            CURL_PROBE,
                            SSH_CONNECT_PROBE,
                        )
                        .await?;
                    doclib_status_message(&body, via_ssh)
                })
                .await
            }
        }
    }

    /// 提交解析：local/ssh 走 doclib /api/v1/parses；api 走 mineru.net。
    pub async fn submit(
        &self,
        paper_id: &str,
        pdf: &Path,
        force: bool,
        tier: &str,
        page_range: &str,
    ) -> Result<SubmitResult, String> {
        if !valid_paper_id(paper_id) {
            return Err("论文编号无效".into());
        }
        match self {
            Provider::Local { .. } => {
                let target = self.doclib_target()?;
                let local_path = pdf.to_string_lossy().to_string();
                with_timeout(SUBMIT_TIMEOUT, async move {
                    let body = target
                        .request(
                            "POST",
                            "/api/v1/parses",
                            Some(&doclib_payload(&local_path, tier, page_range, force)),
                            CURL_SUBMIT,
                            SSH_CONNECT_NORMAL,
                        )
                        .await?;
                    parse_submit_body(&body, "local", &local_path, tier)
                })
                .await
            }
            Provider::Ssh(ssh) => {
                ssh.ensure()?;
                let target = self.doclib_target()?;
                with_timeout(SUBMIT_TIMEOUT, async move {
                    let remote_file = target.upload_pdf(pdf, paper_id, SSH_CONNECT_NORMAL).await?;
                    let body = target
                        .request(
                            "POST",
                            "/api/v1/parses",
                            Some(&doclib_payload(&remote_file, tier, page_range, force)),
                            CURL_SUBMIT,
                            SSH_CONNECT_NORMAL,
                        )
                        .await?;
                    parse_submit_body(&body, "ssh", &remote_file, tier)
                })
                .await
            }
            Provider::Api(api) => {
                let batch_id = api.submit(paper_id, pdf, page_range).await?;
                Ok(SubmitResult {
                    provider: "api".into(),
                    remote_path: String::new(),
                    short_id: batch_id,
                    parse_ids: Vec::new(),
                    status: "pending".into(),
                    tier: api.model_version().to_string(),
                    cred_fingerprint: String::new(),
                })
            }
        }
    }

    /// 轮询（同源必填，不回退）：doclib 按 parse_ids；api 按 batch_id。
    pub async fn statuses(
        &self,
        doc_ref: &str,
        parse_ids: &[String],
    ) -> Result<Vec<ParsePoll>, String> {
        match self {
            Provider::Api(api) => {
                with_timeout(POLL_TIMEOUT, api.statuses(doc_ref, parse_ids)).await
            }
            Provider::Local { .. } | Provider::Ssh(_) => {
                if parse_ids.is_empty() {
                    return Ok(Vec::new());
                }
                if parse_ids.len() > 32 {
                    return Err("一次查询的解析任务过多".into());
                }
                if !valid_parse_ids(parse_ids) {
                    return Err("解析任务编号无效".into());
                }
                let target = self.doclib_target()?;
                let paths: Vec<String> = parse_ids
                    .iter()
                    .map(|id| format!("/api/v1/parses/{id}"))
                    .collect();
                with_timeout(POLL_TIMEOUT, async move {
                    let bodies = target
                        .get_many(&paths, CURL_POLL, SSH_CONNECT_NORMAL)
                        .await?;
                    let mut polls = Vec::with_capacity(bodies.len());
                    for (index, body) in bodies.iter().enumerate() {
                        let parsed: Value = serde_json::from_str(body)
                            .map_err(|e| format!("MinerU 状态返回无法解析：{e}"))?;
                        polls.push(ParsePoll {
                            id: parse_ids[index].clone(),
                            status: parsed["status"].as_str().unwrap_or("pending").to_string(),
                            error: parsed["error_msg"].as_str().map(str::to_string),
                            progress: None,
                        });
                    }
                    Ok(polls)
                })
                .await
            }
        }
    }

    /// 取 markdown（同源必填，不回退）：doclib 分页拉取；api 下载 full.zip 解出 full.md。
    pub async fn markdown(
        &self,
        doc_ref: &str,
        tier: &str,
        page_range: &str,
    ) -> Result<String, String> {
        if !valid_doc_ref(doc_ref) {
            return Err("文档编号无效".into());
        }
        match self {
            Provider::Api(api) => with_timeout(FETCH_TIMEOUT, api.markdown(doc_ref)).await,
            Provider::Local { .. } | Provider::Ssh(_) => {
                let target = self.doclib_target()?;
                let tier = match tier {
                    "flash" | "basic" | "standard" | "advanced" => tier.to_string(),
                    _ => "standard".to_string(),
                };
                let page_range = if valid_page_range(page_range) {
                    page_range.to_string()
                } else {
                    "all".to_string()
                };
                with_timeout(FETCH_TIMEOUT, async move {
                    doclib_markdown(&target, doc_ref, &tier, &page_range).await
                })
                .await
            }
        }
    }
}

fn build_provider(file: &MineruFileV2, name: &str, home: &Path) -> Result<Provider, String> {
    match name {
        "local" => Ok(Provider::Local {
            socket_path: expand_local_path(&file.local.socket_path, home),
        }),
        "ssh" => Provider::build_ssh(&file.ssh, home),
        "api" => Ok(Provider::Api(ApiClient::new(&file.api))),
        other => Err(format!("未知 MinerU 来源：{other}")),
    }
}

// ---------- fallback：provider 选择（纯函数，可注入探针） ----------

/// 按顺序取第一个探测通过的来源；全失败返回聚合中文错误（每源一行原因）。
pub fn pick_provider(order: &[String], probes: &[HealthProbe]) -> Result<String, String> {
    for name in order {
        if let Some(probe) = probes.iter().find(|p| &p.provider == name) {
            if probe.ok {
                return Ok(name.clone());
            }
        }
    }
    let failures: Vec<(String, String)> = order
        .iter()
        .filter_map(|name| {
            probes
                .iter()
                .find(|p| &p.provider == name)
                .map(|p| (name.clone(), p.message.clone()))
        })
        .collect();
    if failures.is_empty() {
        Err("没有启用任何 MinerU 来源".into())
    } else {
        Err(aggregate_failures(&failures))
    }
}

fn aggregate_failures(failures: &[(String, String)]) -> String {
    failures
        .iter()
        .map(|(name, message)| format!("{}：{}", provider_label(name), message))
        .collect::<Vec<_>>()
        .join("；")
}

/// provider=None 时按 order 逐源提交。健康探测只用来给候选源排序，不再拦截提交：
/// 远端解析繁忙时 /status 可能 5 秒以上才响应（实测 doclib 4.0.5 空闲即 ~5.5s），
/// 探测超时就把论文判死会把「服务忙」误报成「源不可用」，曾造成整批导入失败。
async fn submit_with_fallback(
    file: &MineruFileV2,
    home: &Path,
    paper_id: &str,
    pdf: &Path,
    force: bool,
) -> Result<SubmitResult, String> {
    let order = enabled_order(file);
    if order.is_empty() {
        return Err(
            "没有启用任何 MinerU 来源，请先在系统页配置本地 CLI、SSH 远程或官方 API".into(),
        );
    }
    let probes = probe_providers(file, home, &order).await;
    let candidates = order_candidates(&order, &probes);
    let mut failures: Vec<(String, String)> = Vec::new();
    for name in &candidates {
        let provider = build_provider(file, name, home)?;
        match provider
            .submit(paper_id, pdf, force, &file.tier, &file.page_range)
            .await
        {
            Ok(result) => return Ok(result),
            Err(err) => failures.push((name.clone(), err)),
        }
    }
    Err(aggregate_failures(&failures))
}

/// 候选顺序：健康源按 order 优先，探测失败的启用源垫底（仍尝试提交，让真实提交结果说话）。
fn order_candidates(order: &[String], probes: &[HealthProbe]) -> Vec<String> {
    let mut candidates: Vec<String> = probes
        .iter()
        .filter(|p| p.ok)
        .filter(|p| order.contains(&p.provider))
        .map(|p| p.provider.clone())
        .collect();
    for name in order {
        if !candidates.contains(name) {
            candidates.push(name.clone());
        }
    }
    candidates
}

/// 批量导入时的探测缓存：避免每篇论文各付一次 5 秒级的 /status 往返。
struct ProbeCacheEntry {
    key: String,
    at: Instant,
    probes: Vec<HealthProbe>,
}

static PROBE_CACHE: OnceLock<Mutex<Option<ProbeCacheEntry>>> = OnceLock::new();
const PROBE_CACHE_TTL: Duration = Duration::from_secs(60);

fn probe_cache_key(file: &MineruFileV2, order: &[String]) -> String {
    let mut parts: Vec<String> = vec![order.join(",")];
    for name in order {
        let part = match name.as_str() {
            "local" => format!("{}:{}", file.local.enabled, file.local.socket_path),
            "ssh" => format!(
                "{}:{}:{}:{}:{}:{}",
                file.ssh.enabled,
                file.ssh.host,
                file.ssh.port,
                file.ssh.user,
                file.ssh.identity_file,
                file.ssh.socket_path
            ),
            _ => format!("token:{}", !file.api.token.is_empty()),
        };
        parts.push(part);
    }
    parts.join("|")
}

async fn probe_providers(file: &MineruFileV2, home: &Path, order: &[String]) -> Vec<HealthProbe> {
    // 只有一个启用源时无需排序，直接提交：省一次往返，也避免忙时探测误判。
    if order.len() == 1 {
        return Vec::new();
    }
    let key = probe_cache_key(file, order);
    let cache = PROBE_CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some(entry) = guard.as_ref() {
            if entry.key == key && entry.at.elapsed() < PROBE_CACHE_TTL {
                return entry.probes.clone();
            }
        }
    }
    let mut probes = Vec::with_capacity(order.len());
    for name in order {
        let (ok, message) = match build_provider(file, name, home) {
            Err(message) => (false, message),
            Ok(provider) => match provider.health().await {
                Ok(message) => (true, message),
                Err(message) => (false, message),
            },
        };
        probes.push(HealthProbe {
            provider: name.clone(),
            ok,
            message,
        });
    }
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(ProbeCacheEntry {
            key,
            at: Instant::now(),
            probes: probes.clone(),
        });
    }
    probes
}

fn doclib_payload(path: &str, tier: &str, page_range: &str, force: bool) -> String {
    json!({
        "path": path,
        "tier": tier,
        "page_range": page_range,
        "force": force,
        "remote": false
    })
    .to_string()
}

fn parse_ids(value: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    for key in ["created_parse_ids", "wait_parse_ids", "reused_parse_ids"] {
        if let Some(list) = value.get(key).and_then(Value::as_array) {
            for item in list {
                if let Some(id) = item.as_i64() {
                    ids.push(id.to_string());
                }
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn parse_submit_body(
    body: &str,
    provider: &str,
    remote_path: &str,
    tier_fallback: &str,
) -> Result<SubmitResult, String> {
    let json: Value =
        serde_json::from_str(body).map_err(|e| format!("MinerU 返回无法解析：{e}"))?;
    let short_id = json["short_id"].as_str().unwrap_or("").to_string();
    if !valid_doc_ref(&short_id) {
        return Err("MinerU 没有返回文档编号".into());
    }
    Ok(SubmitResult {
        provider: provider.to_string(),
        remote_path: remote_path.to_string(),
        short_id,
        parse_ids: parse_ids(&json),
        status: json["status"].as_str().unwrap_or("pending").to_string(),
        tier: json["tier"].as_str().unwrap_or(tier_fallback).to_string(),
        cred_fingerprint: String::new(),
    })
}

fn doclib_status_message(body: &str, via_ssh: bool) -> Result<String, String> {
    let json: Value =
        serde_json::from_str(body).map_err(|e| format!("MinerU 状态返回无法解析：{e}"))?;
    if json["running"].as_bool() != Some(true) {
        return Err("MinerU 文档库没有在运行".into());
    }
    let version = json["version"].as_str().unwrap_or("4");
    if via_ssh {
        Ok(format!("已连接 MinerU {version}（SSH 远程）"))
    } else {
        Ok(format!("已连接 MinerU {version}"))
    }
}

async fn doclib_markdown(
    target: &DoclibTransport,
    doc_ref: &str,
    tier: &str,
    page_range: &str,
) -> Result<String, String> {
    let mut after: Option<String> = None;
    let mut chunks = Vec::new();
    let mut total = 0usize;
    for _ in 0..16 {
        let mut path = format!(
            "/api/v1/docs/{doc_ref}/content?tier={tier}&format=markdown&page_range={}&limit=60000",
            encode_query(page_range)
        );
        if let Some(cursor) = &after {
            path.push_str("&after=");
            path.push_str(&encode_query(cursor));
        }
        let body = target
            .request("GET", &path, None, CURL_FETCH, SSH_CONNECT_NORMAL)
            .await?;
        let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let content = json["content"].as_str().unwrap_or("").to_string();
        total += content.len();
        chunks.push(content);
        let truncated = json["truncated"].as_bool().unwrap_or(false);
        let next = json["next_request"]["after"].as_str().map(str::to_string);
        if !truncated || next.is_none() || total > 400_000 {
            break;
        }
        if next.as_deref() == after.as_deref() {
            break;
        }
        after = next;
    }
    let markdown = chunks.join("\n").trim().to_string();
    if markdown.is_empty() {
        return Err("MinerU 解析结果为空".into());
    }
    Ok(markdown)
}

fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn canonical_pdf(path: &str) -> Result<PathBuf, String> {
    let file = PathBuf::from(path);
    if !file.is_file() {
        return Err("PDF 不存在".into());
    }
    let canon = dunce::canonicalize(&file).map_err(|e| e.to_string())?;
    let is_pdf = canon
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("pdf"))
        .unwrap_or(false);
    if !is_pdf {
        return Err("请选择 PDF 文件".into());
    }
    Ok(canon)
}

// ---------- 凭据指纹与进程内快照 ----------

/// Submit-time credentials. May hold a token. Never serialize this to the frontend.
#[derive(Clone, Debug)]
pub struct CredSnapshot {
    pub provider: String,
    pub token: String,
    pub host: String,
    pub port: String,
    pub user: String,
    pub socket: String,
    pub identity: String,
    pub inbox: String,
    pub model: String,
    pub language: String,
    pub enable_formula: bool,
    pub enable_table: bool,
}

/// In-process book of the credentials used at submit. Empty after restart.
pub struct MineruCredBook {
    inner: Mutex<HashMap<String, CredSnapshot>>,
}

impl Default for MineruCredBook {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl MineruCredBook {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, CredSnapshot>> {
        self.inner.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub fn insert(&self, paper_id: &str, snap: CredSnapshot) {
        self.lock().insert(paper_id.to_string(), snap);
    }

    pub fn get(&self, paper_id: &str) -> Option<CredSnapshot> {
        self.lock().get(paper_id).cloned()
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn cred_lines(snap: &CredSnapshot) -> [String; 10] {
    let token_line = if snap.token.trim().is_empty() {
        String::new()
    } else {
        sha256_hex(snap.token.trim().as_bytes())
    };
    [
        snap.provider.clone(),
        token_line,
        snap.host.clone(),
        snap.port.clone(),
        snap.user.clone(),
        snap.socket.clone(),
        snap.identity.clone(),
        snap.inbox.clone(),
        snap.model.clone(),
        snap.language.clone(),
    ]
}

/// `pf-cred-v1:` + SHA-256 of the 10 lines joined by `\n`. Empty token is not hashed.
pub fn cred_fingerprint(snap: &CredSnapshot) -> String {
    let payload = cred_lines(snap).join("\n");
    format!("pf-cred-v1:{}", sha256_hex(payload.as_bytes()))
}

pub fn snapshot_from_file(file: &MineruFileV2, provider: &str) -> Result<CredSnapshot, String> {
    match provider {
        "local" => Ok(CredSnapshot {
            provider: "local".into(),
            token: String::new(),
            host: String::new(),
            port: String::new(),
            user: String::new(),
            socket: file.local.socket_path.clone(),
            identity: String::new(),
            inbox: String::new(),
            model: String::new(),
            language: String::new(),
            enable_formula: false,
            enable_table: false,
        }),
        "ssh" => Ok(CredSnapshot {
            provider: "ssh".into(),
            token: String::new(),
            host: file.ssh.host.clone(),
            port: file.ssh.port.to_string(),
            user: file.ssh.user.clone(),
            socket: file.ssh.socket_path.clone(),
            identity: file.ssh.identity_file.clone(),
            inbox: file.ssh.inbox_dir.clone(),
            model: String::new(),
            language: String::new(),
            enable_formula: false,
            enable_table: false,
        }),
        "api" => Ok(CredSnapshot {
            provider: "api".into(),
            token: file.api.token.clone(),
            host: crate::mineru_api::API_BASE
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .to_string(),
            port: String::new(),
            user: String::new(),
            socket: String::new(),
            identity: String::new(),
            inbox: String::new(),
            model: file.api.model_version.clone(),
            language: file.api.language.clone(),
            enable_formula: file.api.enable_formula,
            enable_table: file.api.enable_table,
        }),
        other => Err(format!("未知 MinerU 来源：{other}")),
    }
}

/// Book snapshot wins over disk. Mismatch returns before any transport call.
pub fn resolve_poll_creds(
    book: &MineruCredBook,
    paper_id: &str,
    provider: &str,
    expected_fingerprint: &str,
    disk: &CredSnapshot,
) -> Result<CredSnapshot, String> {
    let candidate = book.get(paper_id).unwrap_or_else(|| disk.clone());
    if candidate.provider != provider || cred_fingerprint(&candidate) != expected_fingerprint {
        return Err("CRED_FINGERPRINT_MISMATCH".into());
    }
    Ok(candidate)
}

fn provider_from_snapshot(snap: &CredSnapshot, home: &Path) -> Result<Provider, String> {
    match snap.provider.as_str() {
        "local" => Ok(Provider::Local {
            socket_path: expand_local_path(&snap.socket, home),
        }),
        "ssh" => {
            let port = snap.port.parse::<u16>().unwrap_or_else(|_| default_ssh_port());
            let cfg = SshCfg {
                enabled: true,
                host: snap.host.clone(),
                port,
                user: snap.user.clone(),
                identity_file: snap.identity.clone(),
                socket_path: snap.socket.clone(),
                inbox_dir: snap.inbox.clone(),
            };
            Provider::build_ssh(&cfg, home)
        }
        "api" => Ok(Provider::Api(ApiClient::new(&ApiCfg {
            token: snap.token.clone(),
            model_version: snap.model.clone(),
            language: snap.language.clone(),
            enable_formula: snap.enable_formula,
            enable_table: snap.enable_table,
        }))),
        other => Err(format!("未知 MinerU 来源：{other}")),
    }
}

fn stamp_submit(book: &MineruCredBook, file: &MineruFileV2, paper_id: &str, result: &mut SubmitResult) -> Result<(), String> {
    let snap = snapshot_from_file(file, &result.provider)?;
    result.cred_fingerprint = cred_fingerprint(&snap);
    book.insert(paper_id, snap);
    Ok(())
}

/// Records the credentials a status/markdown call would send. Mismatch never pushes.
fn record_poll(
    book: &MineruCredBook,
    paper_id: &str,
    provider: &str,
    expected_fingerprint: &str,
    disk: &CredSnapshot,
    log: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let creds = resolve_poll_creds(book, paper_id, provider, expected_fingerprint, disk)?;
    log.push((creds.token, creds.host));
    Ok(())
}

// ---------- Tauri 命令（全部 async；settings 一律从磁盘读，token 不出网） ----------

#[tauri::command]
pub async fn mineru_settings(app: AppHandle) -> Result<MineruPublic, String> {
    Ok(to_public(&read_file(&app)?))
}

#[tauri::command]
pub async fn save_mineru_settings(
    app: AppHandle,
    settings: MineruInputV2,
) -> Result<MineruPublic, String> {
    let existing = read_file(&app)?;
    let home = platform::home_dir(&app)?;
    let file = normalize_input(&settings, &existing);
    validate_config(&file, &home)?;
    let path = settings_file(&app)?;
    write_file_at(&path, &file)?;
    Ok(to_public(&file))
}

/// 单源测试连接（读已保存配置），返回中文结果。
#[tauri::command]
pub async fn mineru_test(app: AppHandle, provider: String) -> Result<String, String> {
    if !matches!(provider.as_str(), "local" | "ssh" | "api") {
        return Err(format!("未知 MinerU 来源：{provider}"));
    }
    let file = read_file(&app)?;
    let home = platform::home_dir(&app)?;
    let target = build_provider(&file, &provider, &home)?;
    target.health().await
}

/// 并行探测全部启用源，返回 {provider, ok, latencyMs, message}。
#[tauri::command]
pub async fn mineru_probe(app: AppHandle) -> Result<Vec<ProviderHealth>, String> {
    let file = read_file(&app)?;
    let home = platform::home_dir(&app)?;
    let order = enabled_order(&file);
    let mut spawned = Vec::with_capacity(order.len());
    for name in &order {
        let provider = build_provider(&file, name, &home)?;
        let label = name.clone();
        spawned.push((
            label,
            tokio::spawn(async move {
                let started = Instant::now();
                let result = provider.health().await;
                (started.elapsed().as_millis() as u64, result)
            }),
        ));
    }
    let mut healths = Vec::with_capacity(spawned.len());
    for (name, handle) in spawned {
        let (latency_ms, result) = handle.await.map_err(|e| e.to_string())?;
        healths.push(match result {
            Ok(message) => ProviderHealth {
                provider: name,
                ok: true,
                latency_ms,
                message,
            },
            Err(message) => ProviderHealth {
                provider: name,
                ok: false,
                latency_ms,
                message,
            },
        });
    }
    Ok(healths)
}

#[tauri::command]
pub async fn mineru_current_fingerprint(app: AppHandle, provider: String) -> Result<String, String> {
    let file = read_file(&app)?;
    let snap = snapshot_from_file(&file, &provider)?;
    Ok(cred_fingerprint(&snap))
}

#[tauri::command]
pub async fn mineru_submit(
    app: AppHandle,
    book: State<'_, MineruCredBook>,
    paper_id: String,
    local_path: String,
    force: bool,
    provider: Option<String>,
) -> Result<SubmitResult, String> {
    let file = read_file(&app)?;
    let home = platform::home_dir(&app)?;
    let pdf = canonical_pdf(&crate::library::resolve(&crate::app_config_dir(&app)?, &local_path).to_string_lossy())?;
    if !valid_paper_id(&paper_id) {
        return Err("论文编号无效".into());
    }
    let mut result = match provider {
        Some(name) => {
            if !matches!(name.as_str(), "local" | "ssh" | "api") {
                return Err(format!("未知 MinerU 来源：{name}"));
            }
            let target = build_provider(&file, &name, &home)?;
            target
                .submit(&paper_id, &pdf, force, &file.tier, &file.page_range)
                .await?
        }
        None => submit_with_fallback(&file, &home, &paper_id, &pdf, force).await?,
    };
    stamp_submit(&book, &file, &paper_id, &mut result)?;
    Ok(result)
}

/// provider 必填、不自动回退。凭据来自提交快照，指纹不对则在传输前失败。
#[tauri::command]
pub async fn mineru_parse_statuses(
    app: AppHandle,
    book: State<'_, MineruCredBook>,
    paper_id: String,
    provider: String,
    doc_ref: String,
    parse_ids: Vec<String>,
    expected_fingerprint: String,
) -> Result<Vec<ParsePoll>, String> {
    if !valid_doc_ref(&doc_ref) {
        return Err("文档编号无效".into());
    }
    let file = read_file(&app)?;
    let disk = snapshot_from_file(&file, &provider)?;
    let creds = resolve_poll_creds(&book, &paper_id, &provider, &expected_fingerprint, &disk)?;
    let home = platform::home_dir(&app)?;
    let target = provider_from_snapshot(&creds, &home)?;
    target.statuses(&doc_ref, &parse_ids).await
}

/// provider 必填、不自动回退。凭据来自提交快照，指纹不对则在传输前失败。
#[tauri::command]
pub async fn mineru_markdown(
    app: AppHandle,
    book: State<'_, MineruCredBook>,
    paper_id: String,
    provider: String,
    doc_ref: String,
    tier: String,
    page_range: String,
    expected_fingerprint: String,
) -> Result<String, String> {
    if !valid_doc_ref(&doc_ref) {
        return Err("文档编号无效".into());
    }
    let file = read_file(&app)?;
    let disk = snapshot_from_file(&file, &provider)?;
    let creds = resolve_poll_creds(&book, &paper_id, &provider, &expected_fingerprint, &disk)?;
    let home = platform::home_dir(&app)?;
    let target = provider_from_snapshot(&creds, &home)?;
    target.markdown(&doc_ref, &tier, &page_range).await
}

#[tauri::command]
pub async fn list_pdfs(directory: String) -> Result<Vec<String>, String> {
    scan_pdfs_in_dir(&directory)
}

/// 只列出目录本身（一层）的 PDF，不进入子目录；隐藏文件跳过。
fn scan_pdfs_in_dir(directory: &str) -> Result<Vec<String>, String> {
    let root = PathBuf::from(directory);
    if !root.is_dir() {
        return Err("目录不存在".into());
    }
    let entries = fs::read_dir(&root).map_err(|e| format!("目录无法读取：{e}"))?;
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        if !name.to_ascii_lowercase().ends_with(".pdf") {
            continue;
        }
        if let Ok(canon) = canonical_pdf(&path.to_string_lossy()) {
            found.push(canon.to_string_lossy().to_string());
        }
    }
    found.sort();
    if found.is_empty() {
        return Err("所选目录里没有 PDF（不读取子目录）".into());
    }
    Ok(found)
}

#[tauri::command]
pub async fn normalize_pdf(path: String) -> Result<String, String> {
    Ok(canonical_pdf(&path)?.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_pdf(app: AppHandle, path: String) -> Result<(), String> {
    // 文库内的 PDF 存相对名，拼到当前的应用数据目录上再打开。
    let canon = canonical_pdf(&crate::library::resolve(&crate::app_config_dir(&app)?, &path).to_string_lossy())?;
    platform::open_pdf(&app, &canon)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v1_file(mode: &str) -> Value {
        json!({
            "mode": mode,
            "socketPath": "~/custom.sock",
            "sshHost": "imac.local",
            "sshPort": 2222,
            "sshUser": "yang",
            "identityFile": "~/.ssh/id_ed25519",
            "remoteInbox": "~/mineru-inbox",
            "tier": "flash",
            "pageRange": "1-5"
        })
    }

    #[test]
    fn injected_home_expands_without_environment_access() {
        let home = PathBuf::from("/tmp/paper-field-home");
        assert_eq!(expand_local_path("~", &home), home);
        assert_eq!(
            expand_local_path("~/.mineru/doclib.sock", &home),
            home.join(".mineru").join("doclib.sock")
        );
        assert_eq!(
            expand_local_path("/opt/absolute/doclib.sock", &home),
            PathBuf::from("/opt/absolute/doclib.sock")
        );
    }

    #[test]
    fn canonical_pdf_returns_shell_friendly_absolute_path() {
        let dir = crate::test_util::unique_temp_dir("pf-canonical-pdf");
        let file = dir.join("sample.pdf");
        fs::write(&file, b"pdf").unwrap();
        let canonical = canonical_pdf(&file.to_string_lossy()).unwrap();
        assert!(canonical.is_absolute());
        #[cfg(windows)]
        assert!(!canonical.to_string_lossy().starts_with(r"\\?\"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migrate_v1_off_disables_all_sources() {
        let file = migrate_v1(&v1_file("off")).unwrap();
        assert!(!file.local.enabled);
        assert!(!file.ssh.enabled);
        assert!(file.api.token.is_empty());
        assert_eq!(file.order, vec!["local", "ssh", "api"]);
        // 字段仍然保留，方便用户切换来源
        assert_eq!(file.ssh.host, "imac.local");
        assert_eq!(file.ssh.port, 2222);
        assert_eq!(file.ssh.user, "yang");
    }

    #[test]
    fn migrate_v1_local_enables_local() {
        let file = migrate_v1(&v1_file("local")).unwrap();
        assert!(file.local.enabled);
        assert!(!file.ssh.enabled);
        assert_eq!(file.order, vec!["local", "ssh", "api"]);
        assert_eq!(file.local.socket_path, "~/custom.sock");
    }

    #[test]
    fn migrate_v1_ssh_enables_ssh_and_shares_socket() {
        let file = migrate_v1(&v1_file("ssh")).unwrap();
        assert!(file.ssh.enabled);
        assert!(!file.local.enabled);
        assert_eq!(file.order, vec!["ssh", "local", "api"]);
        // 关键兼容点：v1 的 socket_path 被两种模式共用，迁移后同时写入两块
        assert_eq!(file.ssh.socket_path, "~/custom.sock");
        assert_eq!(file.local.socket_path, "~/custom.sock");
        assert_eq!(file.ssh.host, "imac.local");
        assert_eq!(file.ssh.port, 2222);
        assert_eq!(file.ssh.user, "yang");
        assert_eq!(file.ssh.identity_file, "~/.ssh/id_ed25519");
        assert_eq!(file.ssh.inbox_dir, "~/mineru-inbox");
        assert_eq!(file.tier, "flash");
        assert_eq!(file.page_range, "1-5");
    }

    #[test]
    fn migrate_v1_without_mode_reports_error() {
        let bad = json!({"socketPath": "~/.mineru/doclib.sock"});
        assert!(migrate_v1(&bad).is_err());
    }

    #[test]
    fn parse_settings_dispatches_by_version() {
        let v2_raw = serde_json::to_string(&default_file_v2()).unwrap();
        let (file, migrated) = parse_settings(&v2_raw).unwrap();
        assert!(!migrated);
        assert_eq!(file.version, 2);

        let (file, migrated) = parse_settings(&v1_file("ssh").to_string()).unwrap();
        assert!(migrated);
        assert!(file.ssh.enabled);
    }

    #[test]
    fn normalize_order_dedupes_and_fills_missing() {
        let order = normalize_order(&[
            "api".into(),
            "zzz".into(),
            "api".into(),
            "local".into(),
            "".into(),
        ]);
        assert_eq!(order, vec!["api", "local", "ssh"]);
    }

    #[test]
    fn normalize_input_token_three_states() {
        let existing = default_file_v2();
        let mut input: MineruInputV2 = Default::default();
        input.order = vec!["api".into(), "local".into(), "ssh".into()];
        // None → 保留已存 token
        let file = normalize_input(&input, &existing);
        assert_eq!(file.api.token, "");
        let mut existing_with_token = existing.clone();
        existing_with_token.api.token = "secret-token".into();
        let file = normalize_input(&input, &existing_with_token);
        assert_eq!(file.api.token, "secret-token");
        // Some("") → 清除
        input.api.token = Some(String::new());
        let file = normalize_input(&input, &existing_with_token);
        assert_eq!(file.api.token, "");
        // Some(x) → 写入（trim）
        input.api.token = Some("  new-token  ".into());
        let file = normalize_input(&input, &existing_with_token);
        assert_eq!(file.api.token, "new-token");
        assert!(provider_enabled(&file, "api"));
    }

    #[test]
    fn normalize_input_defaults() {
        let input: MineruInputV2 = Default::default();
        let file = normalize_input(&input, &default_file_v2());
        assert_eq!(file.ssh.port, 22);
        assert_eq!(file.ssh.socket_path, "~/.mineru/doclib.sock");
        assert_eq!(file.ssh.inbox_dir, "~/.mineru/paper-field-inbox");
        assert_eq!(file.api.model_version, "pipeline");
        assert_eq!(file.api.language, "ch");
        assert!(file.api.enable_formula && file.api.enable_table);
        assert_eq!(file.tier, "standard");
        assert_eq!(file.page_range, "all");
        assert!(!is_configured(&file));
    }

    #[test]
    fn configured_requires_enabled_source_in_order() {
        let mut file = default_file_v2();
        assert!(!is_configured(&file));
        file.ssh.enabled = true;
        assert!(is_configured(&file));
        assert_eq!(enabled_order(&file), vec!["ssh"]);
        // 只有 token 也能作为来源
        file.ssh.enabled = false;
        assert!(!is_configured(&file));
        file.api.token = "tok".into();
        assert!(is_configured(&file));
        assert_eq!(enabled_order(&file), vec!["api"]);
    }

    #[test]
    fn pick_provider_takes_first_healthy_in_order() {
        let order: Vec<String> = vec!["local".into(), "ssh".into(), "api".into()];
        let probes = vec![
            HealthProbe {
                provider: "local".into(),
                ok: false,
                message: "找不到 socket".into(),
            },
            HealthProbe {
                provider: "ssh".into(),
                ok: true,
                message: "已连接".into(),
            },
            HealthProbe {
                provider: "api".into(),
                ok: true,
                message: "已连接".into(),
            },
        ];
        assert_eq!(pick_provider(&order, &probes).unwrap(), "ssh");

        let reordered: Vec<String> = vec!["api".into(), "ssh".into(), "local".into()];
        assert_eq!(pick_provider(&reordered, &probes).unwrap(), "api");
    }

    #[test]
    fn order_candidates_puts_healthy_first_and_keeps_unhealthy_tail() {
        let order: Vec<String> = vec!["local".into(), "ssh".into(), "api".into()];
        // ssh 探测失败（如远端忙导致 /status 超时）时仍要排在候选里，靠真实提交定成败。
        let probes = vec![
            HealthProbe {
                provider: "local".into(),
                ok: true,
                message: "已连接".into(),
            },
            HealthProbe {
                provider: "ssh".into(),
                ok: false,
                message: "curl: (28) timed out".into(),
            },
            HealthProbe {
                provider: "api".into(),
                ok: true,
                message: "已连接".into(),
            },
        ];
        let candidates = order_candidates(&order, &probes);
        assert_eq!(
            candidates,
            vec!["local".to_string(), "api".to_string(), "ssh".to_string()]
        );
    }

    #[test]
    fn order_candidates_without_probes_keeps_enabled_order() {
        // 单一启用源跳过探测（probes 为空）时，候选就是原顺序。
        let order: Vec<String> = vec!["ssh".into()];
        assert_eq!(order_candidates(&order, &[]), vec!["ssh".to_string()]);
        let multi: Vec<String> = vec!["ssh".into(), "api".into()];
        assert_eq!(
            order_candidates(&multi, &[]),
            vec!["ssh".to_string(), "api".to_string()]
        );
    }

    fn snap_api(token: &str, host: &str) -> CredSnapshot {
        CredSnapshot {
            provider: "api".into(),
            token: token.into(),
            host: host.into(),
            port: String::new(),
            user: String::new(),
            socket: String::new(),
            identity: String::new(),
            inbox: String::new(),
            model: "pipeline".into(),
            language: "ch".into(),
            enable_formula: true,
            enable_table: true,
        }
    }

    #[test]
    fn cred_fingerprint_hashes_ten_lines_and_skips_empty_token() {
        let plain = "token-plain-sk-old";
        let api = snapshot_from_file(
            &MineruFileV2 {
                api: ApiCfg {
                    token: plain.into(),
                    model_version: "vlm".into(),
                    language: "en".into(),
                    enable_formula: true,
                    enable_table: false,
                },
                ..default_file_v2()
            },
            "api",
        )
        .unwrap();
        let lines = cred_lines(&api);
        assert_eq!(lines[0], "api");
        assert_ne!(lines[1], sha256_hex(b""));
        assert!(!lines[1].is_empty());
        assert_eq!(lines[2], "mineru.net");
        assert_eq!(lines[3], "");
        assert_eq!(lines[8], "vlm");
        assert_eq!(lines[9], "en");
        let printed = cred_fingerprint(&api);
        assert!(printed.starts_with("pf-cred-v1:"));
        assert!(!printed.contains(plain));
        assert!(!printed.contains("token-plain-"));

        let toggled = CredSnapshot {
            enable_formula: !api.enable_formula,
            ..api.clone()
        };
        assert_eq!(cred_fingerprint(&toggled), printed);

        let local = snapshot_from_file(&default_file_v2(), "local").unwrap();
        let local_lines = cred_lines(&local);
        assert_eq!(local_lines[1], "");
        assert_eq!(local_lines[5], default_file_v2().local.socket_path);
        assert!(local_lines[2].is_empty() && local_lines[8].is_empty());

        let mut ssh_file = default_file_v2();
        ssh_file.ssh.host = "imac.local".into();
        ssh_file.ssh.port = 2222;
        ssh_file.ssh.user = "yang".into();
        ssh_file.ssh.identity_file = "~/.ssh/id_ed25519".into();
        ssh_file.ssh.inbox_dir = "~/mineru-inbox".into();
        ssh_file.ssh.socket_path = "~/.mineru/doclib.sock".into();
        let ssh = snapshot_from_file(&ssh_file, "ssh").unwrap();
        let ssh_lines = cred_lines(&ssh);
        assert_eq!(ssh_lines[2], "imac.local");
        assert_eq!(ssh_lines[3], "2222");
        assert_eq!(ssh_lines[6], "~/.ssh/id_ed25519");
        assert_eq!(ssh_lines[7], "~/mineru-inbox");
        assert!(ssh_lines[1].is_empty());
    }

    #[test]
    fn live_snapshot_keeps_submit_token_and_host_after_settings_change() {
        let old = snap_api("sk-old", "a.example");
        let book = MineruCredBook::default();
        book.insert("p1", old.clone());
        let disk = snap_api("token-plain-sk-new", "b.example");
        let mut log = Vec::new();
        record_poll(&book, "p1", "api", &cred_fingerprint(&old), &disk, &mut log).unwrap();
        assert_eq!(log, vec![("sk-old".into(), "a.example".into())]);
        assert!(!log[0].0.contains("token-plain-"));
        assert!(!log[0].0.contains("sk-new"));
    }

    #[test]
    fn fingerprint_mismatch_does_not_touch_transport() {
        let old = snap_api("sk-old", "a.example");
        let disk = snap_api("token-plain-sk-new", "b.example");
        let book = MineruCredBook::default();
        let mut log = Vec::new();
        let err = record_poll(&book, "p1", "api", &cred_fingerprint(&old), &disk, &mut log).unwrap_err();
        assert_eq!(err, "CRED_FINGERPRINT_MISMATCH");
        assert!(log.is_empty(), "new token must not reach the request");
    }

    #[test]
    fn probe_cache_key_changes_with_order_and_host() {
        let mut file = default_file_v2();
        file.ssh.enabled = true;
        file.api.token = "tok".into();
        let order: Vec<String> = vec!["ssh".into(), "api".into()];
        let base = probe_cache_key(&file, &order);
        file.ssh.host = "other.local".into();
        assert_ne!(probe_cache_key(&file, &order), base);
        let reordered: Vec<String> = vec!["api".into(), "ssh".into()];
        assert_ne!(probe_cache_key(&file, &reordered), base);
    }

    #[test]
    fn pick_provider_aggregates_failures_in_chinese() {
        let order: Vec<String> = vec!["local".into(), "ssh".into(), "api".into()];
        let probes = vec![
            HealthProbe {
                provider: "local".into(),
                ok: false,
                message: "找不到 MinerU socket".into(),
            },
            HealthProbe {
                provider: "ssh".into(),
                ok: false,
                message: "连接超时".into(),
            },
            HealthProbe {
                provider: "api".into(),
                ok: false,
                message: "当日额度已用尽".into(),
            },
        ];
        let err = pick_provider(&order, &probes).unwrap_err();
        assert!(err.contains("本地 CLI：找不到 MinerU socket"), "{err}");
        assert!(err.contains("SSH 远程：连接超时"), "{err}");
        assert!(err.contains("官方 API：当日额度已用尽"), "{err}");
        assert_eq!(err.matches('；').count(), 2);

        // 无探针 → 明确提示
        assert_eq!(
            pick_provider(&order, &[]).unwrap_err(),
            "没有启用任何 MinerU 来源"
        );
    }

    #[test]
    fn page_range_boundaries() {
        assert!(valid_page_range("all"));
        assert!(valid_page_range("1-3,5"));
        assert!(!valid_page_range(""));
        assert!(!valid_page_range("1;2"));
        assert!(!valid_page_range("1 2"));
        assert!(!valid_page_range(&"a".repeat(65)));
    }

    #[test]
    fn parse_ids_and_doc_ref_validation() {
        assert!(valid_parse_ids(&["12".into(), "345".into()]));
        assert!(!valid_parse_ids(&["12a".into()]));
        assert!(!valid_parse_ids(&["".into()]));
        assert!(!valid_parse_ids(&["; rm -rf".into()]));
        assert!(valid_doc_ref("abc-123"));
        assert!(!valid_doc_ref("a b"));
        assert!(!valid_doc_ref("a/b"));
    }

    #[test]
    fn parse_submit_body_maps_doclib_response() {
        let body =
            r#"{"short_id":"doc-42","status":"pending","tier":"flash","created_parse_ids":[7,3]}"#;
        let result = parse_submit_body(body, "local", "/tmp/a.pdf", "standard").unwrap();
        assert_eq!(result.provider, "local");
        assert_eq!(result.remote_path, "/tmp/a.pdf");
        assert_eq!(result.short_id, "doc-42");
        assert_eq!(result.parse_ids, vec!["3", "7"]);
        assert_eq!(result.tier, "flash");

        assert!(parse_submit_body("{}", "local", "/tmp/a.pdf", "standard").is_err());
    }

    #[test]
    fn ssh_resolved_defaults_and_doclib_status_message() {
        let cfg = SshCfg {
            enabled: true,
            host: "imac.local".into(),
            port: 0,
            user: "yang".into(),
            identity_file: String::new(),
            socket_path: "~/.mineru/doclib.sock".into(),
            inbox_dir: String::new(),
        };
        let ssh = SshResolved::from_cfg(&cfg, Path::new("/tmp/paper-field-home"));
        assert_eq!(ssh.host, "imac.local");
        assert_eq!(ssh.port, 0);
        assert!(ssh.identity.is_none());
        assert!(ssh.ensure().is_ok());

        let ok = json!({"running": true, "version": "4.5.1"}).to_string();
        assert_eq!(
            doclib_status_message(&ok, false).unwrap(),
            "已连接 MinerU 4.5.1"
        );
        assert_eq!(
            doclib_status_message(&ok, true).unwrap(),
            "已连接 MinerU 4.5.1（SSH 远程）"
        );
        let stopped = json!({"running": false}).to_string();
        assert_eq!(
            doclib_status_message(&stopped, false).unwrap_err(),
            "MinerU 文档库没有在运行"
        );
    }

    // ---------- 真实环境端到端（默认跳过） ----------
    //
    // 需要本机能免密 ssh 到 imac 且远端 doclib 服务在运行；样本为真实论文 PDF。
    // 运行：cargo test --manifest-path src-tauri/Cargo.toml e2e_ -- --ignored --nocapture
    mod e2e {
        use super::*;
        use std::path::PathBuf;
        use std::time::Duration;

        fn fixture_pdf() -> PathBuf {
            let path =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/e2e-sample.pdf");
            assert!(path.is_file(), "缺少测试样本 {}", path.display());
            path
        }

        /// 与真实部署一致的配置：local 启用但本机没有 socket（验证回退），api 未配 token。
        fn real_file() -> MineruFileV2 {
            let mut file: MineruFileV2 = serde_json::from_str(r#"{"version":2}"#).unwrap();
            file.order = vec!["local".to_string(), "ssh".to_string(), "api".to_string()];
            file.local.enabled = true;
            file.ssh.enabled = true;
            file.ssh.host = "imac".to_string();
            file.ssh.user = "user".to_string();
            file.ssh.socket_path = "~/.mineru/doclib.sock".to_string();
            file.ssh.inbox_dir = "~/.mineru/paper-field-inbox".to_string();
            file
        }

        fn platform_home() -> PathBuf {
            PathBuf::from("/tmp/paper-field-home")
        }

        #[tokio::test]
        #[ignore = "需要真实 iMac SSH 环境与 doclib 服务"]
        async fn e2e_ssh_health() {
            let file = real_file();
            let provider = build_provider(&file, "ssh", &platform_home()).unwrap();
            let message = provider.health().await.expect("SSH 健康检查应成功");
            assert!(
                message.contains("已连接 MinerU"),
                "健康检查返回异常：{message}"
            );
        }

        #[tokio::test]
        #[ignore = "需要真实 iMac SSH 环境与 doclib 服务"]
        async fn e2e_fallback_picks_ssh() {
            let file = real_file();
            let order = enabled_order(&file);
            assert_eq!(order, vec!["local".to_string(), "ssh".to_string()]);
            let mut probes = Vec::new();
            for name in &order {
                let provider = build_provider(&file, name, &platform_home()).unwrap();
                let result = provider.health().await;
                let ok = result.is_ok();
                let message = result.unwrap_or_else(|err| err);
                probes.push(HealthProbe {
                    provider: name.clone(),
                    ok,
                    message,
                });
            }
            assert!(
                !probes[0].ok,
                "本机不应有 MinerU socket（否则回退场景不成立）：{}",
                probes[0].message
            );
            assert!(probes[1].ok, "SSH 探测应成功：{}", probes[1].message);
            assert_eq!(pick_provider(&order, &probes).unwrap(), "ssh");
        }

        #[tokio::test]
        #[ignore = "需要真实 iMac SSH 环境与 doclib 服务"]
        async fn e2e_ssh_submit_parse_fetch() {
            let file = real_file();
            let pdf = fixture_pdf();
            let paper_id = "e2e00000-0000-4000-8000-000000000001";
            // 与前端 mineruSubmit 不带 provider 的路径一致：逐源探测 → 回退 → 提交
            let submitted = submit_with_fallback(&file, &platform_home(), paper_id, &pdf, false)
                .await
                .expect("自动回退提交应成功");
            assert_eq!(submitted.provider, "ssh", "应回退到 SSH 源");
            assert!(
                valid_doc_ref(&submitted.short_id),
                "short_id 无效：{}",
                submitted.short_id
            );
            assert!(!submitted.parse_ids.is_empty(), "提交响应缺少解析任务编号");

            // 恢复语义：轮询与取结果固定使用提交时的 provider
            let provider = build_provider(&file, "ssh", &platform_home()).unwrap();
            let mut settled = false;
            for _ in 0..90 {
                let polls = provider
                    .statuses(&submitted.short_id, &submitted.parse_ids)
                    .await
                    .expect("轮询应成功");
                if let Some(bad) = polls.iter().find(|p| p.status == "failed") {
                    panic!("解析失败：{bad:?}");
                }
                let waiting = polls
                    .iter()
                    .any(|p| p.status == "pending" || p.status == "parsing");
                if !waiting
                    && polls
                        .iter()
                        .any(|p| p.status == "done" || p.status == "superseded")
                {
                    settled = true;
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            assert!(settled, "解析在 180 秒内未完成");

            let markdown = provider
                .markdown(&submitted.short_id, &submitted.tier, &file.page_range)
                .await
                .expect("取回解析全文应成功");
            assert!(
                markdown.len() > 200,
                "解析结果过短（{} 字节）",
                markdown.len()
            );
            let lower = markdown.to_lowercase();
            assert!(
                lower.contains("sima") || lower.contains("softmax"),
                "解析全文未包含样本论文关键词"
            );
        }
    }

    // ---------- list_pdfs：只读所选目录一层，不进入子目录 ----------

    fn temp_scan_dir(tag: &str) -> PathBuf {
        crate::test_util::unique_temp_dir(&format!("pf-list-pdfs-{tag}"))
    }

    #[test]
    fn scan_pdfs_in_dir_reads_only_top_level() {
        let dir = temp_scan_dir("top");
        fs::write(dir.join("a.pdf"), b"x").unwrap();
        fs::write(dir.join("B.PDF"), b"x").unwrap();
        fs::write(dir.join(".hidden.pdf"), b"x").unwrap();
        fs::write(dir.join("note.txt"), b"x").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("child.pdf"), b"x").unwrap();

        let list = scan_pdfs_in_dir(&dir.to_string_lossy()).expect("扫描应成功");
        let names: Vec<String> = list
            .iter()
            .map(|p| {
                Path::new(p)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        // 只取目录本身：子目录里的 child.pdf、隐藏文件与非 PDF 都不出现。
        assert_eq!(names, vec!["B.PDF".to_string(), "a.pdf".to_string()]);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_pdfs_in_dir_errors_when_pdfs_only_in_subdir() {
        let dir = temp_scan_dir("subonly");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub").join("child.pdf"), b"x").unwrap();

        let err = scan_pdfs_in_dir(&dir.to_string_lossy()).expect_err("应报没有 PDF");
        assert!(err.contains("没有 PDF"), "错误文案应说明没有 PDF：{err}");

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scan_pdfs_in_dir_rejects_missing_dir() {
        let missing = std::env::temp_dir().join("pf-list-pdfs-missing");
        let err = scan_pdfs_in_dir(&missing.to_string_lossy()).expect_err("应报目录不存在");
        assert_eq!(err, "目录不存在");
    }
}
