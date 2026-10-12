//! Lookup order is the same with or without email and API keys.
//! Configuration only changes User-Agent, mailto, auth headers, and client-side gaps.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::lookup::{
    normalize_arxiv_id, normalize_doi, parse_arxiv_atom, parse_crossref, parse_crossref_query, parse_openalex,
    parse_openalex_single, parse_s2_paper, urlencoding_min, LookupHit,
};

pub const ARXIV_GAP: Duration = Duration::from_secs(3);
pub const S2_CONFIGURED_GAP: Duration = Duration::from_secs(1);
const BACKOFF: Duration = Duration::from_secs(1);
const CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const S2_FIELDS: &str = "title,year,abstract,venue,externalIds,authors,authors.affiliations,openAccessPdf";

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
    fn get(&self, request: &HttpRequest) -> impl std::future::Future<Output = Result<HttpResponse, String>> + Send;
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

impl OpenAlexBudget {
    pub fn search_blocked(&self) -> bool {
        self.remaining_usd.is_some_and(|value| value < 0.001)
    }
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
        Self { entries: HashMap::new(), ttl }
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
    email.map(str::trim).filter(|value| value.contains('@') && !value.contains(char::is_whitespace))
}

pub fn redact_url(url: &str) -> String {
    let Some((path, query)) = url.split_once('?') else {
        return url.to_string();
    };
    let kept: Vec<&str> = query
        .split('&')
        .filter(|pair| !pair.split('=').next().unwrap_or("").eq_ignore_ascii_case("api_key"))
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
    headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
}

fn cache_key(arxiv_id: Option<&str>, doi: Option<&str>, title: Option<&str>) -> Option<String> {
    if let Some(id) = arxiv_id.and_then(normalize_arxiv_id) {
        return Some(format!("arxiv:{}", id.to_ascii_lowercase()));
    }
    if let Some(doi) = doi.and_then(normalize_doi) {
        return Some(format!("doi:{}", doi.to_ascii_lowercase()));
    }
    let title = title.map(str::trim).filter(|value| !value.is_empty())?;
    Some(format!("title:{}", title.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase()))
}

pub fn accepts_ids(hit: &LookupHit, arxiv_id: Option<&str>, doi: Option<&str>) -> bool {
    if let Some(want) = arxiv_id.and_then(normalize_arxiv_id) {
        let Some(got) = hit.arxiv_id.as_deref().and_then(normalize_arxiv_id) else { return false };
        if !got.eq_ignore_ascii_case(&want) {
            return false;
        }
    }
    if let Some(want) = doi.and_then(normalize_doi) {
        let Some(got) = hit.doi.as_deref().and_then(normalize_doi) else { return false };
        if !got.eq_ignore_ascii_case(&want) {
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
        url: format!("https://export.arxiv.org/api/query?id_list={}", urlencoding_min(id)),
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
        url: format!("https://api.openalex.org/works/doi:{}", urlencoding_min(doi)),
        headers: openalex_headers(key),
    }
}

pub fn openalex_search_request(title: &str, key: Option<&str>) -> HttpRequest {
    HttpRequest {
        source: "openalex",
        url: format!("https://api.openalex.org/works?search={}&per-page=5", urlencoding_min(title)),
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
    if notices.iter().any(|item| item.source == source && item.code == code) {
        return;
    }
    notices.push(LookupNotice {
        source: source.into(),
        code: code.into(),
        message: message.into(),
    });
}

fn absorb_budget(budget: &mut OpenAlexBudget, headers: &[(String, String)]) {
    if let Some(value) = header(headers, "x-ratelimit-remaining-usd").and_then(|text| text.parse::<f64>().ok()) {
        budget.remaining_usd = Some(value);
    } else if header(headers, "x-ratelimit-remaining").is_some_and(|text| text.trim() == "0") {
        budget.remaining_usd = Some(0.0);
    }
    if let Some(value) = header(headers, "x-ratelimit-limit-usd").and_then(|text| text.parse::<f64>().ok()) {
        budget.limit_usd = Some(value);
    }
}

fn absorb_crossref_limit(limiter: &mut Limiter, bucket: &str, headers: &[(String, String)]) {
    let Some(limit) = header(headers, "x-rate-limit-limit").and_then(|text| text.parse::<f64>().ok()) else { return };
    if let Some(gap) = gap_from_per_second(limit) {
        limiter.set_gap(bucket, gap);
    }
}

struct LiveFetch;

impl Fetcher for LiveFetch {
    async fn get(&self, request: &HttpRequest) -> Result<HttpResponse, String> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(12))
            .build()
            .map_err(|_| format!("{} 无法发起请求", describe_request(request)))?;
        let mut builder = client.get(&request.url);
        for (key, value) in &request.headers {
            builder = builder.header(key.as_str(), value.as_str());
        }
        let response = builder.send().await.map_err(|_| format!("{} 不可达", describe_request(request)))?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(key, value)| (key.as_str().to_string(), value.to_str().unwrap_or("").to_string()))
            .collect();
        let body = response.text().await.map_err(|_| format!("{} 响应无法读取", describe_request(request)))?;
        Ok(HttpResponse { status, body, headers })
    }
}

struct Gate {
    limiter: Limiter,
    cache: LookupCache,
    budget: OpenAlexBudget,
}

fn gate() -> &'static tokio::sync::Mutex<Gate> {
    static GATE: OnceLock<tokio::sync::Mutex<Gate>> = OnceLock::new();
    GATE.get_or_init(|| {
        tokio::sync::Mutex::new(Gate {
            limiter: Limiter::default(),
            cache: LookupCache::new(CACHE_TTL),
            budget: OpenAlexBudget::default(),
        })
    })
}

static BUDGET: Mutex<OpenAlexBudget> = Mutex::new(OpenAlexBudget { remaining_usd: None, limit_usd: None });

pub fn budget_snapshot() -> OpenAlexBudget {
    BUDGET.lock().unwrap_or_else(|err| err.into_inner()).clone()
}

pub async fn lookup_live(auth: &BiblioAuth, arxiv_id: Option<&str>, doi: Option<&str>, title: Option<&str>) -> LookupOutcome {
    let mut gate = gate().lock().await;
    let mut now = Instant::now();
    let mut sleep = RealSleep;
    let outcome = {
        let Gate { limiter, cache, budget } = &mut *gate;
        execute_lookup(auth, arxiv_id, doi, title, &LiveFetch, limiter, cache, budget, &mut now, &mut sleep).await
    };
    *BUDGET.lock().unwrap_or_else(|err| err.into_inner()) = gate.budget.clone();
    outcome
}

enum FetchFail {
    Status(u16),
    Network,
}

async fn fetch_paced<F: Fetcher, S: Sleeper>(
    fetch: &F,
    sleeper: &mut S,
    limiter: &mut Limiter,
    budget: &mut OpenAlexBudget,
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
            absorb_budget(budget, &response.headers);
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
                return Ok(HttpResponse { status: 404, body: String::new(), headers: response.headers });
            }
            if !(200..300).contains(&response.status) {
                return Err(FetchFail::Status(response.status));
            }
            Ok(response)
        }
        Err(_) => Err(FetchFail::Network),
    }
}

fn fill_missing(base: &mut LookupHit, extra: LookupHit) {
    if base.venue.as_ref().map(|venue| venue.trim().is_empty()).unwrap_or(true) {
        if let Some(venue) = extra.venue.filter(|venue| !venue.trim().is_empty()) {
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

pub async fn execute_lookup<F: Fetcher, S: Sleeper>(
    auth: &BiblioAuth,
    arxiv_id: Option<&str>,
    doi: Option<&str>,
    title: Option<&str>,
    fetch: &F,
    limiter: &mut Limiter,
    cache: &mut LookupCache,
    budget: &mut OpenAlexBudget,
    now: &mut Instant,
    sleeper: &mut S,
) -> LookupOutcome {
    let mut notices = Vec::new();
    let key = cache_key(arxiv_id, doi, title);
    if let Some(key) = key.as_deref() {
        if let Some(hit) = cache.get(key, *now) {
            return LookupOutcome {
                hit: Some(hit),
                notices,
                openalex_remaining_usd: budget.remaining_usd,
                openalex_limit_usd: budget.limit_usd,
            };
        }
    }

    let want_arxiv = arxiv_id.and_then(normalize_arxiv_id);
    let want_doi = doi.and_then(normalize_doi);
    let want_title = title.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string);
    let email = auth.email.as_deref();
    let polite = usable_email(email).is_some();
    let openalex_key = auth.openalex_key.as_deref().filter(|value| !value.trim().is_empty());
    let s2_key = auth.s2_key.as_deref().filter(|value| !value.trim().is_empty());
    let mut hit: Option<LookupHit> = None;

    if let Some(id) = want_arxiv.clone() {
        let request = arxiv_request(&id);
        match fetch_paced(fetch, sleeper, limiter, budget, now, "arxiv", ARXIV_GAP, &request, false).await {
            Ok(response) if !response.body.is_empty() => {
                if let Some(mut parsed) = parse_arxiv_atom(&response.body) {
                    parsed.arxiv_id = Some(id.clone());
                    if parsed.providers.contains_key("arxivId") || parsed.arxiv_id.is_some() {
                        parsed.providers.insert("arxivId".into(), "arxiv".into());
                    }
                    if accepts_ids(&parsed, Some(&id), None) {
                        hit = Some(parsed);
                    }
                }
            }
            Ok(_) => {}
            Err(FetchFail::Network) | Err(FetchFail::Status(_)) => {}
        }
        let request = s2_arxiv_request(&id, s2_key);
        let gap = if s2_key.is_some() { S2_CONFIGURED_GAP } else { Duration::ZERO };
        match fetch_paced(fetch, sleeper, limiter, budget, now, "s2", gap, &request, false).await {
            Ok(response) if !response.body.is_empty() => {
                if let Ok(Some(parsed)) = parse_s2_paper(&response.body) {
                    if accepts_ids(&parsed, Some(&id), None) {
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
                note(&mut notices, "semanticscholar", "busy", "Semantic Scholar 公共通道繁忙，可申请个人 Key");
            }
            Err(_) => {}
        }
    }

    if hit.is_none() {
        if let Some(doi) = want_doi.clone() {
            let request = crossref_work_request(&doi, email);
            match fetch_paced(fetch, sleeper, limiter, budget, now, "crossref-single", crossref_gap(polite, false), &request, true).await {
                Ok(response) if !response.body.is_empty() => {
                    if let Ok(Some(parsed)) = parse_crossref(&response.body) {
                        if accepts_ids(&parsed, None, Some(&doi)) {
                            hit = Some(parsed);
                        }
                    }
                }
                Ok(_) => {}
                Err(FetchFail::Status(429)) if !polite => {
                    note(&mut notices, "crossref", "slow", "Crossref 请求过快，已自动降速；填写邮箱可提速");
                }
                Err(FetchFail::Status(403)) => {
                    note(&mut notices, "crossref", "blocked", "Crossref 可能已限制访问");
                }
                Err(_) => {}
            }
            if hit.is_none() {
                let request = openalex_doi_request(&doi, openalex_key);
                match fetch_paced(fetch, sleeper, limiter, budget, now, "openalex", Duration::ZERO, &request, false).await {
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
            if budget.search_blocked() {
                note(
                    &mut notices,
                    "openalex",
                    "budget",
                    if openalex_key.is_some() {
                        "OpenAlex 今日额度已用完，已改用其他文献库"
                    } else {
                        "OpenAlex 今日免费搜索次数已用完，填写 Key 可提高额度"
                    },
                );
            } else {
                let request = openalex_search_request(&title, openalex_key);
                match fetch_paced(fetch, sleeper, limiter, budget, now, "openalex", Duration::ZERO, &request, false).await {
                    Ok(response) if !response.body.is_empty() => {
                        if let Ok(Some(parsed)) = parse_openalex(&response.body, &title) {
                            if accepts_ids(&parsed, want_arxiv.as_deref(), want_doi.as_deref()) {
                                hit = Some(parsed);
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(FetchFail::Status(429)) => {
                        budget.remaining_usd = Some(0.0);
                        note(
                            &mut notices,
                            "openalex",
                            "budget",
                            if openalex_key.is_some() {
                                "OpenAlex 今日额度已用完，已改用其他文献库"
                            } else {
                                "OpenAlex 今日免费搜索次数已用完，填写 Key 可提高额度"
                            },
                        );
                    }
                    Err(_) => {}
                }
            }
            if hit.is_none() {
                let request = s2_match_request(&title, s2_key);
                let gap = if s2_key.is_some() { S2_CONFIGURED_GAP } else { Duration::ZERO };
                match fetch_paced(fetch, sleeper, limiter, budget, now, "s2", gap, &request, false).await {
                    Ok(response) if !response.body.is_empty() => {
                        if let Ok(Some(parsed)) = parse_s2_paper(&response.body) {
                            if accepts_ids(&parsed, want_arxiv.as_deref(), want_doi.as_deref()) {
                                hit = Some(parsed);
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(FetchFail::Status(429)) if s2_key.is_none() => {
                        note(&mut notices, "semanticscholar", "busy", "Semantic Scholar 公共通道繁忙，可申请个人 Key");
                    }
                    Err(_) => {}
                }
            }
            if hit.is_none() {
                let request = crossref_query_request(&title, email);
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
                        if let Ok(Some(parsed)) = parse_crossref_query(&response.body, &title) {
                            if accepts_ids(&parsed, want_arxiv.as_deref(), want_doi.as_deref()) {
                                hit = Some(parsed);
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(FetchFail::Status(429)) if !polite => {
                        note(&mut notices, "crossref", "slow", "Crossref 请求过快，已自动降速；填写邮箱可提速");
                    }
                    Err(FetchFail::Status(403)) => {
                        note(&mut notices, "crossref", "blocked", "Crossref 可能已限制访问");
                    }
                    Err(_) => {}
                }
            }
        }
    }

    if let (Some(key), Some(found)) = (key, hit.clone()) {
        cache.put(key, *now, found);
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
        Ok(HttpResponse { status: 200, body: body.to_string(), headers: vec![] })
    }

    fn status(code: u16) -> Result<HttpResponse, String> {
        Ok(HttpResponse { status: code, body: String::new(), headers: vec![] })
    }

    fn harness() -> (Limiter, LookupCache, OpenAlexBudget, Instant, RecordSleep) {
        (
            Limiter::default(),
            LookupCache::new(CACHE_TTL),
            OpenAlexBudget::default(),
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
        assert_eq!(user_agent(false, Some("reader@example.com")), user_agent(false, None));

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
        assert!(!crossref.headers.iter().any(|(_, value)| value.contains("mailto")));
        let polite_crossref = crossref_work_request("10.1000/xyz", Some("reader@example.com"));
        assert!(polite_crossref.url.contains("mailto=reader%40example.com"));
        assert!(polite_crossref.headers.iter().any(|(_, value)| value.contains("mailto:reader@example.com")));

        let s2 = s2_match_request("Attention-Is", None);
        assert!(s2.url.contains("Attention%20Is") || s2.url.contains("Attention+Is") || s2.url.contains("Attention%20Is"));
        assert!(!s2.url.to_ascii_lowercase().contains("attention-is"));
        assert!(!s2.headers.iter().any(|(key, _)| key.eq_ignore_ascii_case("x-api-key")));
        let s2_keyed = s2_arxiv_request("1706.03762", Some("s2-secret-key"));
        assert!(!describe_request(&s2_keyed).contains("s2-secret-key"));
        assert!(redact_url("https://api.openalex.org/works?search=a&api_key=oa-secret-key-xyz").contains("search=a"));
        assert!(!redact_url("https://api.openalex.org/works?search=a&api_key=oa-secret-key-xyz").contains("oa-secret"));
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
                ok(include_str!("../fixtures/arxiv-attention.xml")),
                status(404),
            ]),
        };
        let mut sleeper = sleeper;
        execute_lookup(&BiblioAuth::default(), Some("1706.03762"), None, None, &script, &mut limiter, &mut cache, &mut budget, &mut now, &mut sleeper).await;
        cache.entries.clear();
        execute_lookup(&BiblioAuth::default(), Some("1706.03762"), None, None, &script, &mut limiter, &mut cache, &mut budget, &mut now, &mut sleeper).await;
        assert!(sleeper.waits.iter().any(|wait| *wait >= ARXIV_GAP), "{:?}", sleeper.waits);
    }

    #[tokio::test]
    async fn doi_mismatch_falls_through_and_429_does_not_abort() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let wrong = r#"{"display_name":"Other Paper","publication_year":2025,"doi":"https://doi.org/10.65215/2q58a426"}"#;
        let search = r#"{"results":[{"display_name":"Attention Is All You Need","publication_year":2017,"doi":"https://doi.org/10.48550/arXiv.1706.03762"}]}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![status(429), ok(wrong), ok(search)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            None,
            Some("10.48550/arXiv.1706.03762"),
            Some("Attention Is All You Need"),
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let urls: Vec<String> = script.requests.lock().unwrap().iter().map(|request| request.url.clone()).collect();
        assert!(urls[0].contains("api.crossref.org/works/"));
        assert!(!urls[0].contains("mailto"));
        assert!(urls[1].contains("api.openalex.org/works/doi:"));
        assert!(urls[2].contains("api.openalex.org/works?search="));
        let hit = outcome.hit.unwrap();
        assert_eq!(hit.source_name, "openalex");
        assert_eq!(hit.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
        assert!(outcome.notices.iter().any(|notice| notice.code == "slow"));
    }

    #[tokio::test]
    async fn network_error_continues_to_the_next_source() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let right = r#"{"display_name":"Attention Is All You Need","publication_year":2017,"doi":"https://doi.org/10.48550/arXiv.1706.03762"}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![Err("offline".into()), ok(right)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth { email: Some("reader@example.com".into()), ..BiblioAuth::default() },
            None,
            Some("10.48550/arXiv.1706.03762"),
            None,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert_eq!(script.requests.lock().unwrap().len(), 2);
        assert!(script.requests.lock().unwrap()[0].url.contains("mailto=reader%40example.com"));
        assert!(!script.requests.lock().unwrap()[1].url.contains("mailto"));
        assert_eq!(outcome.hit.unwrap().source_name, "openalex");
        assert!(outcome.notices.is_empty());
    }

    #[tokio::test]
    async fn exhausted_openalex_budget_skips_search_and_uses_semantic_scholar() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        budget.remaining_usd = Some(0.0);
        let value: serde_json::Value = serde_json::from_str(include_str!("../fixtures/semanticscholar-attention.json")).unwrap();
        let paper = value["data"][0].to_string();
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![ok(&paper)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            None,
            None,
            Some("Attention Is All You Need"),
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let urls: Vec<String> = script.requests.lock().unwrap().iter().map(|request| request.url.clone()).collect();
        assert!(urls.iter().all(|url| !url.contains("api.openalex.org")), "{urls:?}");
        assert!(urls[0].contains("search/match"));
        assert!(outcome.notices.iter().any(|notice| notice.message.contains("填写 Key")));
        assert_eq!(outcome.hit.unwrap().source_name, "semanticscholar");
    }

    #[tokio::test]
    async fn cache_hit_does_not_repeat_the_request() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![ok(include_str!("../fixtures/arxiv-attention.xml")), status(404)]),
        };
        let auth = BiblioAuth::default();
        let first = execute_lookup(&auth, Some("1706.03762"), None, None, &script, &mut limiter, &mut cache, &mut budget, &mut now, &mut sleeper).await;
        assert!(first.hit.is_some());
        let calls = script.requests.lock().unwrap().len();
        let second = execute_lookup(&auth, Some("1706.03762"), None, None, &script, &mut limiter, &mut cache, &mut budget, &mut now, &mut sleeper).await;
        assert_eq!(script.requests.lock().unwrap().len(), calls);
        assert_eq!(second.hit.unwrap().title, "Attention Is All You Need");
    }

    #[test]
    fn old_style_arxiv_id_is_normalized() {
        assert_eq!(normalize_arxiv_id("hep-th/9901001v2").as_deref(), Some("hep-th/9901001"));
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
            responses: Mutex::new(vec![ok(xml), status(404)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            Some("hep-th/9901001v2"),
            None,
            None,
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
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![ok(include_str!("../fixtures/crossref-attention.json"))]),
        };
        let outcome = execute_lookup(
            &BiblioAuth { email: Some("reader@example.com".into()), ..BiblioAuth::default() },
            None,
            Some("10.48550/arXiv.1706.03762"),
            Some("Attention Is All You Need"),
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
        let right = r#"{"display_name":"Attention Is All You Need","publication_year":2017,"doi":"https://doi.org/10.48550/arXiv.1706.03762"}"#;
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![status(403), ok(right)]),
        };
        let outcome = execute_lookup(
            &BiblioAuth::default(),
            None,
            Some("10.48550/arXiv.1706.03762"),
            None,
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        assert_eq!(outcome.hit.unwrap().source_name, "openalex");
        assert!(outcome.notices.iter().any(|notice| notice.message.contains("限制访问")));
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
        assert!(!requests[1].url.to_ascii_lowercase().contains("attention-is"));
        assert!(!requests[1].headers.iter().any(|(key, _)| key.eq_ignore_ascii_case("x-api-key")));
        assert!(requests[2].url.contains("query.bibliographic"));
        assert!(!requests[2].url.contains("mailto"));
        assert!(outcome.hit.is_none());
        assert!(outcome.notices.iter().any(|notice| notice.message.contains("填写 Key")));
        assert!(outcome.notices.iter().any(|notice| notice.message.contains("个人 Key")));
        assert!(outcome.notices.iter().any(|notice| notice.message.contains("填写邮箱")));
    }

    #[tokio::test]
    async fn configured_title_search_sends_keys_without_logging_them() {
        let (mut limiter, mut cache, mut budget, mut now, mut sleeper) = harness();
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../fixtures/crossref-attention.json")).unwrap();
        let query = serde_json::json!({ "message": { "items": [fixture["message"].clone()] } }).to_string();
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![ok(r#"{"results":[]}"#), status(404), ok(&query)]),
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
            &script,
            &mut limiter,
            &mut cache,
            &mut budget,
            &mut now,
            &mut sleeper,
        )
        .await;
        let requests = script.requests.lock().unwrap().clone();
        assert!(requests[0].headers.iter().any(|(key, value)| key.eq_ignore_ascii_case("authorization") && value == "Bearer oa-secret-key-xyz"));
        assert!(!describe_request(&requests[0]).contains("oa-secret-key-xyz"));
        assert!(!requests[0].url.contains("mailto"));
        assert!(requests[1].headers.iter().any(|(key, value)| key.eq_ignore_ascii_case("x-api-key") && value == "s2-secret-key"));
        assert!(!describe_request(&requests[1]).contains("s2-secret-key"));
        assert!(requests[2].url.contains("mailto=reader%40example.com"));
        assert!(!outcome.notices.iter().any(|notice| notice.message.contains("个人 Key")));
        assert_eq!(outcome.hit.unwrap().source_name, "crossref");
    }

    #[tokio::test]
    async fn crossref_rate_limit_header_spaces_the_next_request() {
        let (mut limiter, mut cache, mut budget, mut now, sleeper) = harness();
        let limited = HttpResponse {
            status: 200,
            body: include_str!("../fixtures/crossref-attention.json").to_string(),
            headers: vec![("x-rate-limit-limit".into(), "2".into())],
        };
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![Ok(limited.clone()), Ok(limited)]),
        };
        let mut sleeper = sleeper;
        let auth = BiblioAuth::default();
        execute_lookup(&auth, None, Some("10.48550/arXiv.1706.03762"), None, &script, &mut limiter, &mut cache, &mut budget, &mut now, &mut sleeper).await;
        cache.entries.clear();
        execute_lookup(&auth, None, Some("10.48550/arXiv.1706.03762"), None, &script, &mut limiter, &mut cache, &mut budget, &mut now, &mut sleeper).await;
        assert!(sleeper.waits.iter().any(|wait| *wait >= Duration::from_millis(500)), "{:?}", sleeper.waits);
    }

    #[tokio::test]
    async fn configured_semantic_scholar_requests_are_spaced_by_one_second() {
        let (mut limiter, mut cache, mut budget, mut now, sleeper) = harness();
        budget.remaining_usd = Some(0.0);
        let value: serde_json::Value = serde_json::from_str(include_str!("../fixtures/semanticscholar-attention.json")).unwrap();
        let paper = value["data"][0].to_string();
        let script = Script {
            requests: Mutex::new(vec![]),
            responses: Mutex::new(vec![status(404), status(404), ok(&paper)]),
        };
        let auth = BiblioAuth { s2_key: Some("s2-secret-key".into()), ..BiblioAuth::default() };
        let mut sleeper = sleeper;
        execute_lookup(&auth, None, None, Some("Attention Is All You Need"), &script, &mut limiter, &mut cache, &mut budget, &mut now, &mut sleeper).await;
        execute_lookup(&auth, None, None, Some("Attention Is All You Need"), &script, &mut limiter, &mut cache, &mut budget, &mut now, &mut sleeper).await;
        assert!(sleeper.waits.iter().any(|wait| *wait >= S2_CONFIGURED_GAP), "{:?}", sleeper.waits);
        let requests = script.requests.lock().unwrap().clone();
        let s2: Vec<_> = requests.iter().filter(|request| request.source == "semanticscholar").collect();
        assert_eq!(s2.len(), 2);
        assert!(s2.iter().all(|request| request.url.contains("search/match")));
        assert!(s2.iter().all(|request| !describe_request(request).contains("s2-secret-key")));
    }
}
