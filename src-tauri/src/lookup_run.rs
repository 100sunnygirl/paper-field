//! Lookup order is the same with or without email and API keys.
//! Configuration only changes User-Agent, mailto, auth headers, and client-side gaps.
#![deny(clippy::string_slice)]

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::lookup::{
    is_arxiv_error_feed, normalize_author_token, normalize_title, parse_arxiv_atom, parse_crossref,
    parse_crossref_query, parse_openalex, parse_openalex_single, parse_s2_match, parse_s2_paper,
    urlencoding_min, ArxivId, Doi, LookupHit, TitleQuery,
};

pub const ARXIV_GAP: Duration = Duration::from_secs(3);
pub const S2_CONFIGURED_GAP: Duration = Duration::from_secs(1);
const BACKOFF: Duration = Duration::from_secs(1);
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const S2_FIELDS: &str =
    "title,year,abstract,venue,externalIds,authors,authors.affiliations,openAccessPdf";

#[derive(Clone, Debug, Default)]
pub struct BiblioAuth {
    pub email: Option<String>,
    pub openalex_key: Option<String>,
    pub s2_key: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupNotice {
    pub source: String,
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupOutcome {
    pub hit: Option<LookupHit>,
    pub notices: Vec<LookupNotice>,
    pub openalex_remaining_usd: Option<f64>,
    pub openalex_limit_usd: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct HttpRequest {
    pub source: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct HttpResponse {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

pub trait Fetcher {
    fn get(
        &self,
        request: &HttpRequest,
    ) -> impl std::future::Future<Output = Result<HttpResponse, String>> + Send;
}

pub trait Sleeper {
    fn sleep(&mut self, duration: Duration) -> impl std::future::Future<Output = ()> + Send;
}

struct RealSleep;
impl Sleeper for RealSleep {
    async fn sleep(&mut self, duration: Duration) {
        if !duration.is_zero() {
            tokio::time::sleep(duration).await;
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct OpenAlexBudget {
    pub remaining_usd: Option<f64>,
    pub limit_usd: Option<f64>,
}

/// 运行期的 OpenAlex 额度。只认 OpenAlex 自己的响应头；耗尽时锁到下一个 UTC 零点或一小时后
/// （取较早者），不再一直锁到重启。
#[derive(Clone, Debug, Default)]
pub struct BudgetTracker {
    pub remaining_usd: Option<f64>,
    pub limit_usd: Option<f64>,
    blocked_until: Option<Instant>,
}

impl BudgetTracker {
    pub fn search_blocked(&mut self, now: Instant) -> bool {
        self.expire(now);
        self.remaining_usd.is_some_and(|value| value < 0.001)
    }

    fn expire(&mut self, now: Instant) {
        if self.blocked_until.is_some_and(|until| now >= until) {
            self.remaining_usd = None;
            self.blocked_until = None;
        }
    }

    fn mark_remaining(&mut self, value: f64, now: Instant, wall: SystemTime) {
        self.remaining_usd = Some(value);
        if value >= 0.001 {
            self.blocked_until = None;
        } else if self.blocked_until.is_none() {
            // 锁住期间 DOI 单条请求还会带回 0，不顺延
            self.blocked_until = Some(now + latch_window(wall));
        }
    }

    /// 保存文献库设置后调用：换了 Key 就该重新试，不沿用旧的「已用完」。
    pub fn reset(&mut self) {
        self.remaining_usd = None;
        self.blocked_until = None;
    }

    pub fn snapshot(&self) -> OpenAlexBudget {
        OpenAlexBudget {
            remaining_usd: self.remaining_usd,
            limit_usd: self.limit_usd,
        }
    }
}

/// 到下一个 UTC 零点的时长，最多一小时。
pub fn latch_window(wall: SystemTime) -> Duration {
    let secs = wall
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_secs())
        .unwrap_or(0);
    let to_midnight = 86_400 - secs % 86_400;
    Duration::from_secs(to_midnight).min(Duration::from_secs(60 * 60))
}

#[derive(Default)]
pub struct Limiter {
    last: HashMap<String, Instant>,
    gap_override: HashMap<String, Duration>,
}

impl Limiter {
    pub fn reserve(&mut self, bucket: &str, now: Instant, min: Duration) -> Duration {
        let min = self.gap_override.get(bucket).copied().unwrap_or(min);
        let wait = self
            .last
            .get(bucket)
            .map(|last| min.saturating_sub(now.saturating_duration_since(*last)))
            .unwrap_or(Duration::ZERO);
        self.last.insert(bucket.to_string(), now + wait);
        wait
    }

    pub fn set_gap(&mut self, bucket: &str, gap: Duration) {
        self.gap_override.insert(bucket.to_string(), gap);
    }
}

pub struct LookupCache {
    entries: HashMap<String, (Instant, LookupHit)>,
    ttl: Duration,
}

impl LookupCache {
    pub fn new(ttl: Duration) -> Self {
        Self {
            entries: HashMap::new(),
            ttl,
        }
    }

    pub fn get(&self, key: &str, now: Instant) -> Option<LookupHit> {
        let (stored, hit) = self.entries.get(key)?;
        if now.saturating_duration_since(*stored) > self.ttl {
            return None;
        }
        Some(hit.clone())
    }

    pub fn put(&mut self, key: String, now: Instant, hit: LookupHit) {
        self.entries.insert(key, (now, hit));
    }
}

pub fn user_agent(include_mailto: bool, email: Option<&str>) -> String {
    let version = env!("CARGO_PKG_VERSION");
    let base = format!("PaperField/{version} (https://github.com/100sunnygirl/paper-field");
    if include_mailto {
        if let Some(email) = usable_email(email) {
            return format!("{base}; mailto:{email})");
        }
    }
    format!("{base})")
}

pub fn usable_email(email: Option<&str>) -> Option<&str> {
    email
        .map(str::trim)
        .filter(|value| value.contains('@') && !value.contains(char::is_whitespace))
}

pub fn redact_url(url: &str) -> String {
    let Some((path, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| {
            !pair
                .split('=')
                .next()
                .unwrap_or("")
                .eq_ignore_ascii_case("api_key")
        })
        .collect();
    if kept.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{}", kept.join("&"))
    }
}

pub fn describe_request(request: &HttpRequest) -> String {
    let mut line = redact_url(&request.url);
    for (key, value) in &request.headers {
        if key.eq_ignore_ascii_case("authorization") || key.eq_ignore_ascii_case("x-api-key") {
            line.push_str(&format!(" {key}=<redacted>"));
            let _ = value;
        } else {
            line.push_str(&format!(" {key}={value}"));
        }
    }
    line
}

pub fn crossref_gap(polite: bool, query: bool) -> Duration {
    match (polite, query) {
        (false, false) => Duration::from_millis(200),
        (false, true) => Duration::from_secs(1),
        (true, false) => Duration::from_millis(100),
        (true, true) => Duration::from_millis(334),
    }
}

pub fn gap_from_per_second(limit: f64) -> Option<Duration> {
    if !limit.is_finite() || limit <= 0.0 {
        return None;
    }
    Some(Duration::from_secs_f64(1.0 / limit))
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.as_str())
}

fn cache_key(
    arxiv_id: Option<&str>,
    doi: Option<&str>,
    title: Option<&str>,
    year: Option<i32>,
    authors: &[String],
) -> Option<String> {
    let doi = doi.and_then(Doi::parse);
    let from_doi = doi.as_ref().and_then(ArxivId::from_doi);
    if let Some(id) = arxiv_id.and_then(ArxivId::parse).or(from_doi) {
        return Some(format!("arxiv:{}", id.as_str().to_ascii_lowercase()));
    }
    if let Some(doi) = doi {
        return Some(format!("doi:{}", doi.as_str().to_ascii_lowercase()));
    }
    let title = title.map(str::trim).filter(|value| !value.is_empty())?;
    let year = year.map(|value| value.to_string()).unwrap_or_default();
    let authors = authors
        .iter()
        .map(|name| normalize_author_token(name))
        .collect::<Vec<_>>()
        .join("\u{1f}");
    Some(format!(
        "title:{}|y:{year}|a:{authors}",
        normalize_title(title)
    ))
}

/// 命中里的 id 必须和请求的一致；ArxivId / Doi 的相等忽略大小写。
pub fn accepts_ids(hit: &LookupHit, arxiv_id: Option<&str>, doi: Option<&str>) -> bool {
    if let Some(want) = arxiv_id.and_then(ArxivId::parse) {
        if hit.arxiv_id.as_deref().and_then(ArxivId::parse) != Some(want) {
            return false;
        }
    }
    if let Some(want) = doi.and_then(Doi::parse) {
        if hit.doi.as_deref().and_then(Doi::parse) != Some(want) {
            return false;
        }
    }
    true
}

fn s2_query(title: &str) -> String {
    title.replace('-', " ")
}

pub fn arxiv_request(id: &str) -> HttpRequest {
    HttpRequest {
        source: "arxiv",
        url: format!(
            "https://export.arxiv.org/api/query?id_list={}",
            urlencoding_min(id)
        ),
        headers: vec![("user-agent".into(), user_agent(false, None))],
    }
}

pub fn crossref_work_request(doi: &str, email: Option<&str>) -> HttpRequest {
    let mut url = format!("https://api.crossref.org/works/{}", urlencoding_min(doi));
    if let Some(email) = usable_email(email) {
        url.push_str("?mailto=");
        url.push_str(&urlencoding_min(email));
    }
    HttpRequest {
        source: "crossref",
        url,
        headers: vec![("user-agent".into(), user_agent(true, email))],
    }
}

pub fn crossref_query_request(title: &str, email: Option<&str>) -> HttpRequest {
    let mut url = format!(
        "https://api.crossref.org/works?query.bibliographic={}&rows=5",
        urlencoding_min(title)
    );
    if let Some(email) = usable_email(email) {
        url.push_str("&mailto=");
        url.push_str(&urlencoding_min(email));
    }
    HttpRequest {
        source: "crossref",
        url,
        headers: vec![("user-agent".into(), user_agent(true, email))],
    }
}

pub fn openalex_doi_request(doi: &str, key: Option<&str>) -> HttpRequest {
    HttpRequest {
        source: "openalex",
        url: format!(
            "https://api.openalex.org/works/doi:{}",
            urlencoding_min(doi)
        ),
        headers: openalex_headers(key),
    }
}

pub fn openalex_search_request(title: &str, key: Option<&str>) -> HttpRequest {
    HttpRequest {
        source: "openalex",
        url: format!(
            "https://api.openalex.org/works?search={}&per-page=5",
            urlencoding_min(title)
        ),
        headers: openalex_headers(key),
    }
}

fn openalex_headers(key: Option<&str>) -> Vec<(String, String)> {
    let mut headers = vec![("user-agent".into(), user_agent(false, None))];
    if let Some(key) = key.map(str::trim).filter(|value| !value.is_empty()) {
        headers.push(("authorization".into(), format!("Bearer {key}")));
    }
    headers
}

pub fn s2_arxiv_request(id: &str, key: Option<&str>) -> HttpRequest {
    HttpRequest {
        source: "semanticscholar",
        url: format!(
            "https://api.semanticscholar.org/graph/v1/paper/ARXIV:{}?fields={S2_FIELDS}",
            urlencoding_min(id)
        ),
        headers: s2_headers(key),
    }
}

pub fn s2_match_request(title: &str, key: Option<&str>) -> HttpRequest {
    HttpRequest {
        source: "semanticscholar",
        url: format!(
            "https://api.semanticscholar.org/graph/v1/paper/search/match?query={}&fields={S2_FIELDS}",
            urlencoding_min(&s2_query(title))
        ),
        headers: s2_headers(key),
    }
}

fn s2_headers(key: Option<&str>) -> Vec<(String, String)> {
    let mut headers = vec![("user-agent".into(), user_agent(false, None))];
    if let Some(key) = key.map(str::trim).filter(|value| !value.is_empty()) {
        headers.push(("x-api-key".into(), key.to_string()));
    }
    headers
}

fn note(notices: &mut Vec<LookupNotice>, source: &str, code: &str, message: &str) {
    if notices
        .iter()
        .any(|item| item.source == source && item.code == code)
    {
        return;
    }
    notices.push(LookupNotice {
        source: source.into(),
        code: code.into(),
        message: message.into(),
    });
}

/// 只在 OpenAlex 的响应上调用：别家的 `x-ratelimit-remaining: 0` 与 OpenAlex 额度无关。
fn absorb_budget(
    budget: &mut BudgetTracker,
    headers: &[(String, String)],
    now: Instant,
    wall: SystemTime,
) {
    if let Some(value) = header(headers, "x-ratelimit-remaining-usd")
        .and_then(|text| text.trim().parse::<f64>().ok())
    {
        budget.mark_remaining(value, now, wall);
    } else if header(headers, "x-ratelimit-remaining").is_some_and(|text| text.trim() == "0") {
        budget.mark_remaining(0.0, now, wall);
    }
    if let Some(value) =
        header(headers, "x-ratelimit-limit-usd").and_then(|text| text.trim().parse::<f64>().ok())
    {
        budget.limit_usd = Some(value);
    }
}

fn absorb_crossref_limit(limiter: &mut Limiter, bucket: &str, headers: &[(String, String)]) {
    let Some(limit) =
        header(headers, "x-rate-limit-limit").and_then(|text| text.parse::<f64>().ok())
    else {
        return;
    };
    if let Some(gap) = gap_from_per_second(limit) {
        limiter.set_gap(bucket, gap);
    }
}

struct LiveFetch;

impl Fetcher for LiveFetch {
    async fn get(&self, request: &HttpRequest) -> Result<HttpResponse, String> {
        // 只跟随同来源重定向：默认策略会把 S2 的 x-api-key 带去任意主机，
        // 同主机降级到 http 时连 OpenAlex 的 Bearer 也照发。这几个 API 本身不跨站跳转。
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(12))
            .redirect(crate::io_util::same_origin_redirect_policy())
            .build()
            .map_err(|_| format!("{} 无法发起请求", describe_request(request)))?;
        let mut builder = client.get(&request.url);
        for (key, value) in &request.headers {
            builder = builder.header(key.as_str(), value.as_str());
        }
        let response = builder
            .send()
            .await
            .map_err(|_| format!("{} 不可达", describe_request(request)))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(key, value)| {
                (
                    key.as_str().to_string(),
                    value.to_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        let body = crate::io_util::read_text_capped(response, crate::io_util::LOOKUP_BODY_LIMIT)
            .await
            .map_err(|_| format!("{} 响应无法读取", describe_request(request)))?;
        Ok(HttpResponse {
            status,
            body,
            headers,
        })
    }
}

/// 记下本次查询有没有来源暂时失败（429/403/5xx/断网/超时）；有就不写缓存，下次重新查。
struct Watch<'a, F> {
    inner: &'a F,
    transient: AtomicBool,
}

impl<F: Fetcher + Sync> Fetcher for Watch<'_, F> {
    async fn get(&self, request: &HttpRequest) -> Result<HttpResponse, String> {
        let result = self.inner.get(request).await;
        if result
            .as_ref()
            .map_or(true, |response| transient_status(response.status))
        {
            self.transient.store(true, Ordering::Relaxed);
        }
        result
    }
}

fn transient_status(status: u16) -> bool {
    matches!(status, 403 | 408 | 429) || status >= 500
}

struct Gate {
    limiter: Limiter,
    cache: LookupCache,
    budget: BudgetTracker,
}

fn gate() -> &'static tokio::sync::Mutex<Gate> {
    static GATE: OnceLock<tokio::sync::Mutex<Gate>> = OnceLock::new();
    GATE.get_or_init(|| {
        tokio::sync::Mutex::new(Gate {
            limiter: Limiter::default(),
            cache: LookupCache::new(CACHE_TTL),
            budget: BudgetTracker::default(),
        })
    })
}

static BUDGET: Mutex<BudgetTracker> = Mutex::new(BudgetTracker {
    remaining_usd: None,
    limit_usd: None,
    blocked_until: None,
});

/// 设置保存是同步命令，拿不到 gate 的异步锁：先记一笔，下次查询开始或结束时清掉。
static BUDGET_RESET: AtomicBool = AtomicBool::new(false);

pub fn budget_snapshot() -> OpenAlexBudget {
    let mut budget = BUDGET.lock().unwrap_or_else(|err| err.into_inner());
    budget.expire(Instant::now());
    budget.snapshot()
}

/// 清掉 OpenAlex「额度已用完」的锁。保存文献库设置时调用。
pub fn reset_openalex_latch() {
    BUDGET_RESET.store(true, Ordering::SeqCst);
    BUDGET.lock().unwrap_or_else(|err| err.into_inner()).reset();
}

fn take_budget_reset(budget: &mut BudgetTracker) {
    if BUDGET_RESET.swap(false, Ordering::SeqCst) {
        budget.reset();
    }
}

pub async fn lookup_live(
    auth: &BiblioAuth,
    arxiv_id: Option<&str>,
    doi: Option<&str>,
    title: Option<&str>,
    year: Option<i32>,
    authors: &[String],
    force: bool,
) -> LookupOutcome {
    let mut gate = gate().lock().await;
    take_budget_reset(&mut gate.budget);
    let mut now = Instant::now();
    let mut sleep = RealSleep;
    let outcome = {
        let Gate {
            limiter,
            cache,
            budget,
        } = &mut *gate;
        execute_lookup(
            auth, arxiv_id, doi, title, year, authors, force, &LiveFetch, limiter, cache, budget,
            &mut now, &mut sleep,
        )
        .await
    };
    take_budget_reset(&mut gate.budget);
    *BUDGET.lock().unwrap_or_else(|err| err.into_inner()) = gate.budget.clone();
    outcome
}

/// 邮箱 / Key 读不出来（钥匙串出错、secrets.json 或 biblio-settings.json 坏了）时按未配置查询。
pub fn auth_or_anonymous(loaded: Result<BiblioAuth, String>) -> (BiblioAuth, Option<LookupNotice>) {
    match loaded {
        Ok(auth) => (auth, None),
        Err(err) => {
            eprintln!("[paper-field] 文献库凭据读取失败，改为匿名查询：{err}");
            let notice = LookupNotice {
                source: "biblio".into(),
                code: "credentials".into(),
                message: "无法读取文献库的邮箱或 Key，本次按未配置查询；可到设置里重新保存".into(),
            };
            (BiblioAuth::default(), Some(notice))
        }
    }
}

enum FetchFail {
    Status(u16),
    Network,
}

async fn fetch_paced<F: Fetcher, S: Sleeper>(
    fetch: &F,
    sleeper: &mut S,
    limiter: &mut Limiter,
    budget: &mut BudgetTracker,
    now: &mut Instant,
    bucket: &str,
    min: Duration,
    request: &HttpRequest,
    crossref: bool,
) -> Result<HttpResponse, FetchFail> {
    let wait = limiter.reserve(bucket, *now, min);
    if !wait.is_zero() {
        sleeper.sleep(wait).await;
        *now += wait;
    }
    match fetch.get(request).await {
        Ok(response) => {
            if request.source == "openalex" {
                absorb_budget(budget, &response.headers, *now, SystemTime::now());
            }
            if crossref {
                absorb_crossref_limit(limiter, bucket, &response.headers);
            }
            if response.status == 429 {
                sleeper.sleep(BACKOFF).await;
                *now += BACKOFF;
                return Err(FetchFail::Status(429));
            }
            if response.status == 403 {
                return Err(FetchFail::Status(403));
            }
            if response.status == 404 {
                return Ok(HttpResponse {
                    status: 404,
                    body: String::new(),
                    headers: response.headers,
                });
            }
            if !(200..300).contains(&response.status) {
                return Err(FetchFail::Status(response.status));
            }
            Ok(response)
        }
        Err(_) => Err(FetchFail::Network),
    }
}

fn blank_text(value: &str) -> bool {
    value.trim().is_empty()
}

fn bibliographic_gaps(hit: &LookupHit) -> bool {
    blank_text(&hit.r#abstract)
        || hit.authors.is_empty()
        || hit
            .venue
            .as_ref()
            .map(|venue| blank_text(venue))
            .unwrap_or(true)
}

fn fill_missing(base: &mut LookupHit, extra: LookupHit) {
    if blank_text(&base.r#abstract) && !blank_text(&extra.r#abstract) {
        base.r#abstract = extra.r#abstract;
        if let Some(provider) = extra.providers.get("abstract") {
            base.providers.insert("abstract".into(), provider.clone());
        }
    }
    if base.authors.is_empty() && !extra.authors.is_empty() {
        base.authors = extra.authors;
        if let Some(provider) = extra.providers.get("authors") {
            base.providers.insert("authors".into(), provider.clone());
        }
    }
    if base
        .venue
        .as_ref()
        .map(|venue| blank_text(venue))
        .unwrap_or(true)
    {
        if let Some(venue) = extra.venue.filter(|venue| !blank_text(venue)) {
            base.venue = Some(venue);
            if let Some(provider) = extra.providers.get("venue") {
                base.providers.insert("venue".into(), provider.clone());
            }
        }
    }
    if base.doi.is_none() {
        if let Some(doi) = extra.doi {
            base.doi = Some(doi);
            if let Some(provider) = extra.providers.get("doi") {
                base.providers.insert("doi".into(), provider.clone());
            }
        }
    }
}

fn openalex_budget_message(keyed: bool) -> &'static str {
    if keyed {
        "OpenAlex 今日额度已用完，已改用其他文献库"
    } else {
        "OpenAlex 今日免费搜索次数已用完，填写 Key 可提高额度"
    }
}

fn openalex_busy_message(keyed: bool) -> &'static str {
    if keyed {
        "OpenAlex 暂时限流，本次已改用其他文献库"
    } else {
        "OpenAlex 暂时限流，本次已改用其他文献库；填写 Key 可提高额度"
    }
}

async fn search_openalex<F: Fetcher, S: Sleeper>(
    fetch: &F,
    sleeper: &mut S,
    limiter: &mut Limiter,
    budget: &mut BudgetTracker,
    now: &mut Instant,
    notices: &mut Vec<LookupNotice>,
    query: &TitleQuery,
    openalex_key: Option<&str>,
) -> Option<LookupHit> {
    if budget.search_blocked(*now) {
        note(
            notices,
            "openalex",
            "budget",
            openalex_budget_message(openalex_key.is_some()),
        );
        return None;
    }
    let request = openalex_search_request(&query.title, openalex_key);
    match fetch_paced(
        fetch,
        sleeper,
        limiter,
        budget,
        now,
        "openalex",
        Duration::ZERO,
        &request,
        false,
    )
    .await
    {
        Ok(response) if !response.body.is_empty() => {
            parse_openalex(&response.body, query).ok().flatten()
        }
        Ok(_) => None,
        Err(FetchFail::Status(429)) => {
            // 单次 429 只是限流，不锁额度；响应头说额度归零时 absorb_budget 已经锁上
            let keyed = openalex_key.is_some();
            if budget.search_blocked(*now) {
                note(
                    notices,
                    "openalex",
                    "budget",
                    openalex_budget_message(keyed),
                );
            } else {
                note(notices, "openalex", "busy", openalex_busy_message(keyed));
            }
            None
        }
        Err(_) => None,
    }
}

async fn search_s2<F: Fetcher, S: Sleeper>(
    fetch: &F,
    sleeper: &mut S,
    limiter: &mut Limiter,
    budget: &mut BudgetTracker,
    now: &mut Instant,
    notices: &mut Vec<LookupNotice>,
    query: &TitleQuery,
    s2_key: Option<&str>,
) -> Option<LookupHit> {
    let request = s2_match_request(&query.title, s2_key);
    let gap = if s2_key.is_some() {
        S2_CONFIGURED_GAP
    } else {
        Duration::ZERO
    };
    match fetch_paced(
        fetch, sleeper, limiter, budget, now, "s2", gap, &request, false,
    )
    .await
    {
        Ok(response) if !response.body.is_empty() => {
            parse_s2_match(&response.body, query).ok().flatten()
        }
        Ok(_) => None,
        Err(FetchFail::Status(429)) if s2_key.is_none() => {
            note(
                notices,
                "semanticscholar",
                "busy",
                "Semantic Scholar 公共通道繁忙，可申请个人 Key",
            );
            None
        }
        Err(_) => None,
    }
}

async fn search_crossref_title<F: Fetcher, S: Sleeper>(
    fetch: &F,
    sleeper: &mut S,
    limiter: &mut Limiter,
    budget: &mut BudgetTracker,
    now: &mut Instant,
    notices: &mut Vec<LookupNotice>,
    query: &TitleQuery,
    email: Option<&str>,
    polite: bool,
) -> Option<LookupHit> {
    let request = crossref_query_request(&query.title, email);
    match fetch_paced(
        fetch,
        sleeper,
        limiter,
        budget,
        now,
        "crossref-query",
        crossref_gap(polite, true),
        &request,
        true,
    )
    .await
    {
        Ok(response) if !response.body.is_empty() => {
            parse_crossref_query(&response.body, query).ok().flatten()
        }
        Ok(_) => None,
        Err(FetchFail::Status(429)) if !polite => {
            note(
                notices,
                "crossref",
                "slow",
                "Crossref 请求过快，已自动降速；填写邮箱可提速",
            );
            None
        }
        Err(FetchFail::Status(403)) => {
            note(notices, "crossref", "blocked", "Crossref 可能已限制访问");
            None
        }
        Err(_) => None,
    }
}

async fn fill_sparse_from_crossref_then_openalex<F: Fetcher, S: Sleeper>(
    hit: &mut Option<LookupHit>,
    title: &str,
    year: Option<i32>,
    authors: &[String],
    doi: Option<String>,
    arxiv_id: Option<String>,
    fetch: &F,
    sleeper: &mut S,
    limiter: &mut Limiter,
    budget: &mut BudgetTracker,
    now: &mut Instant,
    notices: &mut Vec<LookupNotice>,
    email: Option<&str>,
    polite: bool,
    openalex_key: Option<&str>,
) {
    let query = TitleQuery {
        title: title.to_string(),
        year,
        authors: authors.to_vec(),
        doi,
        arxiv_id,
    };
    if let Some(extra) = search_crossref_title(
        fetch, sleeper, limiter, budget, now, notices, &query, email, polite,
    )
    .await
    {
        if let Some(base) = hit.as_mut() {
            fill_missing(base, extra);
        }
    }
    if let Some(extra) = search_openalex(
        fetch, sleeper, limiter, budget, now, notices, &query, openalex_key,
    )
    .await
    {
        if let Some(base) = hit.as_mut() {
            fill_missing(base, extra);
        }
    }
}

/// `force` 跳过缓存读取（「刷新链接」），结果照常写回。有来源暂时失败时不写缓存。
pub async fn execute_lookup<F: Fetcher + Sync, S: Sleeper>(
    auth: &BiblioAuth,
    arxiv_id: Option<&str>,
    doi: Option<&str>,
    title: Option<&str>,
    year: Option<i32>,
    authors: &[String],
    force: bool,
    fetch: &F,
    limiter: &mut Limiter,
    cache: &mut LookupCache,
    budget: &mut BudgetTracker,
    now: &mut Instant,
    sleeper: &mut S,
) -> LookupOutcome {
    let mut notices = Vec::new();
    let key = cache_key(arxiv_id, doi, title, year, authors);
    if let Some(key) = key.as_deref().filter(|_| !force) {
        if let Some(hit) = cache.get(key, *now) {
            return LookupOutcome {
                hit: Some(hit),
                notices,
                openalex_remaining_usd: budget.remaining_usd,
                openalex_limit_usd: budget.limit_usd,
            };
        }
    }
    let watch = Watch {
        inner: fetch,
        transient: AtomicBool::new(false),
    };
    let fetch = &watch;

    let want_doi = doi.and_then(Doi::parse);
    let arxiv_from_doi = want_doi.as_ref().and_then(ArxivId::from_doi);
    let want_arxiv = arxiv_id
        .and_then(ArxivId::parse)
        .or_else(|| arxiv_from_doi.clone());
    let doi_is_arxiv = arxiv_from_doi.is_some();
    let want_doi = want_doi.map(Doi::into_string);
    let want_arxiv = want_arxiv.map(ArxivId::into_string);
    let want_title = title
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let email = auth.email.as_deref();
    let polite = usable_email(email).is_some();
    let openalex_key = auth
        .openalex_key
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let s2_key = auth
        .s2_key
        .as_deref()
        .filter(|value| !value.trim().is_empty());
    let mut hit: Option<LookupHit> = None;

    if let Some(id) = want_arxiv.clone() {
        let request = arxiv_request(&id);
        match fetch_paced(
            fetch, sleeper, limiter, budget, now, "arxiv", ARXIV_GAP, &request, false,
        )
        .await
        {
            Ok(response) if !response.body.is_empty() => {
                // 用响应 <id> 里的 id 核对，不再拿请求的 id 覆盖后自证
                if is_arxiv_error_feed(&response.body) {
                    note(
                        &mut notices,
                        "arxiv",
                        "error",
                        "arXiv 返回了错误条目，已改查其他文献库",
                    );
                } else if let Some(parsed) = parse_arxiv_atom(&response.body) {
                    if accepts_ids(&parsed, Some(&id), None) {
                        hit = Some(parsed);
                    } else {
                        note(
                            &mut notices,
                            "arxiv",
                            "mismatch",
                            "arXiv 返回的条目与请求的 arXiv id 不一致，已跳过",
                        );
                    }
                }
            }
            Ok(_) => {}
            Err(FetchFail::Network) | Err(FetchFail::Status(_)) => {}
        }
        let request = s2_arxiv_request(&id, s2_key);
        let gap = if s2_key.is_some() {
            S2_CONFIGURED_GAP
        } else {
            Duration::ZERO
        };
        let mut s2_failed = true;
        match fetch_paced(
            fetch, sleeper, limiter, budget, now, "s2", gap, &request, false,
        )
        .await
        {
            Ok(response) if !response.body.is_empty() => {
                if let Ok(Some(parsed)) = parse_s2_paper(&response.body) {
                    if accepts_ids(&parsed, Some(&id), None) {
                        s2_failed = false;
                        if let Some(base) = hit.as_mut() {
                            fill_missing(base, parsed);
                        } else {
                            hit = Some(parsed);
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(FetchFail::Status(429)) if s2_key.is_none() => {
                note(
                    &mut notices,
                    "semanticscholar",
                    "busy",
                    "Semantic Scholar 公共通道繁忙，可申请个人 Key",
                );
            }
            Err(_) => {}
        }
        // 这里的 hit 已经过 id 核对；被拒的 arXiv 条目不会走到这一步，它的标题也不会拿去检索
        if hit.is_some() && (s2_failed || bibliographic_gaps(hit.as_ref().expect("hit"))) {
            let fill_title = hit
                .as_ref()
                .map(|item| item.title.trim().to_string())
                .filter(|title| !title.is_empty())
                .or_else(|| want_title.clone());
            // 请求没带作者时用已核对记录的作者佐证，短标题才补得上
            let fill_authors: Vec<String> = if authors.is_empty() {
                hit.as_ref()
                    .map(|item| {
                        item.authors
                            .iter()
                            .map(|author| author.name.clone())
                            .collect()
                    })
                    .unwrap_or_default()
            } else {
                authors.to_vec()
            };
            if let Some(fill_title) = fill_title {
                fill_sparse_from_crossref_then_openalex(
                    &mut hit,
                    &fill_title,
                    year,
                    &fill_authors,
                    want_doi.clone(),
                    Some(id),
                    fetch,
                    sleeper,
                    limiter,
                    budget,
                    now,
                    &mut notices,
                    email,
                    polite,
                    openalex_key,
                )
                .await;
            }
        }
    }

    if hit.is_none() {
        if let Some(doi) = want_doi.clone() {
            if !doi_is_arxiv {
                let request = crossref_work_request(&doi, email);
                match fetch_paced(
                    fetch,
                    sleeper,
                    limiter,
                    budget,
                    now,
                    "crossref-single",
                    crossref_gap(polite, false),
                    &request,
                    true,
                )
                .await
                {
                    Ok(response) if !response.body.is_empty() => {
                        if let Ok(Some(parsed)) = parse_crossref(&response.body) {
                            if accepts_ids(&parsed, None, Some(&doi)) {
                                hit = Some(parsed);
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(FetchFail::Status(429)) if !polite => {
                        note(
                            &mut notices,
                            "crossref",
                            "slow",
                            "Crossref 请求过快，已自动降速；填写邮箱可提速",
                        );
                    }
                    Err(FetchFail::Status(403)) => {
                        note(
                            &mut notices,
                            "crossref",
                            "blocked",
                            "Crossref 可能已限制访问",
                        );
                    }
                    Err(_) => {}
                }
            }
            if hit.is_none() {
                let request = openalex_doi_request(&doi, openalex_key);
                match fetch_paced(
                    fetch,
                    sleeper,
                    limiter,
                    budget,
                    now,
                    "openalex",
                    Duration::ZERO,
                    &request,
                    false,
                )
                .await
                {
                    Ok(response) if !response.body.is_empty() => {
                        if let Ok(Some(parsed)) = parse_openalex_single(&response.body) {
                            if accepts_ids(&parsed, None, Some(&doi)) {
                                hit = Some(parsed);
                            }
                        }
                    }
                    Ok(_) | Err(_) => {}
                }
            }
        }
    }

    if hit.is_none() {
        if let Some(title) = want_title.clone() {
            let query = TitleQuery {
                title: title.clone(),
                year,
                authors: authors.to_vec(),
                doi: want_doi.clone(),
                arxiv_id: want_arxiv.clone(),
            };
            if hit.is_none() {
                hit = search_openalex(
                    fetch,
                    sleeper,
                    limiter,
                    budget,
                    now,
                    &mut notices,
                    &query,
                    openalex_key,
                )
                .await;
            }
            if hit.is_none() {
                hit = search_s2(
                    fetch,
                    sleeper,
                    limiter,
                    budget,
                    now,
                    &mut notices,
                    &query,
                    s2_key,
                )
                .await;
            }
            if hit.is_none() {
                hit = search_crossref_title(
                    fetch,
                    sleeper,
                    limiter,
                    budget,
                    now,
                    &mut notices,
                    &query,
                    email,
                    polite,
                )
                .await;
            }
        }
    }

    // 只缓存干净的结果：有来源 429/403/断网时，下次还要重新问
    if !watch.transient.load(Ordering::Relaxed) {
        if let (Some(key), Some(found)) = (key, hit.clone()) {
            cache.put(key, *now, found);
        }
    }
    LookupOutcome {
        hit,
        notices,
        openalex_remaining_usd: budget.remaining_usd,
        openalex_limit_usd: budget.limit_usd,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lookup::normalize_arxiv_id;

    struct Script {
        requests: Mutex<Vec<HttpRequest>>,
        responses: Mutex<Vec<Result<HttpResponse, String>>>,
    }

    impl Fetcher for Script {
        async fn get(&self, request: &HttpRequest) -> Result<HttpResponse, String> {
            self.requests.lock().unwrap().push(request.clone());
            self.responses.lock().unwrap().remove(0)
        }
    }

    struct RecordSleep {
        waits: Vec<Duration>,
    }

    impl Sleeper for RecordSleep {
        async fn sleep(&mut self, duration: Duration) {
            if !duration.is_zero() {
                self.waits.push(duration);
            }
        }
    }

    fn ok(body: &str) -> Result<HttpResponse, String> {
        Ok(HttpResponse {
            status: 200,
            body: body.to_string(),
            headers: vec![],
        })
    }

    fn status(code: u16) -> Result<HttpResponse, String> {
        Ok(HttpResponse {
            status: code,
            body: String::new(),
            headers: vec![],
        })
    }

    fn harness() -> (Limiter, LookupCache, BudgetTracker, Instant, RecordSleep) {
        (
            Limiter::default(),
            LookupCache::new(CACHE_TTL),
            BudgetTracker::default(),
            Instant::now(),
            RecordSleep { waits: vec![] },
        )
    }

    #[test]
    fn user_agent_and_requests_differ_only_by_credentials() {
        let bare = user_agent(true, None);
        assert!(!bare.contains("mailto"));
        assert!(!bare.contains("local@"));
        let polite = user_agent(true, Some("reader@example.com"));
        assert!(polite.contains("mailto:reader@example.com"));
        assert!(polite.starts_with("PaperField/"));
        assert_eq!(
            user_agent(false, Some("reader@example.com")),
            user_agent(false, None)
        );

        let openalex = openalex_search_request("Attention", None);
        assert!(!openalex.url.contains("mailto"));
        assert!(!openalex.url.contains("api_key"));
        assert!(!describe_request(&openalex).contains("reader@"));
        let keyed = openalex_search_request("Attention", Some("oa-secret-key-xyz"));
        assert!(!keyed.url.contains("api_key"));
        assert!(!keyed.url.contains("mailto"));
        let described = describe_request(&keyed);
        assert!(!described.contains("oa-secret-key-xyz"), "{described}");
        assert!(described.contains("authorization=<redacted>"));

        let crossref = crossref_work_request("10.1000/xyz", None);
        assert!(!crossref.url.contains("mailto"));
        assert!(!crossref
            .headers
            .iter()
            .any(|(_, value)| value.contains("mailto")));
        let polite_crossref = crossref_work_request("10.1000/xyz", Some("reader@example.com"));
        assert!(polite_crossref.url.contains("mailto=reader%40example.com"));
        assert!(polite_crossref
            .headers
            .iter()
            .any(|(_, value)| value.contains("mailto:reader@example.com")));

        let s2 = s2_match_request("Attention-Is", None);
        assert!(
            s2.url.contains("Attention%20Is")
                || s2.url.contains("Attention+Is")
                || s2.url.contains("Attention%20Is")
        );
        assert!(!s2.url.to_ascii_lowercase().contains("attention-is"));
        assert!(!s2
            .headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("x-api-key")));
        let s2_keyed = s2_arxiv_request("1706.03762", Some("s2-secret-key"));
        assert!(!describe_request(&s2_keyed).contains("s2-secret-key"));
        assert!(
            redact_url("https://api.openalex.org/works?search=a&api_key=oa-secret-key-xyz")
                .contains("search=a")
        );
        assert!(
            !redact_url("https://api.openalex.org/works?search=a&api_key=oa-secret-key-xyz")
                .contains("oa-secret")
        );
    }

    #[test]
    fn gaps_follow_the_public_and_polite_pools() {
        assert_eq!(ARXIV_GAP, Duration::from_secs(3));
        assert_eq!(crossref_gap(false, false), Duration::from_millis(200));
        assert_eq!(crossref_gap(false, true), Duration::from_secs(1));
        assert_eq!(crossref_gap(true, false), Duration::from_millis(100));
        assert_eq!(crossref_gap(true, true), Duration::from_millis(334));
        assert_eq!(gap_from_per_second(2.0), Some(Duration::from_millis(500)));
        assert_eq!(S2_CONFIGURED_GAP, Duration::from_secs(1));
    }

    #[tokio::test]
    async fn arxiv_requests_are_spaced_by_three_seconds() {
        let (mut limiter, mut cache, mut budget, mut now, sleeper) = harness();
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![
                ok(include_str!("../fixtures/arxiv-attention.xml")),
                status(404),
                status(404),
                status(404),
                ok(include_str!("../fixtures/arxiv-attention.xml")),
                status(404),
                status(404),
                status(404),
            ]),
        };
        let mut sleeper = sleeper;
        execute_lookup(
            &BiblioAuth::default(),
            Some("1706.03762"),
            None,
            None,
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        cache.entries.clear();
        execute_lookup(
            &BiblioAuth::default(),
            Some("1706.03762"),
            None,
            None,
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert!(
            sleeper.waits.iter().any(|wait| *wait >= ARXIV_GAP),
            "{:?}",
            sleeper.waits
        );
    }

    #[tokio::test]
    async fn doi_mismatch_falls_through_and_429_does_not_abort() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let wrong = r#"{"display_name":"Other Paper","publication_year":2025,"doi":"https://doi.org/10.65215/2q58a426"}"#;
        let search = r#"{"results":[{"display_name":"Attention Is All You Need","publication_year":2017,"doi":"https://doi.org/10.5555/3295222.3295349"}]}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![status(429), ok(wrong), ok(search)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            None,
            Some("10.5555/3295222.3295349"),
            Some("Attention Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let urls: Vec<String> = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.url.clone())
            .collect();
        assert!(urls[0].contains("api.crossref.org/works/"));
        assert!(!urls[0].contains("mailto"));
        assert!(urls[1].contains("api.openalex.org/works/doi:"));
        assert!(urls[2].contains("api.openalex.org/works?search="));
        let hit = outcome.hit.unwrap();
        assert_eq!(hit.source_name, "openalex");
        assert_eq!(hit.doi.as_deref(), Some("10.5555/3295222.3295349"));
        assert!(outcome.notices.iter().any(|notice| notice.code == "slow"));
    }

    #[tokio::test]
    async fn network_error_continues_to_the_next_source() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let right = r#"{"display_name":"Attention Is All You Need","publication_year":2017,"doi":"https://doi.org/10.5555/3295222.3295349"}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![Err("offline".into()), ok(right)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth {
                email: Some("reader@example.com".into()),
                ..BiblioAuth::default()
            },
            None,
            Some("10.5555/3295222.3295349"),
            None,
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert_eq!(script.requests.lock().unwrap().len(), 2);
        assert!(script.requests.lock().unwrap()[0]
            .url
            .contains("mailto=reader%40example.com"));
        assert!(!script.requests.lock().unwrap()[1].url.contains("mailto"));
        assert_eq!(outcome.hit.unwrap().source_name, "openalex");
        assert!(outcome.notices.is_empty());
    }

    #[tokio::test]
    async fn exhausted_openalex_budget_skips_search_and_uses_semantic_scholar() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        budget.remaining_usd = Some(0.0);
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![ok(include_str!(
                "../fixtures/semanticscholar-attention.json"
            ))]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            None,
            None,
            Some("Attention Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let urls: Vec<String> = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.url.clone())
            .collect();
        assert!(
            urls.iter().all(|url| !url.contains("api.openalex.org")),
            "{urls:?}"
        );
        assert!(urls[0].contains("search/match"));
        assert!(outcome
            .notices
            .iter()
            .any(|notice| notice.message.contains("填写 Key")));
        assert_eq!(outcome.hit.unwrap().source_name, "semanticscholar");
    }

    #[tokio::test]
    async fn cache_hit_does_not_repeat_the_request() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![
                ok(include_str!("../fixtures/arxiv-attention.xml")),
                status(404),
                status(404),
                status(404),
            ]),
        };
        let auth = BiblioAuth::default();
        let first = execute_lookup(
            &auth,
            Some("1706.03762"),
            None,
            None,
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert!(first.hit.is_some());
        let calls = script.requests.lock().unwrap().len();
        let second = execute_lookup(
            &auth,
            Some("1706.03762"),
            None,
            None,
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert_eq!(script.requests.lock().unwrap().len(), calls);
        assert_eq!(second.hit.unwrap().title, "Attention Is All You Need");
    }

    #[test]
    fn old_style_arxiv_id_is_normalized() {
        assert_eq!(
            normalize_arxiv_id("hep-th/9901001v2").as_deref(),
            Some("hep-th/9901001")
        );
        let request = arxiv_request("hep-th/9901001");
        assert!(request.url.contains("hep-th"));
        assert!(request.url.contains("%2F"));
        assert!(!request.url.contains("POST"));
    }

    #[tokio::test]
    async fn old_style_arxiv_id_keeps_journal_ref_as_venue() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let xml = r#"<entry><title>T</title><summary>S</summary><id>http://arxiv.org/abs/hep-th/9901001v2</id><arxiv:journal_ref>Phys. Rev. D 60</arxiv:journal_ref><arxiv:doi>10.1103/PhysRevD.60.1</arxiv:doi></entry>"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![ok(xml), status(404), status(404), status(404)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            Some("hep-th/9901001v2"),
            None,
            None,
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let hit = outcome.hit.unwrap();
        assert_eq!(hit.arxiv_id.as_deref(), Some("hep-th/9901001"));
        assert_eq!(hit.venue.as_deref(), Some("Phys. Rev. D 60"));
        let url = script.requests.lock().unwrap()[0].url.clone();
        assert!(url.starts_with("https://export.arxiv.org/api/query?id_list="));
        assert!(url.contains("hep-th%2F9901001"));
    }

    #[tokio::test]
    async fn configured_crossref_uses_the_recorded_work_and_mailto() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let body = include_str!("../fixtures/crossref-attention.json")
            .replace("10.48550/arXiv.1706.03762", "10.5555/3295222.3295349");
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![ok(&body)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth {
                email: Some("reader@example.com".into()),
                ..BiblioAuth::default()
            },
            None,
            Some("10.5555/3295222.3295349"),
            Some("Attention Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert_eq!(script.requests.lock().unwrap().len(), 1);
        let request = script.requests.lock().unwrap()[0].clone();
        assert!(request.url.contains("mailto=reader%40example.com"));
        assert!(describe_request(&request).contains("mailto:reader@example.com"));
        assert_eq!(outcome.hit.unwrap().source_name, "crossref");
    }

    #[tokio::test]
    async fn crossref_forbidden_is_recorded_and_lookup_continues() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let right = r#"{"display_name":"Attention Is All You Need","publication_year":2017,"doi":"https://doi.org/10.5555/3295222.3295349"}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![status(403), ok(right)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            None,
            Some("10.5555/3295222.3295349"),
            None,
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert_eq!(outcome.hit.unwrap().source_name, "openalex");
        assert!(outcome
            .notices
            .iter()
            .any(|notice| notice.message.contains("限制访问")));
    }

    #[tokio::test]
    async fn title_search_fallthrough_records_each_unconfigured_limit() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![status(429), status(429), status(429)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            None,
            None,
            Some("Attention-Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let requests = script.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 3);
        assert!(requests[0].url.contains("api.openalex.org/works?search="));
        assert!(!requests[0].url.contains("mailto"));
        assert!(!requests[0].url.contains("api_key"));
        assert!(requests[1].url.contains("search/match"));
        assert!(requests[1].url.contains("Attention%20Is"));
        assert!(!requests[1]
            .url
            .to_ascii_lowercase()
            .contains("attention-is"));
        assert!(!requests[1]
            .headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case("x-api-key")));
        assert!(requests[2].url.contains("query.bibliographic"));
        assert!(!requests[2].url.contains("mailto"));
        assert!(outcome.hit.is_none());
        assert!(outcome
            .notices
            .iter()
            .any(|notice| notice.message.contains("填写 Key")));
        assert!(outcome
            .notices
            .iter()
            .any(|notice| notice.message.contains("个人 Key")));
        assert!(outcome
            .notices
            .iter()
            .any(|notice| notice.message.contains("填写邮箱")));
    }

    #[tokio::test]
    async fn configured_title_search_sends_keys_without_logging_them() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../fixtures/crossref-attention.json")).unwrap();
        let query =
            serde_json::json!({ "message": { "items": [fixture["message"].clone()] } }).to_string();
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![status(404), status(404), ok(&query)]),
        };
        let auth = BiblioAuth {
            email: Some("reader@example.com".into()),
            openalex_key: Some("oa-secret-key-xyz".into()),
            s2_key: Some("s2-secret-key".into()),
        };
        let outcome = execute_lookup(
            &auth,
            None,
            None,
            Some("Attention-Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let requests = script.requests.lock().unwrap().clone();
        assert!(requests[0].url.contains("api.openalex.org/works?search="));
        assert!(requests[0].headers.iter().any(|(key, value)| {
            key.eq_ignore_ascii_case("authorization") && value == "Bearer oa-secret-key-xyz"
        }));
        assert!(!describe_request(&requests[0]).contains("oa-secret-key-xyz"));
        assert!(requests[1].url.contains("search/match"));
        assert!(requests[1]
            .headers
            .iter()
            .any(|(key, value)| key.eq_ignore_ascii_case("x-api-key") && value == "s2-secret-key"));
        assert!(!describe_request(&requests[1]).contains("s2-secret-key"));
        assert!(!requests[1].url.contains("mailto"));
        assert!(requests[2].url.contains("mailto=reader%40example.com"));
        assert!(!outcome
            .notices
            .iter()
            .any(|notice| notice.message.contains("个人 Key")));
        assert_eq!(outcome.hit.unwrap().source_name, "crossref");
    }

    #[tokio::test]
    async fn crossref_rate_limit_header_spaces_the_next_request() {
        let (mut limiter, mut cache, mut budget, mut now, sleeper) = harness();
        let limited = HttpResponse {
            status: 200,
            body: include_str!("../fixtures/crossref-attention.json")
                .replace("10.48550/arXiv.1706.03762", "10.5555/3295222.3295349"),
            headers: vec![("x-rate-limit-limit".into(), "2".into())],
        };
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![Ok(limited.clone()), Ok(limited)]),
        };
        let mut sleeper = sleeper;
        let auth = BiblioAuth::default();
        execute_lookup(
            &auth,
            None,
            Some("10.5555/3295222.3295349"),
            None,
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        cache.entries.clear();
        execute_lookup(
            &auth,
            None,
            Some("10.5555/3295222.3295349"),
            None,
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert!(
            sleeper
                .waits
                .iter()
                .any(|wait| *wait >= Duration::from_millis(500)),
            "{:?}",
            sleeper.waits
        );
    }

    #[tokio::test]
    async fn configured_semantic_scholar_requests_are_spaced_by_one_second() {
        let (mut limiter, mut cache, mut budget, mut now, sleeper) = harness();
        budget.remaining_usd = Some(0.0);
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![
                status(404),
                status(404),
                ok(include_str!("../fixtures/semanticscholar-attention.json")),
            ]),
        };
        let auth = BiblioAuth {
            s2_key: Some("s2-secret-key".into()),
            ..BiblioAuth::default()
        };
        let mut sleeper = sleeper;
        execute_lookup(
            &auth,
            None,
            None,
            Some("Attention Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        execute_lookup(
            &auth,
            None,
            None,
            Some("Attention Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert!(
            sleeper.waits.iter().any(|wait| *wait >= S2_CONFIGURED_GAP),
            "{:?}",
            sleeper.waits
        );
        let requests = script.requests.lock().unwrap().clone();
        let s2: Vec<_> = requests
            .iter()
            .filter(|request| request.source == "semanticscholar")
            .collect();
        assert_eq!(s2.len(), 2);
        assert!(s2
            .iter()
            .all(|request| request.url.contains("search/match")));
        assert!(s2
            .iter()
            .all(|request| !describe_request(request).contains("s2-secret-key")));
    }

    #[tokio::test]
    async fn arxiv_doi_is_fetched_from_arxiv_not_crossref() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let crossref = r#"{"message":{"items":[{"title":["Attention Is All You Need"],"container-title":["NeurIPS"],"author":[{"given":"Jane","family":"Doe"}],"DOI":"10.48550/arXiv.1706.03762","abstract":"should not replace the arxiv abstract"}]}}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![
                ok(include_str!("../fixtures/arxiv-attention.xml")),
                status(404),
                ok(crossref),
                status(404),
            ]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            None,
            Some("https://doi.org/10.48550/arXiv.1706.03762"),
            Some("Attention Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let urls: Vec<String> = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.url.clone())
            .collect();
        assert!(urls[0].contains("export.arxiv.org/api/query"), "{urls:?}");
        assert!(urls[1].contains("ARXIV:1706.03762"), "{urls:?}");
        assert!(
            urls.iter().all(|url| !url.contains("/works/10.48550")),
            "{urls:?}"
        );
        assert!(
            urls.iter().any(|url| url.contains("query.bibliographic")),
            "{urls:?}"
        );
        let hit = outcome.hit.unwrap();
        assert_eq!(hit.source_name, "arxiv");
        assert_eq!(hit.venue.as_deref(), Some("NeurIPS"));
        assert!(hit.r#abstract.contains("dominant sequence"));
        assert!(!hit.r#abstract.contains("should not replace"));
        assert_eq!(hit.authors[0].name, "Ashish Vaswani");
    }

    #[tokio::test]
    async fn configured_s2_match_is_preferred_and_a_doi_conflict_falls_through() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let impostor = r#"{"data":[{"title":"Attention Is All You Need","year":2024,"externalIds":{"DOI":"10.9999/impostor","ArXiv":"2401.00001"},"authors":[{"name":"Jane Doe"}]}]}"#;
        let crossref = r#"{"message":{"items":[{"title":["Attention Is All You Need"],"DOI":"10.5555/3295222.3295349","author":[{"given":"Ashish","family":"Vaswani"}],"published":{"date-parts":[[2017]]},"container-title":["NeurIPS"]}]}}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![
                status(404),
                status(404),
                status(404),
                ok(impostor),
                ok(crossref),
            ]),
        };
        let authors = vec!["Ashish Vaswani".to_string()];
        let outcome = execute_lookup(
            &BiblioAuth {
                s2_key: Some("s2-secret-key".into()),
                ..BiblioAuth::default()
            },
            None,
            Some("10.5555/3295222.3295349"),
            Some("Attention Is All You Need"),
            Some(2017),
            &authors,
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let urls: Vec<String> = script
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.url.clone())
            .collect();
        assert!(urls[0].contains("api.crossref.org/works/"), "{urls:?}");
        assert!(urls[1].contains("api.openalex.org/works/doi:"), "{urls:?}");
        assert!(urls[2].contains("api.openalex.org/works?search="), "{urls:?}");
        assert!(urls[3].contains("search/match"), "{urls:?}");
        assert!(urls[4].contains("query.bibliographic"), "{urls:?}");
        let hit = outcome.hit.unwrap();
        assert_eq!(hit.source_name, "crossref");
        assert_eq!(hit.doi.as_deref(), Some("10.5555/3295222.3295349"));
    }

    fn distinct_title_script() -> Script {
        Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![
                ok(r#"{"results":[{"display_name":"OpenAlex Distinct Title"}]}"#),
                ok(r#"{"title":"Semantic Scholar Distinct Title"}"#),
                ok(r#"{"message":{"items":[{"title":["Crossref Distinct Title"]}]}}"#),
            ]),
        }
    }

    fn title_search_urls(script: &Script) -> Vec<String> {
        script
            .requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.url.clone())
            .collect()
    }

    #[tokio::test]
    async fn title_search_order_is_openalex_then_s2_then_crossref_without_a_key() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let script = distinct_title_script();
        execute_lookup(
            &BiblioAuth::default(),
            None,
            None,
            Some("Attention Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let urls = title_search_urls(&script);
        assert!(urls[0].contains("api.openalex.org/works?search="), "{urls:?}");
        assert!(urls[1].contains("search/match"), "{urls:?}");
        assert!(urls[2].contains("query.bibliographic"), "{urls:?}");
        assert!(script.requests.lock().unwrap().iter().all(|request| {
            !request
                .headers
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case("x-api-key"))
        }));
    }

    #[tokio::test]
    async fn title_search_order_stays_the_same_when_an_s2_key_is_set() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let script = distinct_title_script();
        execute_lookup(
            &BiblioAuth {
                s2_key: Some("s2-secret-key".into()),
                ..BiblioAuth::default()
            },
            None,
            None,
            Some("Attention Is All You Need"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let urls = title_search_urls(&script);
        assert!(urls[0].contains("api.openalex.org/works?search="), "{urls:?}");
        assert!(urls[1].contains("search/match"), "{urls:?}");
        assert!(urls[2].contains("query.bibliographic"), "{urls:?}");
        let requests = script.requests.lock().unwrap().clone();
        assert!(requests[1].headers.iter().any(|(key, value)| {
            key.eq_ignore_ascii_case("x-api-key") && value == "s2-secret-key"
        }));
        assert!(!requests[0].headers.iter().any(|(key, _)| key.eq_ignore_ascii_case("x-api-key")));
        assert!(!requests[2].headers.iter().any(|(key, _)| key.eq_ignore_ascii_case("x-api-key")));
    }

    #[tokio::test]
    async fn empty_arxiv_abstract_is_filled_from_crossref_after_s2_fails() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let crossref = r#"{"message":{"items":[{"title":["Sparse Abstract Paper"],"abstract":"Filled from Crossref.","container-title":["Other Venue"],"author":[{"given":"Ashish","family":"Vaswani"}],"DOI":"10.9999/other"}]}}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![
                ok(include_str!("../fixtures/arxiv-empty-abstract.xml")),
                status(429),
                ok(crossref),
                status(404),
            ]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            Some("1706.03762"),
            None,
            Some("Sparse Abstract Paper"),
            None,
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let urls = title_search_urls(&script);
        assert!(urls.iter().any(|url| url.contains("query.bibliographic")), "{urls:?}");
        let hit = outcome.hit.unwrap();
        assert_eq!(hit.r#abstract, "Filled from Crossref.");
        assert_eq!(hit.authors[0].name, "Ashish Vaswani");
        assert_eq!(hit.venue.as_deref(), Some("NeurIPS"));
        assert_eq!(hit.doi.as_deref(), Some("10.5555/3295222.3295349"));
    }

    #[tokio::test]
    async fn crossref_fills_empty_arxiv_authors_and_leaves_a_present_abstract() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let xml = r#"<entry><title>Sparse Abstract Paper</title><summary>Kept abstract.</summary><id>http://arxiv.org/abs/1706.03762v1</id><arxiv:journal_ref>NeurIPS</arxiv:journal_ref><arxiv:doi>10.5555/3295222.3295349</arxiv:doi></entry>"#;
        let crossref = r#"{"message":{"items":[{"title":["Sparse Abstract Paper"],"abstract":"Different abstract.","author":[{"given":"Grace","family":"Hopper"}],"published":{"date-parts":[[2017]]},"container-title":["Other Venue"],"DOI":"10.9999/other"}]}}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![ok(xml), status(429), ok(crossref), status(404)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            Some("1706.03762"),
            None,
            Some("Sparse Abstract Paper"),
            Some(2017),
            &[],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let hit = outcome.hit.unwrap();
        assert_eq!(hit.authors.len(), 1);
        assert_eq!(hit.authors[0].name, "Grace Hopper");
        assert_eq!(hit.r#abstract, "Kept abstract.");
        assert_eq!(hit.venue.as_deref(), Some("NeurIPS"));
    }

    #[tokio::test]
    async fn title_cache_key_includes_year_and_normalized_authors() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let first = r#"{"results":[{"display_name":"Attention Is All You Need","publication_year":2017,"primary_location":{"source":{"display_name":"First Venue"}}}]}"#;
        let second = r#"{"results":[{"display_name":"Attention Is All You Need","publication_year":2017,"primary_location":{"source":{"display_name":"Second Venue"}}}]}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![ok(first), ok(second)]),
        };
        let ashish = vec!["Ashish Vaswani".to_string()];
        let grace = vec!["Grace Hopper".to_string()];
        let first_hit = execute_lookup(
            &BiblioAuth::default(),
            None,
            None,
            Some("Attention Is All You Need"),
            Some(2017),
            &ashish,
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert_eq!(first_hit.hit.unwrap().venue.as_deref(), Some("First Venue"));
        assert_eq!(script.requests.lock().unwrap().len(), 1);
        let second_hit = execute_lookup(
            &BiblioAuth::default(),
            None,
            None,
            Some("Attention Is All You Need"),
            Some(2017),
            &grace,
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert_eq!(script.requests.lock().unwrap().len(), 2);
        assert_eq!(second_hit.hit.unwrap().venue.as_deref(), Some("Second Venue"));
        let again = execute_lookup(
            &BiblioAuth::default(),
            None,
            None,
            Some("Attention   Is All You Need"),
            Some(2017),
            &["ashish   vaswani".to_string()],
            false,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert_eq!(script.requests.lock().unwrap().len(), 2);
        assert_eq!(again.hit.unwrap().venue.as_deref(), Some("First Venue"));
    }

    type Rig = (Limiter, LookupCache, BudgetTracker, Instant, RecordSleep);

    async fn lookup_with(
        script: &Script,
        rig: &mut Rig,
        arxiv_id: Option<&str>,
        doi: Option<&str>,
        title: Option<&str>,
        force: bool,
    ) -> LookupOutcome {
        let (limiter, cache, budget, now, sleeper) = rig;
        execute_lookup(
            &BiblioAuth::default(),
            arxiv_id,
            doi,
            title,
            None,
            &[],
            force,
            script,
            limiter,
            cache,
            budget,
            now,
            sleeper,
        )
        .await
    }

    fn scripted(responses: Vec<Result<HttpResponse, String>>) -> Script {
        Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(responses),
        }
    }

    fn with_headers(
        code: u16,
        body: &str,
        headers: &[(&str, &str)],
    ) -> Result<HttpResponse, String> {
        Ok(HttpResponse {
            status: code,
            body: body.to_string(),
            headers: headers
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        })
    }

    fn request_count(script: &Script) -> usize {
        script.requests.lock().unwrap().len()
    }

    const WRONG_ARXIV: &str = r#"<feed><entry><id>http://arxiv.org/abs/2401.99999v1</id><title>Wrong Paper Entirely</title><summary>Other.</summary></entry></feed>"#;

    #[tokio::test]
    async fn arxiv_entry_with_another_id_is_rejected_and_its_title_never_searched() {
        let mut rig = harness();
        let s2 = r#"{"title":"Verified Title From Semantic Scholar","externalIds":{"ArXiv":"2401.01234"}}"#;
        let script = scripted(vec![ok(WRONG_ARXIV), ok(s2), status(404), status(404)]);
        let outcome = lookup_with(
            &script,
            &mut rig,
            Some("2401.01234"),
            None,
            Some("My Own Title"),
            false,
        )
        .await;
        let urls = title_search_urls(&script);
        assert_eq!(urls.len(), 4, "{urls:?}");
        assert!(urls.iter().all(|url| !url.contains("Wrong")), "{urls:?}");
        assert!(
            urls[2].contains("query.bibliographic=Verified%20Title"),
            "{urls:?}"
        );
        let hit = outcome.hit.expect("s2 hit");
        assert_eq!(hit.source_name, "semanticscholar");
        assert_eq!(hit.arxiv_id.as_deref(), Some("2401.01234"));
        assert!(outcome
            .notices
            .iter()
            .any(|notice| notice.source == "arxiv" && notice.code == "mismatch"));
    }

    #[tokio::test]
    async fn rejected_arxiv_entry_falls_through_to_the_requested_title() {
        let mut rig = harness();
        let script = scripted(vec![
            ok(WRONG_ARXIV),
            status(404),
            status(404),
            status(404),
            status(404),
        ]);
        let outcome = lookup_with(
            &script,
            &mut rig,
            Some("2401.01234"),
            None,
            Some("My Own Title"),
            false,
        )
        .await;
        let urls = title_search_urls(&script);
        assert_eq!(urls.len(), 5, "{urls:?}");
        assert!(urls.iter().all(|url| !url.contains("Wrong")), "{urls:?}");
        assert!(urls[2].contains("search=My%20Own%20Title"), "{urls:?}");
        assert!(outcome.hit.is_none());
    }

    #[tokio::test]
    async fn arxiv_error_entry_is_recorded_and_the_next_source_answers() {
        let mut rig = harness();
        let error = r#"<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_2401.01234</id><title>Error</title><summary>incorrect id format</summary><author><name>arXiv api core</name></author></entry></feed>"#;
        let s2 = r#"{"title":"Verified Title From Semantic Scholar","abstract":"Kept.","venue":"Venue","authors":[{"name":"Jane Doe"}],"externalIds":{"ArXiv":"2401.01234v2"}}"#;
        let script = scripted(vec![ok(error), ok(s2)]);
        let outcome = lookup_with(
            &script,
            &mut rig,
            Some("arXiv：2401.01234"),
            None,
            None,
            false,
        )
        .await;
        let urls = title_search_urls(&script);
        assert_eq!(urls.len(), 2, "{urls:?}");
        assert!(urls[0].contains("id_list=2401.01234"), "{urls:?}");
        let hit = outcome.hit.expect("s2 hit");
        assert_eq!(hit.source_name, "semanticscholar");
        assert_eq!(hit.title, "Verified Title From Semantic Scholar");
        assert!(outcome
            .notices
            .iter()
            .any(|notice| notice.source == "arxiv" && notice.code == "error"));
    }

    #[test]
    fn identifiers_compare_in_one_form() {
        let hit = parse_s2_paper(
            r#"{"title":"T","externalIds":{"DOI":"10.1000/ABC","ArXiv":"2401.01234v2"}}"#,
        )
        .unwrap()
        .expect("s2 paper");
        assert!(accepts_ids(
            &hit,
            Some("arXiv：2401.01234"),
            Some("https://doi.org/10.1000/abc")
        ));
        assert!(!accepts_ids(&hit, Some("2401.01235"), None));
        assert!(!accepts_ids(&hit, None, Some("10.1000/abd")));
        assert_eq!(
            cache_key(Some("arXiv：2401.01234"), None, None, None, &[]),
            cache_key(
                Some("https://arxiv.org/abs/2401.01234v3"),
                None,
                None,
                None,
                &[]
            )
        );
        assert_eq!(
            cache_key(None, Some("doi:10.48550/arXiv.2401.01234"), None, None, &[]),
            cache_key(Some("2401.01234"), None, None, None, &[])
        );
        assert_eq!(
            cache_key(None, Some("https://doi.org/10.1000/ABC"), None, None, &[]).as_deref(),
            Some("doi:10.1000/abc")
        );
    }

    #[tokio::test]
    async fn force_skips_the_cache_read_and_stores_the_fresh_result() {
        let mut rig = harness();
        let first = r#"{"results":[{"display_name":"Attention Is All You Need","publication_year":2017,"primary_location":{"source":{"display_name":"First Venue"}}}]}"#;
        let second = r#"{"results":[{"display_name":"Attention Is All You Need","publication_year":2017,"primary_location":{"source":{"display_name":"Second Venue"}}}]}"#;
        let script = scripted(vec![ok(first), ok(second)]);
        let title = Some("Attention Is All You Need");
        let cached = lookup_with(&script, &mut rig, None, None, title, false).await;
        assert_eq!(cached.hit.unwrap().venue.as_deref(), Some("First Venue"));
        let forced = lookup_with(&script, &mut rig, None, None, title, true).await;
        assert_eq!(request_count(&script), 2);
        assert_eq!(forced.hit.unwrap().venue.as_deref(), Some("Second Venue"));
        let again = lookup_with(&script, &mut rig, None, None, title, false).await;
        assert_eq!(request_count(&script), 2);
        assert_eq!(again.hit.unwrap().venue.as_deref(), Some("Second Venue"));
    }

    #[tokio::test]
    async fn a_transient_failure_keeps_the_result_out_of_the_cache() {
        let mut rig = harness();
        let arxiv = include_str!("../fixtures/arxiv-attention.xml");
        let script = scripted(vec![
            ok(arxiv),
            status(429),
            status(404),
            status(404),
            ok(arxiv),
            status(404),
            status(404),
            status(404),
        ]);
        let id = Some("1706.03762");
        assert!(lookup_with(&script, &mut rig, id, None, None, false)
            .await
            .hit
            .is_some());
        assert_eq!(request_count(&script), 4);
        assert!(lookup_with(&script, &mut rig, id, None, None, false)
            .await
            .hit
            .is_some());
        assert_eq!(request_count(&script), 8);
        let cached = lookup_with(&script, &mut rig, id, None, None, false).await;
        assert_eq!(request_count(&script), 8);
        assert_eq!(cached.hit.unwrap().title, "Attention Is All You Need");

        let mut rig = harness();
        let right = r#"{"display_name":"Attention Is All You Need","publication_year":2017,"doi":"https://doi.org/10.5555/3295222.3295349"}"#;
        let script = scripted(vec![
            Err("offline".into()),
            ok(right),
            Err("timeout".into()),
            ok(right),
        ]);
        let doi = Some("10.5555/3295222.3295349");
        for _ in 0..2 {
            let outcome = lookup_with(&script, &mut rig, None, doi, None, false).await;
            assert_eq!(outcome.hit.unwrap().source_name, "openalex");
        }
        assert_eq!(request_count(&script), 4);
    }

    #[tokio::test]
    async fn only_openalex_headers_move_the_openalex_budget() {
        let mut rig = harness();
        let zero = [("x-ratelimit-remaining", "0")];
        let crossref = r#"{"message":{"items":[{"title":["Attention Is All You Need"],"DOI":"10.5555/3295222.3295349"}]}}"#;
        let script = scripted(vec![
            status(404),
            with_headers(200, r#"{"data":[]}"#, &zero),
            with_headers(200, crossref, &zero),
            status(404),
            status(404),
            status(404),
        ]);
        let outcome = lookup_with(
            &script,
            &mut rig,
            None,
            None,
            Some("Attention Is All You Need"),
            false,
        )
        .await;
        assert_eq!(outcome.hit.unwrap().source_name, "crossref");
        assert!(outcome.openalex_remaining_usd.is_none());
        assert!(!rig.2.search_blocked(rig.3));
        lookup_with(
            &script,
            &mut rig,
            None,
            None,
            Some("Another Paper About Other Things"),
            false,
        )
        .await;
        let urls = title_search_urls(&script);
        assert!(
            urls[3].contains("api.openalex.org/works?search="),
            "{urls:?}"
        );
    }

    #[tokio::test]
    async fn a_single_openalex_429_does_not_latch_the_budget() {
        let mut rig = harness();
        let script = scripted(vec![
            status(429),
            status(404),
            status(404),
            status(404),
            status(404),
            status(404),
        ]);
        let first = lookup_with(
            &script,
            &mut rig,
            None,
            None,
            Some("Attention Is All You Need"),
            false,
        )
        .await;
        assert!(first
            .notices
            .iter()
            .any(|notice| notice.source == "openalex" && notice.code == "busy"));
        assert!(!first.notices.iter().any(|notice| notice.code == "budget"));
        assert!(rig.2.remaining_usd.is_none());
        lookup_with(
            &script,
            &mut rig,
            None,
            None,
            Some("Another Paper About Other Things"),
            false,
        )
        .await;
        let urls = title_search_urls(&script);
        let searches = urls
            .iter()
            .filter(|url| url.contains("api.openalex.org/works?search="))
            .count();
        assert_eq!(searches, 2, "{urls:?}");
    }

    #[tokio::test]
    async fn exhausted_openalex_budget_unlatches_within_an_hour() {
        let mut rig = harness();
        let found =
            r#"{"results":[{"display_name":"Attention Is All You Need","publication_year":2017}]}"#;
        let script = scripted(vec![
            with_headers(
                200,
                found,
                &[
                    ("x-ratelimit-remaining-usd", "0"),
                    ("x-ratelimit-limit-usd", "1"),
                ],
            ),
            status(404),
            status(404),
            status(404),
            status(404),
            status(404),
        ]);
        let first = lookup_with(
            &script,
            &mut rig,
            None,
            None,
            Some("Attention Is All You Need"),
            false,
        )
        .await;
        assert_eq!(first.openalex_remaining_usd, Some(0.0));
        assert_eq!(first.openalex_limit_usd, Some(1.0));
        let second = lookup_with(
            &script,
            &mut rig,
            None,
            None,
            Some("Another Paper About Other Things"),
            false,
        )
        .await;
        assert!(second.notices.iter().any(|notice| notice.code == "budget"));
        let searches = |script: &Script| {
            title_search_urls(script)
                .iter()
                .filter(|url| url.contains("api.openalex.org/works?search="))
                .count()
        };
        assert_eq!(searches(&script), 1);
        rig.3 += Duration::from_secs(60 * 60 + 1);
        lookup_with(
            &script,
            &mut rig,
            None,
            None,
            Some("Yet Another Paper On Something"),
            false,
        )
        .await;
        assert_eq!(searches(&script), 2, "{:?}", title_search_urls(&script));
    }

    #[test]
    fn budget_latch_lasts_until_utc_midnight_or_one_hour() {
        let midnight = UNIX_EPOCH + Duration::from_secs(86_400 * 20_000);
        let at = |secs: u64| midnight + Duration::from_secs(secs);
        assert_eq!(latch_window(at(10 * 3600)), Duration::from_secs(3600));
        assert_eq!(
            latch_window(at(23 * 3600 + 30 * 60)),
            Duration::from_secs(30 * 60)
        );
        assert_eq!(latch_window(at(86_399)), Duration::from_secs(1));
        let now = Instant::now();
        let mut budget = BudgetTracker::default();
        budget.mark_remaining(0.0, now, at(23 * 3600 + 30 * 60));
        assert!(budget.search_blocked(now));
        // 锁住期间 DOI 请求又带回 0，不顺延
        budget.mark_remaining(
            0.0,
            now + Duration::from_secs(20 * 60),
            at(23 * 3600 + 50 * 60),
        );
        assert!(budget.search_blocked(now + Duration::from_secs(29 * 60)));
        assert!(!budget.search_blocked(now + Duration::from_secs(30 * 60)));
        assert!(budget.remaining_usd.is_none());
        budget.mark_remaining(0.0, now, at(0));
        budget.reset();
        assert!(!budget.search_blocked(now));
    }

    #[test]
    fn saving_settings_resets_the_shared_latch() {
        let wall = UNIX_EPOCH + Duration::from_secs(10 * 3600);
        BUDGET
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .mark_remaining(0.0, Instant::now(), wall);
        assert_eq!(budget_snapshot().remaining_usd, Some(0.0));
        let mut gate_budget = BudgetTracker::default();
        gate_budget.mark_remaining(0.0, Instant::now(), wall);
        reset_openalex_latch();
        assert!(budget_snapshot().remaining_usd.is_none());
        take_budget_reset(&mut gate_budget);
        assert!(!gate_budget.search_blocked(Instant::now()));
    }

    #[test]
    fn unreadable_credentials_fall_back_to_anonymous_with_a_notice() {
        let (auth, notice) = auth_or_anonymous(Err("secrets.json 无法解析：expected value".into()));
        assert!(auth.email.is_none() && auth.openalex_key.is_none() && auth.s2_key.is_none());
        let notice = notice.expect("notice");
        assert_eq!(notice.source, "biblio");
        assert_eq!(notice.code, "credentials");
        assert!(
            notice.message.contains("按未配置查询"),
            "{}",
            notice.message
        );
        let (auth, notice) = auth_or_anonymous(Ok(BiblioAuth {
            email: Some("reader@example.com".into()),
            ..BiblioAuth::default()
        }));
        assert!(notice.is_none());
        assert_eq!(auth.email.as_deref(), Some("reader@example.com"));
    }
}
