use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::app_config_dir;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Off,
    Local,
    Ssh,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MineruInput {
    #[serde(default)]
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

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MineruFile {
    mode: String,
    socket_path: String,
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    identity_file: String,
    remote_inbox: String,
    tier: String,
    page_range: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MineruPublic {
    mode: String,
    socket_path: String,
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    identity_file: String,
    remote_inbox: String,
    tier: String,
    page_range: String,
    configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
    remote_path: String,
    short_id: String,
    parse_ids: Vec<i64>,
    status: String,
    tier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsePoll {
    id: i64,
    status: String,
    error: Option<String>,
}

struct Resolved {
    mode: Mode,
    socket_path: String,
    ssh_host: String,
    ssh_port: u16,
    ssh_user: String,
    identity: Option<String>,
    remote_inbox: String,
    tier: String,
    page_range: String,
}

fn default_file() -> MineruFile {
    MineruFile {
        mode: "off".into(),
        socket_path: "~/.mineru/doclib.sock".into(),
        ssh_host: String::new(),
        ssh_port: 22,
        ssh_user: String::new(),
        identity_file: String::new(),
        remote_inbox: "~/.mineru/paper-field-inbox".into(),
        tier: "standard".into(),
        page_range: "all".into(),
    }
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_config_dir(app)?.join("mineru-settings.json"))
}

fn read_file(app: &AppHandle) -> Result<MineruFile, String> {
    let path = settings_file(app)?;
    if !path.exists() {
        return Ok(default_file());
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn normalize_file(input: &MineruInput) -> MineruFile {
    let mode = match input.mode.trim() {
        "local" => "local",
        "ssh" => "ssh",
        _ => "off",
    };
    let tier = match input.tier.trim() {
        "flash" | "basic" | "standard" | "advanced" => input.tier.trim(),
        _ => "standard",
    };
    let page_range = if valid_page_range(input.page_range.trim()) {
        input.page_range.trim()
    } else {
        "all"
    };
    MineruFile {
        mode: mode.into(),
        socket_path: fallback(input.socket_path.trim(), "~/.mineru/doclib.sock"),
        ssh_host: input.ssh_host.trim().into(),
        ssh_port: if input.ssh_port == 0 { 22 } else { input.ssh_port },
        ssh_user: input.ssh_user.trim().into(),
        identity_file: input.identity_file.trim().into(),
        remote_inbox: fallback(input.remote_inbox.trim(), "~/.mineru/paper-field-inbox"),
        tier: tier.into(),
        page_range: page_range.into(),
    }
}

fn to_public(file: &MineruFile) -> MineruPublic {
    MineruPublic {
        mode: file.mode.clone(),
        socket_path: file.socket_path.clone(),
        ssh_host: file.ssh_host.clone(),
        ssh_port: file.ssh_port,
        ssh_user: file.ssh_user.clone(),
        identity_file: file.identity_file.clone(),
        remote_inbox: file.remote_inbox.clone(),
        tier: file.tier.clone(),
        page_range: file.page_range.clone(),
        configured: is_configured(file),
    }
}

fn is_configured(file: &MineruFile) -> bool {
    match file.mode.as_str() {
        "local" => !file.socket_path.trim().is_empty(),
        "ssh" => valid_host(&file.ssh_host) && valid_user(&file.ssh_user),
        _ => false,
    }
}

fn resolve(input: &MineruInput) -> Result<Resolved, String> {
    let file = normalize_file(input);
    let mode = match file.mode.as_str() {
        "local" => Mode::Local,
        "ssh" => Mode::Ssh,
        _ => Mode::Off,
    };
    if mode == Mode::Off {
        return Err("请先选择 MinerU 连接方式".into());
    }
    if mode == Mode::Ssh {
        if !valid_host(&file.ssh_host) {
            return Err("SSH 主机无效".into());
        }
        if !valid_user(&file.ssh_user) {
            return Err("SSH 用户无效".into());
        }
        if file.ssh_port == 0 {
            return Err("SSH 端口无效".into());
        }
    }
    if !valid_page_range(&file.page_range) {
        return Err("页码范围无效".into());
    }
    let identity = if file.identity_file.is_empty() {
        None
    } else {
        let path = expand_local(&file.identity_file);
        if !Path::new(&path).is_file() {
            return Err(format!("私钥不存在：{path}"));
        }
        Some(path)
    };
    Ok(Resolved {
        mode,
        socket_path: file.socket_path,
        ssh_host: file.ssh_host,
        ssh_port: file.ssh_port,
        ssh_user: file.ssh_user,
        identity,
        remote_inbox: file.remote_inbox,
        tier: file.tier,
        page_range: file.page_range,
    })
}

fn fallback(value: &str, default_value: &str) -> String {
    if value.is_empty() {
        default_value.into()
    } else {
        value.into()
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
    value.len() == 36
        && value
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
}

fn expand_local(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    expand_tilde(path, &home)
}

fn expand_tilde(path: &str, home: &str) -> String {
    if path == "~" {
        home.to_string()
    } else if let Some(rest) = path.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        path.to_string()
    }
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn clip(value: &str) -> String {
    value.chars().take(280).collect()
}

fn push_ssh_opts(cmd: &mut Command, port_flag: &str, settings: &Resolved) {
    cmd.arg("-o").arg("BatchMode=yes");
    cmd.arg("-o").arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o").arg("ConnectTimeout=20");
    cmd.arg("-o").arg("ServerAliveInterval=5");
    cmd.arg("-o").arg("ServerAliveCountMax=3");
    cmd.arg(port_flag).arg(settings.ssh_port.to_string());
    if let Some(key) = &settings.identity {
        cmd.arg("-o").arg("IdentitiesOnly=yes");
        cmd.arg("-i").arg(key);
    }
}

fn ssh_target(settings: &Resolved) -> String {
    format!("{}@{}", settings.ssh_user, settings.ssh_host)
}

fn run_command(mut cmd: Command, stdin_data: Option<&[u8]>) -> Result<Output, String> {
    if stdin_data.is_some() {
        cmd.stdin(Stdio::piped());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            "找不到 ssh、scp 或 curl".to_string()
        } else {
            err.to_string()
        }
    })?;
    if let Some(data) = stdin_data {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(data).map_err(|e| e.to_string())?;
        }
    }
    child.wait_with_output().map_err(|e| e.to_string())
}

fn command_text(output: &Output) -> Result<String, String> {
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = if stderr.trim().is_empty() {
        clip(stdout.trim())
    } else {
        clip(stderr.trim())
    };
    if detail.contains("Permission denied") {
        return Err("SSH 登录被拒绝，请检查用户和私钥".into());
    }
    Err(if detail.is_empty() {
        "SSH 命令失败".into()
    } else {
        detail
    })
}

fn ssh_exec(settings: &Resolved, remote: &str, stdin_data: Option<&[u8]>) -> Result<String, String> {
    let mut cmd = Command::new("ssh");
    push_ssh_opts(&mut cmd, "-p", settings);
    cmd.arg(ssh_target(settings));
    cmd.arg(remote);
    let output = run_command(cmd, stdin_data)?;
    command_text(&output)
}

fn split_http(raw: &str) -> Result<String, String> {
    const MARK: &str = "\n__PF_HTTP__";
    let Some(idx) = raw.rfind(MARK) else {
        return Err(format!("MinerU 没有返回状态码：{}", clip(raw)));
    };
    let body = raw[..idx].trim().to_string();
    let code: u16 = raw[idx + MARK.len()..].trim().parse().unwrap_or(0);
    if !(200..300).contains(&code) {
        let message = serde_json::from_str::<Value>(&body)
            .ok()
            .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
            .unwrap_or_else(|| clip(&body));
        return Err(format!("MinerU HTTP {code}：{message}"));
    }
    Ok(body)
}

fn curl_write_flag() -> &'static str {
    "\n__PF_HTTP__%{http_code}"
}

fn local_socket(settings: &Resolved) -> Result<String, String> {
    let socket = expand_local(&settings.socket_path);
    if !Path::new(&socket).exists() {
        return Err(format!("找不到 MinerU socket：{socket}"));
    }
    Ok(socket)
}

fn remote_socket(settings: &Resolved, home: &str) -> Result<String, String> {
    let socket = expand_tilde(&settings.socket_path, home);
    if socket.contains(['\n', '\r', '\0']) {
        return Err("socket 路径无效".into());
    }
    Ok(socket)
}

fn local_request(settings: &Resolved, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let socket = local_socket(settings)?;
    let url = format!("http://mineru{path}");
    let mut cmd = Command::new("curl");
    cmd.args([
        "-sS",
        "--max-time",
        "120",
        "--unix-socket",
        &socket,
        "-H",
        "Content-Type: application/json",
        "-X",
        method,
        "-w",
        curl_write_flag(),
        &url,
    ]);
    if body.is_some() {
        cmd.arg("--data-binary").arg("@-");
    }
    let output = run_command(cmd, body.map(str::as_bytes))?;
    let stdout = command_text(&output)?;
    split_http(&stdout)
}

fn remote_request(settings: &Resolved, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    let home = remote_home(settings)?;
    let socket = remote_socket(settings, &home)?;
    let data = if body.is_some() { " --data-binary @-" } else { "" };
    let url = format!("http://mineru{path}");
    let remote = format!(
        "curl -sS --max-time 120 --unix-socket {} -H {} -X {} {} -w {}{}",
        shell_quote(&socket),
        shell_quote("Content-Type: application/json"),
        method,
        shell_quote(&url),
        shell_quote(curl_write_flag()),
        data
    );
    let stdout = ssh_exec(settings, &remote, body.map(str::as_bytes))?;
    split_http(&stdout)
}

fn request(settings: &Resolved, method: &str, path: &str, body: Option<&str>) -> Result<String, String> {
    match settings.mode {
        Mode::Local => local_request(settings, method, path, body),
        Mode::Ssh => remote_request(settings, method, path, body),
        Mode::Off => Err("MinerU 未配置".into()),
    }
}

fn remote_home(settings: &Resolved) -> Result<String, String> {
    let key = format!("{}@{}:{}", settings.ssh_user, settings.ssh_host, settings.ssh_port);
    let cached = HOME_CACHE.with(|cache| cache.borrow().get(&key).cloned());
    if let Some(home) = cached {
        return Ok(home);
    }
    let home = ssh_exec(settings, r#"printf %s "$HOME""#, None)?;
    let home = home.trim();
    if home.is_empty() || home.contains(['\n', '\r', ' ']) {
        return Err("无法读取远端主目录".into());
    }
    let home = home.to_string();
    HOME_CACHE.with(|cache| cache.borrow_mut().insert(key, home.clone()));
    Ok(home)
}

thread_local! {
    static HOME_CACHE: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

fn remote_get_many(settings: &Resolved, paths: &[String]) -> Result<Vec<String>, String> {
    let home = remote_home(settings)?;
    let socket = remote_socket(settings, &home)?;
    let mut script = String::new();
    for (index, path) in paths.iter().enumerate() {
        let url = format!("http://mineru{path}");
        script.push_str(&format!("printf '%s\\n' __PF_ITEM_{index}\n"));
        script.push_str(&format!(
            "curl -sS --max-time 60 --unix-socket {} {} -w {}\n",
            shell_quote(&socket),
            shell_quote(&url),
            shell_quote(curl_write_flag())
        ));
    }
    let raw = ssh_exec(settings, &script, None)?;
    let mut bodies = Vec::with_capacity(paths.len());
    for index in 0..paths.len() {
        let marker = format!("__PF_ITEM_{index}\n");
        let start = raw
            .find(&marker)
            .ok_or_else(|| "MinerU 批量状态返回不完整".to_string())?
            + marker.len();
        let end = if index + 1 < paths.len() {
            raw[start..]
                .find(&format!("__PF_ITEM_{}\n", index + 1))
                .map(|offset| start + offset)
                .unwrap_or(raw.len())
        } else {
            raw.len()
        };
        bodies.push(split_http(&raw[start..end])?);
    }
    Ok(bodies)
}

fn local_get_many(settings: &Resolved, paths: &[String]) -> Result<Vec<String>, String> {
    let mut bodies = Vec::with_capacity(paths.len());
    for path in paths {
        bodies.push(local_request(settings, "GET", path, None)?);
    }
    Ok(bodies)
}

fn encode_query(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn parse_ids(value: &Value) -> Vec<i64> {
    let mut ids = Vec::new();
    for key in ["created_parse_ids", "wait_parse_ids", "reused_parse_ids"] {
        if let Some(list) = value.get(key).and_then(Value::as_array) {
            for item in list {
                if let Some(id) = item.as_i64() {
                    ids.push(id);
                }
            }
        }
    }
    ids.sort_unstable();
    ids.dedup();
    ids
}

fn canonical_pdf(path: &str) -> Result<PathBuf, String> {
    let file = PathBuf::from(path);
    if !file.is_file() {
        return Err("PDF 不存在".into());
    }
    let canon = file.canonicalize().map_err(|e| e.to_string())?;
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

fn copy_to_remote(settings: &Resolved, local: &Path, paper_id: &str) -> Result<String, String> {
    if !valid_paper_id(paper_id) {
        return Err("论文编号无效".into());
    }
    let home = remote_home(settings)?;
    let inbox = expand_tilde(&settings.remote_inbox, &home);
    if inbox.contains(['\n', '\r', '\0', ' ', '"', '\'']) {
        return Err("远程暂存目录不能包含空格或引号".into());
    }
    ssh_exec(settings, &format!("mkdir -p {}", shell_quote(&inbox)), None)?;
    let remote_file = format!("{inbox}/{paper_id}.pdf");
    let mut cmd = Command::new("scp");
    push_ssh_opts(&mut cmd, "-P", settings);
    cmd.arg(local);
    cmd.arg(format!("{}:{remote_file}", ssh_target(settings)));
    let output = run_command(cmd, None)?;
    command_text(&output)?;
    Ok(remote_file)
}

#[tauri::command]
pub fn mineru_settings(app: AppHandle) -> Result<MineruPublic, String> {
    Ok(to_public(&read_file(&app)?))
}

#[tauri::command]
pub fn save_mineru_settings(app: AppHandle, settings: MineruInput) -> Result<MineruPublic, String> {
    let file = normalize_file(&settings);
    if file.mode == "ssh" {
        resolve(&settings)?;
    }
    if file.mode == "local" && file.socket_path.trim().is_empty() {
        return Err("请填写本机 socket 路径".into());
    }
    let path = settings_file(&app)?;
    let raw = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())?;
    Ok(to_public(&file))
}

#[tauri::command]
pub fn mineru_test(settings: MineruInput) -> Result<String, String> {
    let resolved = resolve(&settings)?;
    let body = request(&resolved, "GET", "/api/v1/server/status", None)?;
    let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    if json["running"].as_bool() != Some(true) {
        return Err("MinerU 文档库没有在运行".into());
    }
    let version = json["version"].as_str().unwrap_or("4");
    Ok(format!("已连接 MinerU {version}"))
}

#[tauri::command]
pub fn list_pdfs(directory: String) -> Result<Vec<String>, String> {
    let root = PathBuf::from(&directory);
    if !root.is_dir() {
        return Err("目录不存在".into());
    }
    let mut found = Vec::new();
    walk_pdfs(&root, &mut found, 0)?;
    found.sort();
    if found.is_empty() {
        return Err("这个目录里没有 PDF".into());
    }
    Ok(found)
}

fn walk_pdfs(dir: &Path, found: &mut Vec<String>, depth: usize) -> Result<(), String> {
    if depth > 8 || found.len() >= 4000 {
        return Ok(());
    }
    let entries = fs::read_dir(dir).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            walk_pdfs(&path, found, depth + 1)?;
        } else if name.to_ascii_lowercase().ends_with(".pdf") {
            if let Ok(canon) = canonical_pdf(&path.to_string_lossy()) {
                found.push(canon.to_string_lossy().to_string());
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn normalize_pdf(path: String) -> Result<String, String> {
    Ok(canonical_pdf(&path)?.to_string_lossy().to_string())
}

#[tauri::command]
pub fn open_pdf(path: String) -> Result<(), String> {
    let canon = canonical_pdf(&path)?;
    let status = Command::new("open")
        .arg(&canon)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("无法打开 PDF".into())
    }
}

#[tauri::command]
pub fn mineru_submit(
    settings: MineruInput,
    local_path: String,
    paper_id: String,
    force: bool,
) -> Result<SubmitResult, String> {
    let resolved = resolve(&settings)?;
    let local = canonical_pdf(&local_path)?;
    let remote_path = match resolved.mode {
        Mode::Local => local.to_string_lossy().to_string(),
        Mode::Ssh => copy_to_remote(&resolved, &local, &paper_id)?,
        Mode::Off => return Err("MinerU 未配置".into()),
    };
    let payload = serde_json::json!({
        "path": remote_path,
        "tier": resolved.tier,
        "page_range": resolved.page_range,
        "force": force,
        "remote": false
    });
    let body = request(
        &resolved,
        "POST",
        "/api/v1/parses",
        Some(&payload.to_string()),
    )?;
    let json: Value = serde_json::from_str(&body).map_err(|e| format!("MinerU 返回无法解析：{e}"))?;
    let short_id = json["short_id"].as_str().unwrap_or("").to_string();
    if !valid_doc_ref(&short_id) {
        return Err("MinerU 没有返回文档编号".into());
    }
    Ok(SubmitResult {
        remote_path,
        short_id,
        parse_ids: parse_ids(&json),
        status: json["status"].as_str().unwrap_or("pending").to_string(),
        tier: json["tier"].as_str().unwrap_or(&resolved.tier).to_string(),
    })
}

#[tauri::command]
pub fn mineru_parse_statuses(settings: MineruInput, parse_ids: Vec<i64>) -> Result<Vec<ParsePoll>, String> {
    let resolved = resolve(&settings)?;
    if parse_ids.is_empty() {
        return Ok(Vec::new());
    }
    if parse_ids.len() > 32 {
        return Err("一次查询的解析任务过多".into());
    }
    let paths: Vec<String> = parse_ids.iter().map(|id| format!("/api/v1/parses/{id}")).collect();
    let bodies = match resolved.mode {
        Mode::Local => local_get_many(&resolved, &paths)?,
        Mode::Ssh => remote_get_many(&resolved, &paths)?,
        Mode::Off => return Err("MinerU 未配置".into()),
    };
    let mut polls = Vec::with_capacity(bodies.len());
    for (index, body) in bodies.iter().enumerate() {
        let json: Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
        polls.push(ParsePoll {
            id: parse_ids[index],
            status: json["status"].as_str().unwrap_or("pending").to_string(),
            error: json["error_msg"].as_str().map(str::to_string),
        });
    }
    Ok(polls)
}

#[tauri::command]
pub fn mineru_markdown(
    settings: MineruInput,
    doc_ref: String,
    tier: String,
    page_range: String,
) -> Result<String, String> {
    let resolved = resolve(&settings)?;
    if !valid_doc_ref(&doc_ref) {
        return Err("文档编号无效".into());
    }
    let tier = match tier.as_str() {
        "flash" | "basic" | "standard" | "advanced" => tier,
        _ => resolved.tier.clone(),
    };
    let page_range = if valid_page_range(&page_range) {
        page_range
    } else {
        resolved.page_range.clone()
    };
    let mut after: Option<String> = None;
    let mut chunks = Vec::new();
    let mut total = 0usize;
    for _ in 0..16 {
        let mut path = format!(
            "/api/v1/docs/{doc_ref}/content?tier={tier}&format=markdown&page_range={}&limit=60000",
            encode_query(&page_range)
        );
        if let Some(cursor) = &after {
            path.push_str("&after=");
            path.push_str(&encode_query(cursor));
        }
        let body = request(&resolved, "GET", &path, None)?;
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
