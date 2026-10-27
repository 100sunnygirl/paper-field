//! MinerU 官方 API（mineru.net）客户端。
//!
//! 端点路径集中为常量，便于在 batch 路径与历史 bearer 路径之间切换；
//! 上传一律 PUT 原始字节到预签名 URL，且不设置 Content-Type。
#![deny(clippy::string_slice)]

use std::fs;
use std::io::{Cursor, Read};
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::io_util::{read_text_capped, reqwest_error_text, MINERU_JSON_LIMIT};
use crate::mineru::{with_timeout, ApiCfg, ParsePoll, FETCH_TIMEOUT};

pub const API_BASE: &str = "https://mineru.net";
pub const PATH_FILE_URLS: &str = "/api/v4/file-urls/batch";
/// 历史版本路径，保留为常量便于在 batch 与 bearer 之间切换（任务书要求）。
#[allow(dead_code)]
pub const PATH_FILE_URLS_LEGACY: &str = "/api/v4/file-urls/bearer";
pub const PATH_EXTRACT_BATCH_FMT: &str = "/api/v4/extract-results/batch/{batch_id}";
/// 历史版本路径，同上。
#[allow(dead_code)]
pub const PATH_EXTRACT_BATCH_LEGACY_FMT: &str = "/api/v4/extract-results/bearer/{batch_id}";

/// 探测 token 用的哑 batch id，预期返回 -60012（任务不存在），
/// 能取到该错误码即证明 HTTPS 可达且 token 有效。
pub const PROBE_BATCH_ID: &str = "pf-probe-000000000000";

/// 官方 API 单文件大小上限（200MB）。
pub const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;

pub struct ApiClient {
    #[cfg(test)]
    base_url: String,
    token: String,
    model_version: String,
    language: String,
    enable_formula: bool,
    enable_table: bool,
}

impl ApiClient {
    pub fn new(cfg: &ApiCfg) -> Self {
        Self {
            #[cfg(test)]
            base_url: API_BASE.into(),
            token: cfg.token.trim().to_string(),
            model_version: cfg.model_version.clone(),
            language: cfg.language.clone(),
            enable_formula: cfg.enable_formula,
            enable_table: cfg.enable_table,
        }
    }

    fn api_base(&self) -> &str {
        #[cfg(test)]
        {
            &self.base_url
        }
        #[cfg(not(test))]
        {
            API_BASE
        }
    }

    pub fn model_version(&self) -> &str {
        &self.model_version
    }

    /// 健康检查：请求一个必然不存在的 batch，取到 -60012 即 token 有效。
    pub async fn health(&self) -> Result<String, String> {
        if self.token.is_empty() {
            return Err("未配置 mineru.net API Token".into());
        }
        let client = api_client()?;
        let url = extract_batch_url(self.api_base(), PROBE_BATCH_ID);
        let response = client
            .get(&url)
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .send()
            .await
            .map_err(|e| format!("无法连接 mineru.net：{}", reqwest_error_text(e)))?;
        let status = response.status();
        let text = read_text_capped(response, MINERU_JSON_LIMIT).await?;
        let pair = parse_error_pair(&text);
        let pair_ref = pair.as_ref().map(|(code, msg)| (code.as_str(), msg.as_str()));
        match pair_ref {
            Some(("-60012", _)) => Ok("已连接 mineru.net 官方 API（Token 有效）".into()),
            Some((code, msg)) => Err(api_error_message(code, msg)),
            None => Err(format!(
                "mineru.net 返回异常（HTTP {status}）：{}",
                clip(&text)
            )),
        }
    }

    /// 提交解析：申请预签名上传 URL → PUT 文件字节。返回 batch_id。
    pub async fn submit(&self, paper_id: &str, pdf: &Path, page_range: &str) -> Result<String, String> {
        if self.token.is_empty() {
            return Err("未配置 mineru.net API Token".into());
        }
        let meta = fs::metadata(pdf).map_err(|e| format!("读取 PDF 失败：{e}"))?;
        if meta.len() > MAX_FILE_BYTES {
            return Err(api_error_message("-60005", ""));
        }
        let file_name = pdf
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "paper.pdf".into());
        let body = build_submit_body(
            &self.model_version,
            &self.language,
            self.enable_formula,
            self.enable_table,
            paper_id,
            &file_name,
            page_range,
        );
        let client = api_client()?;
        let response = client
            .post(format!("{}{PATH_FILE_URLS}", self.api_base()))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("无法连接 mineru.net：{}", reqwest_error_text(e)))?;
        let status = response.status();
        let text = read_text_capped(response, MINERU_JSON_LIMIT).await?;
        if !status.is_success() {
            return Err(map_http_error(status, &text));
        }
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|e| format!("mineru.net 返回无法解析：{e}"))?;
        if let Some((code, msg)) = parse_error_pair(&text) {
            if code != "0" {
                return Err(api_error_message(&code, &msg));
            }
        }
        let data = &parsed["data"];
        let batch_id = data["batch_id"].as_str().unwrap_or("").to_string();
        let upload_url = data["file_urls"]
            .as_array()
            .and_then(|list| list.first())
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if batch_id.is_empty() || upload_url.is_empty() {
            return Err("mineru.net 没有返回上传地址".into());
        }
        let bytes = fs::read(pdf).map_err(|e| format!("读取 PDF 失败：{e}"))?;
        // PUT 原始字节到预签名 URL：不带 Authorization，也绝不设置 Content-Type。
        with_timeout(FETCH_TIMEOUT, async {
            let client = api_client()?;
            let response = client
                .put(&upload_url)
                .timeout(Duration::from_secs(FETCH_TIMEOUT.as_secs().max(60)))
                .body(bytes)
                .send()
                .await
                .map_err(|e| format!("上传 PDF 到 mineru.net 失败：{}", reqwest_error_text(e)))?;
            if !response.status().is_success() {
                return Err(format!("上传 PDF 失败（HTTP {}）", response.status()));
            }
            Ok(())
        })
        .await?;
        Ok(batch_id)
    }

    async fn fetch_batch(&self, batch_id: &str) -> Result<Value, String> {
        let client = api_client()?;
        let url = extract_batch_url(self.api_base(), batch_id);
        let response = client
            .get(&url)
            .bearer_auth(&self.token)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .send()
            .await
            .map_err(|e| format!("无法连接 mineru.net：{}", reqwest_error_text(e)))?;
        let status = response.status();
        let text = read_text_capped(response, MINERU_JSON_LIMIT).await?;
        if !status.is_success() {
            return Err(map_http_error(status, &text));
        }
        let parsed: Value = serde_json::from_str(&text)
            .map_err(|e| format!("mineru.net 返回无法解析：{e}"))?;
        if let Some((code, msg)) = parse_error_pair(&text) {
            if code != "0" {
                return Err(api_error_message(&code, &msg));
            }
        }
        Ok(parsed)
    }

    /// 轮询：data_ids 为空时返回整批结果，否则只保留 data_id 匹配的条目。
    pub async fn statuses(&self, batch_id: &str, data_ids: &[String]) -> Result<Vec<ParsePoll>, String> {
        let parsed = self.fetch_batch(batch_id).await?;
        let list = parsed["data"]["extract_result"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut polls = Vec::new();
        for item in &list {
            let data_id = item["data_id"].as_str().unwrap_or("");
            if !data_ids.is_empty() && !data_ids.iter().any(|id| id == data_id) {
                continue;
            }
            polls.push(map_extract_item(item));
        }
        Ok(polls)
    }

    /// 取 markdown：轮询结果里 state=done 时下载 full_zip_url 并解出 full.md。
    pub async fn markdown(&self, batch_id: &str) -> Result<String, String> {
        let parsed = self.fetch_batch(batch_id).await?;
        let list = parsed["data"]["extract_result"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let item = list
            .first()
            .ok_or_else(|| "mineru.net 没有返回解析结果".to_string())?;
        let state = item["state"].as_str().unwrap_or("");
        if state != "done" {
            if let Some(err) = item["err_msg"].as_str() {
                if !err.is_empty() {
                    return Err(format!("mineru.net 解析失败：{}", clip(err)));
                }
            }
            return Err(format!("解析尚未完成（状态：{state}），请稍后重试"));
        }
        let zip_url = item["full_zip_url"].as_str().unwrap_or("");
        if zip_url.is_empty() {
            return Err("mineru.net 没有返回结果下载地址".into());
        }
        download_and_extract_markdown(zip_url).await
    }
}

/// Upper bound for the downloaded result ZIP.
pub const MAX_ZIP_BYTES: u64 = 200 * 1024 * 1024;
/// Upper bound for the uncompressed `full.md`.
pub const MAX_MD_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub struct ResultLimits {
    pub zip_bytes: u64,
    pub md_bytes: u64,
}

impl Default for ResultLimits {
    fn default() -> Self {
        Self { zip_bytes: MAX_ZIP_BYTES, md_bytes: MAX_MD_BYTES }
    }
}

fn mb(n: u64) -> u64 {
    (n / 1024 / 1024).max(1)
}

/// `full_zip_url` comes straight from the API response: https only, and an IP-literal
/// host must not be loopback/private/link-local (same rule as the lookup SSRF guard).
/// No domain allowlist yet: we have no real sample of the CDN host.
pub fn check_result_url(raw: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(raw.trim()).map_err(|_| "结果下载地址无效".to_string())?;
    if url.scheme() != "https" {
        return Err("结果下载地址必须是 https".into());
    }
    let host = url.host_str().ok_or_else(|| "结果下载地址无效".to_string())?;
    let literal = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = literal.parse::<std::net::IpAddr>() {
        if crate::lookup::is_forbidden(ip) {
            return Err("结果下载地址指向内网或本机，已拒绝".into());
        }
    }
    let name = host.trim_end_matches('.').to_ascii_lowercase();
    if name == "localhost" || name.ends_with(".localhost") {
        return Err("结果下载地址指向内网或本机，已拒绝".into());
    }
    Ok(url)
}

/// 下载结果 ZIP 并取出 full.md（下载超时 300s，ZIP 上限 200MB）。
pub async fn download_and_extract_markdown(url: &str) -> Result<String, String> {
    download_and_extract_markdown_with(url, ResultLimits::default()).await
}

pub async fn download_and_extract_markdown_with(url: &str, limits: ResultLimits) -> Result<String, String> {
    download_checked(check_result_url(url)?, limits).await
}

/// Caller must have run `check_result_url`; split out so tests can use a local server.
async fn download_checked(url: reqwest::Url, limits: ResultLimits) -> Result<String, String> {
    download_pinned(url, limits, crate::lookup::proxy_configured(), download_forbidden, system_resolve).await
}

/// Like `lookup::is_forbidden`, but lets 198.18.0.0/15 through: Clash/Surge
/// fake-ip (TUN) mode answers every name from that benchmark range without
/// setting any proxy env var, and the proxy then dials the real host itself.
fn download_forbidden(ip: std::net::IpAddr) -> bool {
    let v4 = match ip {
        std::net::IpAddr::V4(v4) => Some(v4),
        std::net::IpAddr::V6(v6) => v6.to_ipv4_mapped(),
    };
    if v4.is_some_and(|v4| matches!(v4.octets(), [198, 18 | 19, _, _])) {
        return false;
    }
    crate::lookup::is_forbidden(ip)
}

use crate::lookup::{check_target_with, system_resolve, Resolved, Resolver};

/// Redirects are followed by hand: every hop passes `check_result_url` (after
/// the first, which the caller checked), then is resolved once, refused if any
/// address is internal, and the connection is pinned to the checked address so
/// a second DNS answer cannot point it elsewhere.
async fn download_pinned(
    mut url: reqwest::Url,
    limits: ResultLimits,
    proxied: bool,
    forbidden: fn(std::net::IpAddr) -> bool,
    resolve: Resolver,
) -> Result<String, String> {
    with_timeout(FETCH_TIMEOUT, async {
        let mut hops = 0;
        let mut response = loop {
            let client = download_client(&url, proxied, forbidden, resolve).await?;
            let response = client
                .get(url.clone())
                .timeout(Duration::from_secs(FETCH_TIMEOUT.as_secs().max(60)))
                .send()
                .await
                .map_err(|e| format!("下载解析结果失败：{}", error_chain(&redact_url(e))))?;
            if !response.status().is_redirection() {
                break response;
            }
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err("下载解析结果失败：重定向次数过多".into());
            }
            let next = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|loc| url.join(loc).ok())
                .ok_or_else(|| "下载解析结果失败：重定向地址无效".to_string())?;
            url = check_result_url(next.as_str())
                .map_err(|_| "下载解析结果失败：结果下载地址重定向到了不允许的地址".to_string())?;
        };
        if !response.status().is_success() {
            return Err(format!("下载解析结果失败（HTTP {}）", response.status()));
        }
        let too_big = || format!("解析结果压缩包超过 {}MB，已停止下载", mb(limits.zip_bytes));
        if response.content_length().is_some_and(|n| n > limits.zip_bytes) {
            return Err(too_big());
        }
        let mut bytes: Vec<u8> = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|e| format!("下载解析结果失败：{}", redact_url(e)))?
        {
            if bytes.len() as u64 + chunk.len() as u64 > limits.zip_bytes {
                return Err(too_big());
            }
            bytes.extend_from_slice(&chunk);
        }
        extract_full_md_with(&bytes, limits.md_bytes)
    })
    .await
}

const MAX_REDIRECTS: usize = 5;

/// Result URLs are pre-signed; drop query, fragment and userinfo so
/// signatures never reach error messages or logs.
fn redact_url(mut e: reqwest::Error) -> reqwest::Error {
    if let Some(url) = e.url_mut() {
        url.set_query(None);
        url.set_fragment(None);
        let _ = url.set_username("");
        let _ = url.set_password(None);
    }
    e
}

/// reqwest hides the redirect-policy message in `source()`; surface it.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    while let Some(src) = cur {
        let msg = src.to_string();
        if !out.contains(&msg) {
            out.push_str("：");
            out.push_str(&msg);
        }
        cur = src.source();
    }
    out
}

/// `full.md` at the root or one directory down, matched by whole file name.
fn is_full_md(name: &str) -> bool {
    name == "full.md" || name.rsplit_once('/').is_some_and(|(_, file)| file == "full.md")
}

/// 从 ZIP 字节中取出 full.md；找不到时报中文错误。
pub fn extract_full_md(bytes: &[u8]) -> Result<String, String> {
    extract_full_md_with(bytes, MAX_MD_BYTES)
}

pub fn extract_full_md_with(bytes: &[u8], max_md: u64) -> Result<String, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| format!("解析结果压缩包无效：{e}"))?;
    for index in 0..archive.len() {
        let entry = archive
            .by_index(index)
            .map_err(|e| format!("解析结果压缩包无效：{e}"))?;
        if entry.is_dir() || !entry.name().is_ok_and(|name| is_full_md(&name)) {
            continue;
        }
        // Never trust the declared size: cap the actual decompressed bytes.
        let mut raw = Vec::new();
        entry
            .take(max_md + 1)
            .read_to_end(&mut raw)
            .map_err(|e| format!("读取 full.md 失败：{e}"))?;
        if raw.len() as u64 > max_md {
            return Err(format!("full.md 解压后超过 {}MB，已拒绝", mb(max_md)));
        }
        let out = String::from_utf8(raw).map_err(|_| "读取 full.md 失败：不是 UTF-8 文本".to_string())?;
        if out.trim().is_empty() {
            return Err("MinerU 解析结果为空".into());
        }
        return Ok(out.trim().to_string());
    }
    Err("压缩包中没有 full.md".into())
}

/// One client per hop, pinned to the address `check_target` approved.
async fn download_client(
    url: &reqwest::Url,
    proxied: bool,
    forbidden: fn(std::net::IpAddr) -> bool,
    resolve: Resolver,
) -> Result<reqwest::Client, String> {
    let target = check_target_with(url, proxied, forbidden, resolve)
        .await
        .ok_or_else(|| "结果下载地址指向内网或本机，已拒绝".to_string())?;
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .use_rustls_tls()
        .redirect(reqwest::redirect::Policy::none());
    if let Resolved::Pinned(addr) = target {
        builder = builder.no_proxy();
        if let Some(domain) = url.host_str().filter(|h| h.parse::<std::net::IpAddr>().is_err() && !h.starts_with('[')) {
            builder = builder.resolve(domain, addr);
        }
    }
    builder.build().map_err(|e| format!("创建网络客户端失败：{e}"))
}

/// 带 Bearer 的 API 调用只跟随同来源重定向（reqwest 默认在同主机 https→http 降级时照发
/// Authorization）；预签名上传也走它，对象存储不跨站跳转。
fn api_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .use_rustls_tls()
        .redirect(crate::io_util::same_origin_redirect_policy())
        .build()
        .map_err(|e| e.to_string())
}

fn extract_batch_url(base: &str, batch_id: &str) -> String {
    format!(
        "{base}{}",
        PATH_EXTRACT_BATCH_FMT.replace("{batch_id}", batch_id)
    )
}

/// 构造 file-urls/batch 请求体（独立出来便于单测）。
pub fn build_submit_body(
    model_version: &str,
    language: &str,
    enable_formula: bool,
    enable_table: bool,
    paper_id: &str,
    file_name: &str,
    page_range: &str,
) -> Value {
    let mut file_entry = json!({
        "name": file_name,
        "is_ocr": true,
        "data_id": paper_id,
    });
    if page_range != "all" {
        file_entry["page_ranges"] = json!(page_range);
    }
    json!({
        "enable_formula": enable_formula,
        "enable_table": enable_table,
        "language": language,
        "model_version": model_version,
        "files": [file_entry],
    })
}

/// extract_result 单项 → ParsePoll；state 映射与 doclib 侧等待判断兼容。
pub fn map_extract_item(item: &Value) -> ParsePoll {
    let state = item["state"].as_str().unwrap_or("pending");
    let progress = item["extract_progress"].as_object().map(|p| {
        let extracted = p.get("extracted_pages").and_then(Value::as_i64).unwrap_or(0);
        let total = p.get("total_pages").and_then(Value::as_i64).unwrap_or(0);
        format!("{extracted}/{total}")
    });
    ParsePoll {
        id: item["data_id"].as_str().unwrap_or("").to_string(),
        status: map_state(state).to_string(),
        error: item["err_msg"].as_str().filter(|m| !m.is_empty()).map(str::to_string),
        progress,
    }
}

pub fn map_state(state: &str) -> &'static str {
    match state {
        "done" => "done",
        "failed" => "failed",
        "running" | "converting" => "parsing",
        _ => "pending", // pending / waiting-file / 未知状态按等待处理
    }
}

/// 官方 API 错误码 → 可读中文。
pub fn api_error_message(code: &str, msg: &str) -> String {
    let detail = msg.trim();
    match code {
        "A0202" => "API Token 无效，请在 mineru.net 检查后重新填写".to_string(),
        "A0211" => "API Token 已过期，请在 mineru.net 重新生成".to_string(),
        "-60005" => "文件超过 200MB 上限".to_string(),
        "-60006" => "文件超过 200 页上限".to_string(),
        "-60018" => "mineru.net 当日 1000 页额度已用尽，可切换其他解析源".to_string(),
        "-60012" => "解析任务不存在".to_string(),
        _ => {
            if detail.is_empty() {
                format!("mineru.net 返回错误（代码 {code}）")
            } else {
                format!("{detail}（代码 {code}）")
            }
        }
    }
}

fn map_http_error(status: reqwest::StatusCode, body: &str) -> String {
    if let Some((code, msg)) = parse_error_pair(body) {
        api_error_message(&code, &msg)
    } else if body.trim().is_empty() {
        format!("mineru.net 请求失败（HTTP {status}）")
    } else {
        format!("mineru.net 请求失败（HTTP {status}）：{}", clip(body))
    }
}

/// 解析 `{code,msg}`（v4 实际返回）、`{code,message}` 或 `{error:{message}}`；
/// code 可能是数字或字符串。取第一个非空的说明，未收录的错误码也能带上服务端原话。
fn parse_error_pair(body: &str) -> Option<(String, String)> {
    let value: Value = serde_json::from_str(body).ok()?;
    let message = [&value["message"], &value["msg"], &value["error"]["message"]]
        .into_iter()
        .filter_map(Value::as_str)
        .find(|text| !text.trim().is_empty())
        .unwrap_or("")
        .to_string();
    let code = match &value["code"] {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => return None,
    };
    Some((code, message))
}

fn clip(value: &str) -> String {
    value.chars().take(280).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn api_error_message_maps_known_codes() {
        assert!(api_error_message("A0202", "").contains("无效"));
        assert!(api_error_message("A0211", "").contains("过期"));
        assert!(api_error_message("-60005", "").contains("200MB"));
        assert!(api_error_message("-60006", "").contains("200 页"));
        assert!(api_error_message("-60018", "").contains("额度"));
        assert!(api_error_message("-60012", "").contains("任务不存在"));
        let other = api_error_message("-99999", "boom");
        assert!(other.contains("boom") && other.contains("-99999"));
    }

    #[test]
    fn extract_batch_url_uses_batch_path() {
        assert_eq!(
            extract_batch_url(API_BASE, "abc123"),
            "https://mineru.net/api/v4/extract-results/batch/abc123"
        );
    }

    #[test]
    fn submit_body_includes_pages_when_ranged() {
        let body = build_submit_body("pipeline", "ch", true, false, "pid-1", "a.pdf", "1-3,5");
        assert_eq!(body["model_version"], "pipeline");
        assert_eq!(body["language"], "ch");
        assert_eq!(body["enable_formula"], true);
        assert_eq!(body["enable_table"], false);
        let file = &body["files"][0];
        assert_eq!(file["name"], "a.pdf");
        assert_eq!(file["is_ocr"], true);
        assert_eq!(file["data_id"], "pid-1");
        assert_eq!(file["page_ranges"], "1-3,5");

        let all = build_submit_body("vlm", "en", true, true, "pid-2", "b.pdf", "all");
        assert!(all["files"][0].get("page_ranges").is_none());
    }

    #[test]
    fn map_state_covers_all_api_states() {
        assert_eq!(map_state("done"), "done");
        assert_eq!(map_state("failed"), "failed");
        assert_eq!(map_state("pending"), "pending");
        assert_eq!(map_state("waiting-file"), "pending");
        assert_eq!(map_state("running"), "parsing");
        assert_eq!(map_state("converting"), "parsing");
        assert_eq!(map_state("whatever"), "pending");
    }

    #[test]
    fn map_extract_item_builds_poll_with_progress() {
        let sample = json!({
            "file_name": "a.pdf",
            "data_id": "pid-1",
            "state": "running",
            "full_zip_url": "",
            "err_msg": null,
            "extract_progress": { "extracted_pages": 3, "total_pages": 10 }
        });
        let poll = map_extract_item(&sample);
        assert_eq!(poll.id, "pid-1");
        assert_eq!(poll.status, "parsing");
        assert_eq!(poll.progress.as_deref(), Some("3/10"));
        assert!(poll.error.is_none());

        let failed = json!({
            "data_id": "pid-2",
            "state": "failed",
            "err_msg": "boom",
            "extract_progress": { "extracted_pages": 0, "total_pages": 0 }
        });
        let poll = map_extract_item(&failed);
        assert_eq!(poll.status, "failed");
        assert_eq!(poll.error.as_deref(), Some("boom"));
    }

    #[test]
    fn parse_error_pair_reads_code_and_message() {
        let pair = parse_error_pair(r#"{"code":-60012,"message":"task not found"}"#).unwrap();
        assert_eq!(pair.0, "-60012");
        assert_eq!(pair.1, "task not found");

        let pair = parse_error_pair(r#"{"code":"A0202","message":"bad token"}"#).unwrap();
        assert_eq!(pair.0, "A0202");

        let pair = parse_error_pair(r#"{"error":{"message":"nope"},"code":-60005}"#).unwrap();
        assert_eq!(pair.0, "-60005");
        assert_eq!(pair.1, "nope");

        assert!(parse_error_pair("not json").is_none());
        assert!(parse_error_pair(r#"{"data":{}}"#).is_none());
    }

    #[test]
    fn parse_error_pair_reads_v4_msg_field() {
        let body = r#"{"code":-60099,"msg":"文件格式不支持","trace_id":"t1","data":null}"#;
        let pair = parse_error_pair(body).unwrap();
        assert_eq!(pair, ("-60099".to_string(), "文件格式不支持".to_string()));
        // 未收录的错误码保留服务端说明
        assert_eq!(api_error_message(&pair.0, &pair.1), "文件格式不支持（代码 -60099）");
        let status = reqwest::StatusCode::BAD_REQUEST;
        assert_eq!(map_http_error(status, body), "文件格式不支持（代码 -60099）");
        // 空 message 不遮住 msg
        let pair = parse_error_pair(r#"{"code":"A0202","message":"","msg":"token invalid"}"#).unwrap();
        assert_eq!(pair.1, "token invalid");
        // 成功体 {code:0,msg:"ok"} 照常解析，调用方按 code 判断
        assert_eq!(parse_error_pair(r#"{"code":0,"msg":"ok","data":{}}"#).unwrap().0, "0");
    }

    #[test]
    fn extract_full_md_finds_markdown_in_zip() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("layout.json", options).unwrap();
        writer.write_all(b"{}").unwrap();
        writer.start_file("full.md", options).unwrap();
        writer.write_all("# 论文标题\n\n正文".as_bytes()).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let markdown = extract_full_md(&bytes).unwrap();
        assert_eq!(markdown, "# 论文标题\n\n正文");
    }

    #[test]
    fn extract_full_md_errors_when_missing_or_empty() {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        writer.start_file("layout.json", options).unwrap();
        writer.write_all(b"{}").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert_eq!(extract_full_md(&bytes).unwrap_err(), "压缩包中没有 full.md");

        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer.start_file("full.md", options).unwrap();
        writer.write_all(b"   ").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        assert_eq!(extract_full_md(&bytes).unwrap_err(), "MinerU 解析结果为空");
    }

    fn zip_of(entries: &[(&str, &[u8])], method: zip::CompressionMethod) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default().compression_method(method);
        for (name, data) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(data).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn full_md_name_is_matched_exactly() {
        let st = zip::CompressionMethod::Stored;
        let bytes = zip_of(&[("xfull.md", b"wrong"), ("a/notfull.md", b"wrong")], st);
        assert_eq!(extract_full_md(&bytes).unwrap_err(), "压缩包中没有 full.md");
        let bytes = zip_of(&[("xfull.md", b"wrong"), ("paper/full.md", b"right")], st);
        assert_eq!(extract_full_md(&bytes).unwrap(), "right");
        assert!(is_full_md("full.md") && is_full_md("a/full.md"));
        assert!(!is_full_md("xfull.md") && !is_full_md("full.md.bak") && !is_full_md("a/xfull.md"));
    }

    #[test]
    fn zip_bomb_full_md_is_rejected() {
        // 2 MB of zeros deflates to a few KB; cap at 1 MB.
        let bomb = vec![b'0'; 2 * 1024 * 1024];
        let bytes = zip_of(&[("full.md", &bomb)], zip::CompressionMethod::Deflated);
        assert!(bytes.len() < 64 * 1024, "fixture should be highly compressed");
        let err = extract_full_md_with(&bytes, 1024 * 1024).unwrap_err();
        assert_eq!(err, "full.md 解压后超过 1MB，已拒绝");
        // Exactly at the limit is fine.
        let ok = zip_of(&[("full.md", &vec![b'a'; 1024 * 1024][..])], zip::CompressionMethod::Deflated);
        assert_eq!(extract_full_md_with(&ok, 1024 * 1024).unwrap().len(), 1024 * 1024);
    }

    #[test]
    fn result_url_must_be_public_https() {
        assert!(check_result_url("https://cdn-mineru.example.com/r/a.zip").is_ok());
        assert_eq!(check_result_url("http://cdn.example.com/a.zip").unwrap_err(), "结果下载地址必须是 https");
        assert!(check_result_url("file:///etc/passwd").is_err());
        assert!(check_result_url("not a url").is_err());
        for bad in [
            "https://127.0.0.1/a.zip",
            "https://10.0.0.5/a.zip",
            "https://192.168.1.1/a.zip",
            "https://169.254.169.254/latest/meta-data",
            "https://[::1]/a.zip",
            "https://[::ffff:10.0.0.1]/a.zip",
            "https://localhost/a.zip",
            "https://foo.localhost/a.zip",
        ] {
            assert_eq!(check_result_url(bad).unwrap_err(), "结果下载地址指向内网或本机，已拒绝", "{bad}");
        }
        assert!(check_result_url("https://8.8.8.8/a.zip").is_ok());
    }

    #[test]
    fn download_rejects_internal_url_before_any_request() {
        let err = tauri::async_runtime::block_on(download_and_extract_markdown("https://127.0.0.1:1/a.zip"));
        assert_eq!(err.unwrap_err(), "结果下载地址指向内网或本机，已拒绝");
    }

    /// One-shot HTTP server; `declare_len` false sends no Content-Length (chunked-less close).
    fn serve_once(body: Vec<u8>, declare_len: bool) -> String {
        use std::io::Read as _;
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = l.accept() {
                let mut buf = [0u8; 2048];
                let _ = c.read(&mut buf);
                let head = if declare_len {
                    format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len())
                } else {
                    "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_string()
                };
                let _ = c.write_all(head.as_bytes());
                let _ = c.write_all(&body);
            }
        });
        format!("http://{addr}/r.zip")
    }

    fn get(url: &str, limits: ResultLimits) -> Result<String, String> {
        let url = reqwest::Url::parse(url).unwrap();
        // Test servers live on loopback, so nothing is forbidden here.
        tauri::async_runtime::block_on(download_pinned(url, limits, false, |_| false, system_resolve))
    }

    /// Listener that reports whether anyone connected.
    fn tripwire(ip: &str) -> (u16, std::sync::Arc<std::sync::atomic::AtomicBool>) {
        let l = std::net::TcpListener::bind((ip, 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        let hit = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = hit.clone();
        std::thread::spawn(move || {
            if l.accept().is_ok() {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });
        (port, hit)
    }

    #[test]
    fn name_resolving_to_internal_address_is_refused_before_connecting() {
        let (port, hit) = tripwire("127.0.0.1");
        let url = reqwest::Url::parse(&format!("http://localhost:{port}/r.zip")).unwrap();
        let err = tauri::async_runtime::block_on(download_pinned(
            url,
            ResultLimits::default(),
            false,
            crate::lookup::is_forbidden,
            system_resolve,
        ))
        .unwrap_err();
        assert_eq!(err, "结果下载地址指向内网或本机，已拒绝");
        std::thread::sleep(Duration::from_millis(100));
        assert!(!hit.load(std::sync::atomic::Ordering::SeqCst), "must not connect");
    }

    /// Injected DNS: `evil.test` points inside, `fake.test` at a fake-ip answer.
    fn fake_dns(host: String, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
        match host.as_str() {
            "evil.test" => Ok(vec![(std::net::Ipv4Addr::new(127, 0, 0, 1), port).into()]),
            "fake.test" => Ok(vec![(std::net::Ipv4Addr::new(198, 18, 0, 7), port).into()]),
            "mixed.test" => Ok(vec![
                (std::net::Ipv4Addr::new(8, 8, 8, 8), port).into(),
                (std::net::Ipv4Addr::new(10, 0, 0, 5), port).into(),
            ]),
            _ => Err(std::io::ErrorKind::NotFound.into()),
        }
    }

    #[test]
    fn redirect_hop_to_name_resolving_internal_is_refused() {
        // The first hop is the loopback test server; only the redirect target
        // goes through the real rule.
        fn forbid_named(ip: std::net::IpAddr) -> bool {
            ip != std::net::IpAddr::from([127, 0, 0, 1]) && download_forbidden(ip)
        }
        let url = serve_raw(b"HTTP/1.1 302 Found\r\nLocation: https://evil.test/x.zip\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
        let url = reqwest::Url::parse(&url).unwrap();
        fn evil_inside(host: String, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
            match host.as_str() {
                "evil.test" => Ok(vec![(std::net::Ipv4Addr::new(10, 0, 0, 5), port).into()]),
                _ => fake_dns(host, port),
            }
        }
        let err = tauri::async_runtime::block_on(download_pinned(url, ResultLimits::default(), false, forbid_named, evil_inside))
            .unwrap_err();
        assert_eq!(err, "结果下载地址指向内网或本机，已拒绝");
    }

    #[test]
    fn name_resolving_to_loopback_is_refused_with_injected_dns() {
        let url = reqwest::Url::parse("https://evil.test/r.zip").unwrap();
        let t = tauri::async_runtime::block_on(check_target_with(&url, false, download_forbidden, fake_dns));
        assert!(t.is_none());
    }

    #[test]
    fn name_with_one_internal_address_among_public_is_refused() {
        let url = reqwest::Url::parse("https://mixed.test/r.zip").unwrap();
        let t = tauri::async_runtime::block_on(check_target_with(&url, false, download_forbidden, fake_dns));
        assert!(t.is_none(), "any internal address must refuse the whole name");
    }

    #[test]
    fn fake_ip_answer_is_allowed_and_pinned() {
        let url = reqwest::Url::parse("https://fake.test/r.zip").unwrap();
        let t = tauri::async_runtime::block_on(check_target_with(&url, false, download_forbidden, fake_dns));
        assert!(matches!(t, Some(Resolved::Pinned(a)) if a == (std::net::Ipv4Addr::new(198, 18, 0, 7), 443).into()));
    }

    #[test]
    fn download_forbidden_only_relaxes_benchmark_range() {
        for ok in ["198.18.0.1", "198.19.255.254", "::ffff:198.18.0.1", "8.8.8.8"] {
            assert!(!download_forbidden(ok.parse().unwrap()), "{ok}");
        }
        for bad in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "::1", "169.254.169.254"] {
            assert!(download_forbidden(bad.parse().unwrap()), "{bad}");
        }
        for edge in ["198.17.255.255", "198.20.0.0"] {
            let ip = edge.parse().unwrap();
            assert_eq!(download_forbidden(ip), crate::lookup::is_forbidden(ip), "{edge}: outside the range, unchanged");
        }
        assert!(crate::lookup::is_forbidden("198.18.0.1".parse().unwrap()), "lookup keeps blocking it");
    }

    #[test]
    fn trailing_dot_localhost_is_refused() {
        assert!(check_result_url("https://localhost./r.zip").is_err());
        assert!(check_result_url("https://a.localhost./r.zip").is_err());
    }

    #[test]
    fn oversized_download_is_rejected_by_header_and_by_stream() {
        let body = zip_of(&[("full.md", &vec![b'x'; 8 * 1024][..])], zip::CompressionMethod::Stored);
        let small = ResultLimits { zip_bytes: 1024, md_bytes: MAX_MD_BYTES };
        let msg = "解析结果压缩包超过 1MB，已停止下载";
        assert_eq!(get(&serve_once(body.clone(), true), small).unwrap_err(), msg);
        assert_eq!(get(&serve_once(body.clone(), false), small).unwrap_err(), msg);
        let ok = get(&serve_once(body, false), ResultLimits::default()).unwrap();
        assert_eq!(ok.len(), 8 * 1024);
    }

    /// Raw one-shot HTTP response (head + optional body), then close.
    fn serve_raw(raw: Vec<u8>) -> String {
        use std::io::Read as _;
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = l.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut c, _)) = l.accept() {
                let mut buf = [0u8; 2048];
                let _ = c.read(&mut buf);
                let _ = c.write_all(&raw);
            }
        });
        format!("http://{addr}/r.zip")
    }

    #[test]
    fn declared_oversize_is_rejected_before_reading_body() {
        // Header claims 10 KB, no body follows: only the Content-Length check can
        // produce the size error; the stream check would see a truncated body instead.
        let url = serve_raw(b"HTTP/1.1 200 OK\r\nContent-Length: 10240\r\nConnection: close\r\n\r\n".to_vec());
        let small = ResultLimits { zip_bytes: 1024, md_bytes: MAX_MD_BYTES };
        assert_eq!(get(&url, small).unwrap_err(), "解析结果压缩包超过 1MB，已停止下载");
    }

    #[test]
    fn redirect_to_disallowed_url_is_refused() {
        let url = serve_raw(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/x.zip\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
        let err = get(&url, ResultLimits::default()).unwrap_err();
        assert!(err.contains("下载解析结果失败"), "{err}");
        assert!(err.contains("结果下载地址重定向到了不允许的地址"), "{err}");
    }

    #[test]
    fn error_messages_drop_signed_query() {
        let redirect = serve_raw(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/x.zip?sig=LEAK2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
        let err = get(&format!("{redirect}?Signature=LEAK1#frag"), ResultLimits::default()).unwrap_err();
        assert!(err.contains("结果下载地址重定向到了不允许的地址"), "{err}");
        assert!(!err.contains("LEAK") && !err.contains("frag"), "{err}");

        // Body cut short: the error comes from the streaming read instead.
        let short = serve_raw(b"HTTP/1.1 200 OK\r\nContent-Length: 10240\r\nConnection: close\r\n\r\nabc".to_vec());
        let err = get(&format!("{short}?Signature=LEAK3"), ResultLimits::default()).unwrap_err();
        assert!(err.starts_with("下载解析结果失败"), "{err}");
        assert!(!err.contains("LEAK"), "{err}");
    }

    #[test]
    fn upload_error_text_drops_presigned_url() {
        // 预签名上传失败（端口 1 无人监听）：错误文本里不得出现签名、userinfo 或地址。
        let err = tauri::async_runtime::block_on(async {
            api_client().unwrap().put("http://u:pw-LEAK0@127.0.0.1:1/up.pdf?Signature=LEAK1").body("x").send().await.unwrap_err()
        });
        let shown = format!("上传 PDF 到 mineru.net 失败：{}", reqwest_error_text(err));
        assert!(!shown.contains("LEAK") && !shown.contains("127.0.0.1"), "{shown}");
        let err = tauri::async_runtime::block_on(async {
            reqwest::Client::new().get("http://u:pw-LEAK0@127.0.0.1:1/r.zip?Signature=LEAK1").send().await.unwrap_err()
        });
        let shown = redact_url(err).to_string();
        assert!(!shown.contains("LEAK") && shown.contains("127.0.0.1:1/r.zip"), "{shown}");
    }
}

#[cfg(test)]
mod client_contract_tests {
    use super::*;
    use crate::test_util::http::{bounded, Response, Server};
    use std::io::Write;

    fn client(base: &str) -> ApiClient {
        let mut client = ApiClient::new(&ApiCfg {
            token: " fixture-token ".into(), model_version: "pipeline".into(),
            language: "en".into(), enable_formula: true, enable_table: false,
        });
        client.base_url = base.into();
        client
    }

    struct PdfFixture(std::path::PathBuf);
    impl PdfFixture {
        fn new() -> Self { Self(crate::test_util::unique_temp_dir("mineru-contract")) }
        fn path(&self) -> std::path::PathBuf { self.0.join("paper.pdf") }
    }
    impl Drop for PdfFixture {
        fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
    }

    #[tokio::test]
    async fn upload_and_poll_use_production_client_contract() {
        bounded(async {
            let server = Server::start(|base| vec![
                Response::json(200, json!({"code":0,"data":{"batch_id":"batch-1","file_urls":[format!("{base}/signed-upload?signature=fixture")]}})),
                Response::json(200, json!({})),
                Response::json(200, json!({"code":0,"data":{"extract_result":[
                    {"data_id":"paper-1","state":"running","extract_progress":{"extracted_pages":2,"total_pages":4}},
                    {"data_id":"other","state":"done"}
                ]}})),
                Response::json(200, json!({"code":0,"data":{"extract_result":[{"data_id":"paper-1","state":"done"}]}})),
            ]).await;
            let pdf = PdfFixture::new();
            let bytes = b"%PDF-1.4\nfixture\x00\xff";
            fs::write(pdf.path(), bytes).unwrap();
            let api = client(&server.base);
            let batch = api.submit("paper-1", &pdf.path(), "1-4").await.unwrap();
            assert_eq!(batch, "batch-1");
            let polls = api.statuses(&batch, &["paper-1".into()]).await.unwrap();
            assert_eq!(polls.len(), 1);
            assert_eq!(polls[0].id, "paper-1");
            assert_eq!(polls[0].status, "parsing");
            assert_eq!(polls[0].progress.as_deref(), Some("2/4"));
            assert_eq!(api.statuses(&batch, &[]).await.unwrap()[0].status, "done");
            let requests = server.finish().await;
            assert_eq!(requests[0].method, "POST");
            assert_eq!(requests[0].path, PATH_FILE_URLS);
            assert_eq!(requests[0].header("authorization"), Some("Bearer fixture-token"));
            assert_eq!(requests[0].header("content-type"), Some("application/json"));
            assert_eq!(requests[0].json(), json!({"model_version":"pipeline","language":"en","enable_formula":true,"enable_table":false,
                "files":[{"name":"paper.pdf","is_ocr":true,"data_id":"paper-1","page_ranges":"1-4"}]}));
            assert_eq!(requests[1].method, "PUT");
            assert_eq!(requests[1].path, "/signed-upload?signature=fixture");
            assert_eq!(requests[1].body, bytes);
            assert_eq!(requests[1].header("authorization"), None, "API token must not leak to storage");
            assert_eq!(requests[1].header("content-type"), None, "signed PUT is raw bytes");
            for poll in &requests[2..] {
                assert_eq!(poll.method, "GET");
                assert_eq!(poll.path, "/api/v4/extract-results/batch/batch-1");
                assert_eq!(poll.header("authorization"), Some("Bearer fixture-token"));
            }
        }).await;
    }

    #[tokio::test]
    async fn health_and_poll_propagate_api_failures() {
        bounded(async {
            let server = Server::start(|_| vec![
                Response::json(200, json!({"code":-60012,"msg":"not found"})),
                Response::json(401, json!({"code":"A0202","msg":"invalid token"})),
                Response::json(200, json!({"code":-60018,"msg":"quota exhausted"})),
                Response { status: 200, headers: vec![], body: b"not-json".to_vec() },
            ]).await;
            let api = client(&server.base);
            assert!(api.health().await.unwrap().contains("Token 有效"));
            assert!(api.statuses("b", &[]).await.unwrap_err().contains("无效"));
            assert!(api.statuses("b", &[]).await.unwrap_err().contains("额度"));
            assert!(api.statuses("b", &[]).await.unwrap_err().contains("无法解析"));
            let requests = server.finish().await;
            assert_eq!(requests[0].path, format!("/api/v4/extract-results/batch/{PROBE_BATCH_ID}"));
            assert!(requests.iter().all(|r| r.header("authorization") == Some("Bearer fixture-token")));
        }).await;
    }

    #[tokio::test]
    async fn upload_failure_is_not_reported_as_a_submitted_batch() {
        bounded(async {
            let server = Server::start(|base| vec![
                Response::json(200, json!({"code":0,"data":{"batch_id":"b","file_urls":[format!("{base}/upload")]}})),
                Response::json(403, json!({"error":"expired signature"})),
            ]).await;
            let pdf = PdfFixture::new();
            fs::write(pdf.path(), b"%PDF-fixture").unwrap();
            let error = client(&server.base).submit("p", &pdf.path(), "all").await.unwrap_err();
            assert!(error.contains("上传 PDF 失败") && error.contains("403"), "{error}");
            let requests = server.finish().await;
            assert!(requests[0].json()["files"][0].get("page_ranges").is_none());
        }).await;
    }

    #[tokio::test]
    async fn markdown_keeps_result_url_guard_and_reports_incomplete_results() {
        bounded(async {
            let server = Server::start(|base| vec![
                Response::json(200, json!({"code":0,"data":{"extract_result":[{"state":"running"}]}})),
                Response::json(200, json!({"code":0,"data":{"extract_result":[{"state":"failed","err_msg":"fixture parse error"}]}})),
                Response::json(200, json!({"code":0,"data":{"extract_result":[{"state":"done","full_zip_url":format!("{base}/must-not-download")}]}})),
            ]).await;
            let api = client(&server.base);
            assert!(api.markdown("b").await.unwrap_err().contains("尚未完成"));
            assert!(api.markdown("b").await.unwrap_err().contains("fixture parse error"));
            assert_eq!(api.markdown("b").await.unwrap_err(), "结果下载地址必须是 https");
            assert_eq!(server.finish().await.len(), 3);
        }).await;
    }

    #[tokio::test]
    async fn production_downloader_reads_zip_without_api_authorization() {
        bounded(async {
            let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
            zip.start_file("paper/full.md", zip::write::SimpleFileOptions::default()).unwrap();
            zip.write_all("# 论文\n\nFixture result".as_bytes()).unwrap();
            let body = zip.finish().unwrap().into_inner();
            let server = Server::start(|_| vec![Response { status: 200, headers: vec![], body }]).await;
            // Only the first URL/DNS guard is injected for loopback. The actual download,
            // redirect validation, response limits and ZIP extraction stay production code.
            let url = reqwest::Url::parse(&format!("{}/result.zip?signature=fixture", server.base)).unwrap();
            let markdown = download_pinned(url, ResultLimits::default(), false, |_| false, system_resolve).await.unwrap();
            assert_eq!(markdown, "# 论文\n\nFixture result");
            let requests = server.finish().await;
            assert_eq!(requests[0].method, "GET");
            assert_eq!(requests[0].path, "/result.zip?signature=fixture");
            assert_eq!(requests[0].header("authorization"), None);
        }).await;
    }
}
