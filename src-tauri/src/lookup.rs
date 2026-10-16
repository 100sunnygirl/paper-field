//! Bibliographic lookup parsers. Network order, rate limits, and credentials live in lookup_run.
//! A miss, 429, or mismatch is not fatal: the command still returns whatever later sources found.
#![deny(clippy::string_slice)]

use std::collections::HashMap;
use std::time::Duration;

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

/// At least one of character 3-gram Dice and normalized Levenshtein must reach this.
/// 0.90 is the calibrated bar: punctuation and case fold to an exact match first, and a
/// one-character edit on a real title still clears 0.90 on Levenshtein.
pub const TITLE_SIMILARITY_HIGH: f64 = 0.90;
/// The other measure must clear this. A word-order swap can still score ~0.84 on 3-grams
/// while Levenshtein collapses (~0.14); unrelated overlaps stay under 0.70 on both.
/// A one-character Chinese edit drops Dice to ~0.70 and keeps Levenshtein above 0.90.
pub const TITLE_SIMILARITY_FLOOR: f64 = 0.70;
/// `min(len) / max(len)` below this is a different title (added subtitle or clause).
pub const TITLE_LENGTH_RATIO_MIN: f64 = 0.85;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookupAuthor {
    pub name: String,
    pub affiliation: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LookupHit {
    pub title: String,
    pub r#abstract: String,
    pub year: Option<i32>,
    pub venue: Option<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
    pub pdf_url: Option<String>,
    pub authors: Vec<LookupAuthor>,
    pub confidence: f64,
    pub source_name: String,
    /// Meta field name → bibliographic service id (arxiv, crossref, openalex, semanticscholar).
    #[serde(default)]
    pub providers: HashMap<String, String>,
}

/// Title plus the identifiers used as hard checks. Year and author names corroborate a fuzzy match.
#[derive(Clone, Debug)]
pub struct TitleQuery {
    pub title: String,
    pub year: Option<i32>,
    pub authors: Vec<String>,
    pub doi: Option<String>,
    pub arxiv_id: Option<String>,
}

impl TitleQuery {
    #[cfg(test)]
    pub fn title_only(title: &str) -> Self {
        Self {
            title: title.to_string(),
            year: None,
            authors: Vec::new(),
            doi: None,
            arxiv_id: None,
        }
    }
}

/// NFKC, lowercase, then drop punctuation, dashes, quotes, and whitespace.
/// "Well—Known" and "well known" share one key; Chinese titles stay as characters.
pub fn normalize_title(value: &str) -> String {
    value
        .nfkc()
        .collect::<String>()
        .to_lowercase()
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .collect()
}

/// NFKC, drop whitespace, then lowercase. Title-only cache keys join these with U+001F.
pub fn normalize_author_token(name: &str) -> String {
    name.nfkc()
        .collect::<String>()
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect::<String>()
        .to_lowercase()
}

pub fn titles_match(query: &TitleQuery, hit: &LookupHit) -> Option<f64> {
    let left = normalize_title(&query.title);
    let right = normalize_title(&hit.title);
    if left.is_empty() || right.is_empty() {
        return None;
    }
    if identifiers_conflict(query, hit) {
        return None;
    }
    let same_ids = identifiers_match(query, hit);
    if years_conflict(query.year, hit.year, same_ids) {
        return None;
    }
    if left == right {
        // 精确相等也要佐证：PDF 文件名来的 untitled / main 会撞上随便一条记录
        let trusted =
            same_ids || corroborated(query, hit) || distinctive_title(&query.title, &left);
        return trusted.then_some(1.0);
    }
    let score = fuzzy_title_score(&left, &right)?;
    if !corroborated(query, hit) {
        return None;
    }
    Some(score)
}

/// 标题本身够长才算独特：拉丁文 ≥4 个词或 ≥24 个字符，中日韩 ≥8 个字。
fn distinctive_title(raw: &str, normalized: &str) -> bool {
    let chars = normalized.chars().count();
    if normalized.chars().any(is_cjk_script) {
        return chars >= 8;
    }
    let words = raw
        .nfkc()
        .collect::<String>()
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .count();
    words >= 4 || chars >= 24
}

fn is_cjk_script(ch: char) -> bool {
    is_cjk(ch) || matches!(ch, '\u{3040}'..='\u{30FF}' | '\u{AC00}'..='\u{D7AF}')
}

fn fuzzy_title_score(left: &str, right: &str) -> Option<f64> {
    let ratio = length_ratio(left, right);
    if ratio + f64::EPSILON < TITLE_LENGTH_RATIO_MIN {
        return None;
    }
    let dice = char_trigram_dice(left, right);
    let edit = normalized_levenshtein(left, right);
    if dice.max(edit) + f64::EPSILON < TITLE_SIMILARITY_HIGH {
        return None;
    }
    if dice.min(edit) + f64::EPSILON < TITLE_SIMILARITY_FLOOR {
        return None;
    }
    Some((dice + edit) / 2.0)
}

fn length_ratio(left: &str, right: &str) -> f64 {
    let left_len = left.chars().count();
    let right_len = right.chars().count();
    if left_len == 0 || right_len == 0 {
        return 0.0;
    }
    left_len.min(right_len) as f64 / left_len.max(right_len) as f64
}

fn char_trigram_dice(left: &str, right: &str) -> f64 {
    let left_grams = trigrams(left);
    let right_grams = trigrams(right);
    if left_grams.is_empty() || right_grams.is_empty() {
        return 0.0;
    }
    let left_n: usize = left_grams.values().sum();
    let right_n: usize = right_grams.values().sum();
    let mut inter = 0usize;
    for (gram, count) in &left_grams {
        if let Some(other) = right_grams.get(gram) {
            inter += (*count).min(*other);
        }
    }
    (2.0 * inter as f64) / (left_n + right_n) as f64
}

fn trigrams(value: &str) -> HashMap<String, usize> {
    let chars: Vec<char> = value.chars().collect();
    let mut grams = HashMap::new();
    if chars.len() < 3 {
        return grams;
    }
    for window in chars.windows(3) {
        let gram: String = window.iter().collect();
        *grams.entry(gram).or_insert(0) += 1;
    }
    grams
}

fn normalized_levenshtein(left: &str, right: &str) -> f64 {
    let left: Vec<char> = left.chars().collect();
    let right: Vec<char> = right.chars().collect();
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let mut prev: Vec<usize> = (0..=right.len()).collect();
    let mut curr = vec![0; right.len() + 1];
    for (i, left_ch) in left.iter().enumerate() {
        curr[0] = i + 1;
        for (j, right_ch) in right.iter().enumerate() {
            let cost = usize::from(left_ch != right_ch);
            curr[j + 1] = (curr[j] + 1).min(prev[j + 1] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    let dist = prev[right.len()] as f64;
    1.0 - dist / left.len().max(right.len()) as f64
}

fn identifiers_conflict(query: &TitleQuery, hit: &LookupHit) -> bool {
    if let (Some(want), Some(got)) = (
        parsed_doi(query.doi.as_deref()),
        parsed_doi(hit.doi.as_deref()),
    ) {
        if want != got {
            return true;
        }
    }
    if let (Some(want), Some(got)) = (
        canonical_arxiv(query.doi.as_deref(), query.arxiv_id.as_deref()),
        canonical_arxiv(hit.doi.as_deref(), hit.arxiv_id.as_deref()),
    ) {
        if want != got {
            return true;
        }
    }
    false
}

fn identifiers_match(query: &TitleQuery, hit: &LookupHit) -> bool {
    let doi_match = match (
        parsed_doi(query.doi.as_deref()),
        parsed_doi(hit.doi.as_deref()),
    ) {
        (Some(want), Some(got)) => want == got,
        _ => false,
    };
    let arxiv_match = match (
        canonical_arxiv(query.doi.as_deref(), query.arxiv_id.as_deref()),
        canonical_arxiv(hit.doi.as_deref(), hit.arxiv_id.as_deref()),
    ) {
        (Some(want), Some(got)) => want == got,
        _ => false,
    };
    doi_match || arxiv_match
}

fn parsed_doi(value: Option<&str>) -> Option<Doi> {
    value.and_then(Doi::parse)
}

fn canonical_arxiv(doi: Option<&str>, arxiv_id: Option<&str>) -> Option<ArxivId> {
    arxiv_id
        .and_then(ArxivId::parse)
        .or_else(|| parsed_doi(doi).as_ref().and_then(ArxivId::from_doi))
}

fn years_conflict(query: Option<i32>, candidate: Option<i32>, ids_match: bool) -> bool {
    match (query, candidate) {
        (Some(left), Some(right)) => (left - right).abs() > 1 && !ids_match,
        _ => false,
    }
}

fn corroborated(query: &TitleQuery, hit: &LookupHit) -> bool {
    year_within_one(query.year, hit.year) || author_overlap(&query.authors, &hit.authors)
}

fn year_within_one(query: Option<i32>, candidate: Option<i32>) -> bool {
    match (query, candidate) {
        (Some(left), Some(right)) => (left - right).abs() <= 1,
        _ => false,
    }
}

fn author_overlap(query: &[String], candidate: &[LookupAuthor]) -> bool {
    let left: Vec<String> = query
        .iter()
        .take(2)
        .flat_map(|name| surname_keys(name))
        .collect();
    let right: Vec<String> = candidate
        .iter()
        .take(2)
        .flat_map(|author| surname_keys(&author.name))
        .collect();
    left.iter()
        .any(|key| right.iter().any(|other| key == other))
}

fn surname_keys(name: &str) -> Vec<String> {
    let normalized = normalize_person(name);
    if normalized.is_empty() {
        return Vec::new();
    }
    if let Some((family, _)) = normalized.split_once(',') {
        let family = family.trim();
        if family.is_empty() {
            return Vec::new();
        }
        return vec![family.to_string()];
    }
    let parts: Vec<&str> = normalized.split_whitespace().collect();
    if parts.len() >= 2 {
        let last = parts[parts.len() - 1];
        if last.chars().count() == 1 && parts[0].chars().count() > 1 {
            return vec![parts[0].to_string()];
        }
        return vec![last.to_string()];
    }
    let token = parts[0];
    if token.chars().count() >= 2 && token.chars().all(is_cjk) {
        let surname = token.chars().next().unwrap().to_string();
        return vec![surname, token.to_string()];
    }
    vec![token.to_string()]
}

fn normalize_person(value: &str) -> String {
    let folded = value.nfkc().collect::<String>().to_lowercase();
    let mut out = String::new();
    let mut pending_space = false;
    for ch in folded.chars() {
        if ch.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(ch);
        } else if ch == ',' {
            pending_space = false;
            if !out.is_empty() && !out.ends_with(',') {
                out.push(',');
            }
        } else {
            pending_space = true;
        }
    }
    out.trim().trim_matches(',').trim().to_string()
}

fn is_cjk(ch: char) -> bool {
    matches!(ch, '\u{3400}'..='\u{9FFF}' | '\u{F900}'..='\u{FAFF}')
}

/// 两端去掉空白（含全角空格 U+3000、不换行空格 U+00A0）和零宽字符。
fn trim_id(raw: &str) -> &str {
    raw.trim_matches(|ch: char| ch.is_whitespace() || matches!(ch, '\u{200b}' | '\u{feff}'))
}

/// 忽略 ASCII 大小写去前缀。用 get 取片段：落在多字节字符中间时返回 None，不会 panic。
fn strip_prefix_ci<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let head = value.get(..prefix.len())?;
    if head.eq_ignore_ascii_case(prefix) {
        value.get(prefix.len()..)
    } else {
        None
    }
}

fn strip_suffix_ci<'a>(value: &'a str, suffix: &str) -> Option<&'a str> {
    let at = value.len().checked_sub(suffix.len())?;
    let tail = value.get(at..)?;
    if tail.eq_ignore_ascii_case(suffix) {
        value.get(..at)
    } else {
        None
    }
}

/// `doi:` / `arXiv：` 这类标签：名字忽略大小写，冒号可以是全角，前后可有空格。
fn strip_label<'a>(value: &'a str, label: &str) -> Option<&'a str> {
    let rest = strip_prefix_ci(value, label)?.trim_start();
    let rest = rest.strip_prefix(':').or_else(|| rest.strip_prefix('：'))?;
    Some(rest.trim_start())
}

/// 去掉可选的 http(s):// 和 www. 后，以某个 `host/` 开头时返回其后的路径。
fn strip_host<'a>(value: &'a str, hosts: &[&str]) -> Option<&'a str> {
    let rest = strip_prefix_ci(value, "https://")
        .or_else(|| strip_prefix_ci(value, "http://"))
        .unwrap_or(value);
    let rest = strip_prefix_ci(rest, "www.").unwrap_or(rest);
    hosts.iter().find_map(|host| strip_prefix_ci(rest, host))
}

/// 去掉版本号的 arXiv id：新式 `2401.01234` 或旧式 `hep-th/9901001`。按原样保存，比较时忽略大小写。
#[derive(Clone, Debug)]
pub struct ArxivId(String);

impl ArxivId {
    /// 接受 `arXiv:`（冒号可全角）、arxiv.org 的 abs/pdf 链接、`.pdf` 结尾和 vN 版本号；任何输入都不会 panic。
    pub fn parse(raw: &str) -> Option<Self> {
        // NFKC 把全角冒号、全角数字、U+3000 折成 ASCII
        let folded: String = raw.nfkc().collect();
        let mut id = trim_id(&folded);
        if let Some(rest) = strip_label(id, "arxiv") {
            id = rest;
        }
        if let Some(path) = strip_host(id, &["arxiv.org/", "export.arxiv.org/"]) {
            let rest = strip_prefix_ci(path, "abs/").or_else(|| strip_prefix_ci(path, "pdf/"))?;
            id = rest
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .trim_end_matches('/');
        }
        let id = strip_suffix_ci(id, ".pdf").unwrap_or(id);
        let id = strip_arxiv_version(id);
        (is_new_arxiv(id) || is_old_arxiv(id)).then(|| Self(id.to_string()))
    }

    /// `10.48550/arXiv.1706.03762` 是 arXiv 自己登记的 DOI，Crossref 查不到。
    pub fn from_doi(doi: &Doi) -> Option<Self> {
        Self::parse(strip_prefix_ci(doi.as_str(), "10.48550/arxiv.")?)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl PartialEq for ArxivId {
    fn eq(&self, other: &Self) -> bool {
        self.0.eq_ignore_ascii_case(&other.0)
    }
}

/// 以 `10.` 开头、含 `/`、不含空白的 DOI。后缀按原样保存，比较时忽略大小写。
#[derive(Clone, Debug)]
pub struct Doi(String);

impl Doi {
    /// 接受 `doi:` 标签和 doi.org / dx.doi.org / www.doi.org 链接（有无协议、大小写都行）。
    pub fn parse(raw: &str) -> Option<Self> {
        let mut doi = trim_id(raw);
        if let Some(rest) = strip_label(doi, "doi") {
            doi = rest;
        }
        if let Some(rest) = strip_host(doi, &["doi.org/", "dx.doi.org/"]) {
            doi = rest;
        }
        let (registrant, suffix) = doi.split_once('/')?;
        let valid = registrant
            .strip_prefix("10.")
            .is_some_and(|code| !code.is_empty())
            && !suffix.is_empty()
            && !doi.chars().any(char::is_whitespace);
        valid.then(|| Self(doi.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn into_string(self) -> String {
        self.0
    }
}

impl PartialEq for Doi {
    fn eq(&self, other: &Self) -> bool {
        self.0.eq_ignore_ascii_case(&other.0)
    }
}

pub fn normalize_arxiv_id(value: &str) -> Option<String> {
    ArxivId::parse(value).map(ArxivId::into_string)
}

fn strip_arxiv_version(id: &str) -> &str {
    let Some(index) = id.rfind(['v', 'V']) else {
        return id;
    };
    match (id.get(..index), id.get(index + 1..)) {
        (Some(head), Some(digits))
            if !head.is_empty()
                && !digits.is_empty()
                && digits.chars().all(|ch| ch.is_ascii_digit()) =>
        {
            head
        }
        _ => id,
    }
}

fn is_new_arxiv(id: &str) -> bool {
    let mut parts = id.split('.');
    let year = parts.next().unwrap_or("");
    let number = parts.next().unwrap_or("");
    parts.next().is_none()
        && year.len() == 4
        && year.chars().all(|ch| ch.is_ascii_digit())
        && (4..=5).contains(&number.len())
        && number.chars().all(|ch| ch.is_ascii_digit())
}

fn is_old_arxiv(id: &str) -> bool {
    let Some((archive, number)) = id.split_once('/') else {
        return false;
    };
    !archive.is_empty()
        && archive
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '.')
        && number.len() >= 7
        && number.chars().all(|ch| ch.is_ascii_digit())
}

pub fn normalize_doi(value: &str) -> Option<String> {
    Doi::parse(value).map(Doi::into_string)
}

fn is_http_url(value: &str) -> bool {
    let value = value.trim();
    strip_prefix_ci(value, "https://")
        .or_else(|| strip_prefix_ci(value, "http://"))
        .is_some_and(|rest| !rest.is_empty())
}

fn clean_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 单遍解码，`&amp;lt;` 只解一层得到 `&lt;`；不认识的实体原样保留。
fn decode_entities(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some((before, after)) = rest.split_once('&') {
        out.push_str(before);
        let decoded = after
            .split_once(';')
            .filter(|(name, _)| name.len() <= 10)
            .and_then(|(name, tail)| entity_char(name).map(|ch| (ch, tail)));
        match decoded {
            Some((ch, tail)) => {
                out.push(ch);
                rest = tail;
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn entity_char(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => {
            let code = name.strip_prefix('#')?;
            let value = match code.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => code.parse::<u32>().ok()?,
            };
            char::from_u32(value).filter(|ch| !ch.is_control() || ch.is_whitespace())
        }
    }
}

/// `<` 后面紧跟字母、`/`、`!`、`?` 且后文有 `>` 才算标签，`p < 0.05` 原样保留。
/// 段落类标签换成空格，行内标签（`<i>`、`<sub>`）直接去掉。
fn remove_tags(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some((before, after)) = rest.split_once('<') {
        out.push_str(before);
        let opens_tag = after
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic() || matches!(ch, '/' | '!' | '?'));
        match after.split_once('>').filter(|_| opens_tag) {
            Some((tag, tail)) => {
                if is_block_tag(tag) {
                    out.push(' ');
                }
                rest = tail;
            }
            None => {
                out.push('<');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn is_block_tag(tag: &str) -> bool {
    let name = tag
        .trim_start_matches('/')
        .split(|ch: char| ch.is_whitespace() || ch == '/')
        .next()
        .unwrap_or("");
    let local = name.rsplit(':').next().unwrap_or(name).to_ascii_lowercase();
    matches!(
        local.as_str(),
        "p" | "br" | "div" | "li" | "title" | "sec" | "list-item" | "tr" | "td"
    )
}

/// 先去标签再解实体：`&lt;` 解出来的 `<` 留在正文里，不会再被当成标签删掉。
fn strip_tags(value: &str) -> String {
    clean_text(&decode_entities(&remove_tags(value)))
}

fn finish(mut hit: LookupHit) -> LookupHit {
    let source = hit.source_name.clone();
    let mut providers = HashMap::new();
    if !hit.title.trim().is_empty() {
        providers.insert("title".into(), source.clone());
    }
    if !hit.r#abstract.trim().is_empty() {
        providers.insert("abstract".into(), source.clone());
    }
    if hit.year.is_some() {
        providers.insert("year".into(), source.clone());
    }
    if hit
        .venue
        .as_ref()
        .is_some_and(|venue| !venue.trim().is_empty())
    {
        providers.insert("venue".into(), source.clone());
    }
    if hit.doi.is_some() {
        providers.insert("doi".into(), source.clone());
    }
    if hit.arxiv_id.is_some() {
        providers.insert("arxivId".into(), source.clone());
    }
    if hit.pdf_url.is_some() {
        providers.insert("pdfUrl".into(), source.clone());
    }
    if !hit.authors.is_empty() {
        providers.insert("authors".into(), source);
    }
    hit.providers = providers;
    hit
}

fn xml_blocks(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut blocks = Vec::new();
    let mut rest = xml;
    while let Some((_, after)) = rest.split_once(open.as_str()) {
        let Some((_, body)) = after.split_once('>') else {
            break;
        };
        let Some((inner, tail)) = body.split_once(close.as_str()) else {
            break;
        };
        blocks.push(inner.to_string());
        rest = tail;
    }
    blocks
}

fn xml_text(block: &str, tag: &str) -> Option<String> {
    xml_blocks(block, tag)
        .into_iter()
        .next()
        .map(|text| strip_tags(&text))
}

/// arXiv 出错时仍回 200：唯一一条 entry 的 id 指向 /api/errors，标题是 Error，作者是 arXiv api core。
pub fn is_arxiv_error_feed(xml: &str) -> bool {
    let Some(entry) = xml_blocks(xml, "entry").into_iter().next() else {
        return false;
    };
    let id = xml_text(&entry, "id").unwrap_or_default();
    if id.to_ascii_lowercase().contains("/api/errors") {
        return true;
    }
    let title = xml_text(&entry, "title").unwrap_or_default();
    title.eq_ignore_ascii_case("error")
        && xml_blocks(&entry, "author").iter().any(|author| {
            xml_text(author, "name").is_some_and(|name| name.eq_ignore_ascii_case("arxiv api core"))
        })
}

/// `arxiv_id` 取自响应里的 `<id>`，调用方拿它和请求的 id 比对。错误条目不算命中。
pub fn parse_arxiv_atom(xml: &str) -> Option<LookupHit> {
    if is_arxiv_error_feed(xml) {
        return None;
    }
    let entry = xml_blocks(xml, "entry").into_iter().next()?;
    let title = xml_text(&entry, "title").filter(|title| !title.is_empty())?;
    let summary = xml_text(&entry, "summary").unwrap_or_default();
    let published = xml_text(&entry, "published").unwrap_or_default();
    let year = published
        .get(0..4)
        .and_then(|text| text.parse::<i32>().ok());
    let id_raw = xml_text(&entry, "id").unwrap_or_default();
    let arxiv_id = normalize_arxiv_id(&id_raw);
    let doi = xml_blocks(&entry, "arxiv:doi")
        .into_iter()
        .next()
        .and_then(|text| normalize_doi(&strip_tags(&text)));
    let venue = xml_blocks(&entry, "arxiv:journal_ref")
        .into_iter()
        .next()
        .map(|text| strip_tags(&text))
        .filter(|text| !text.is_empty());
    let mut authors = Vec::new();
    for author in xml_blocks(&entry, "author") {
        let Some(name) = xml_text(&author, "name").filter(|name| !name.is_empty()) else {
            continue;
        };
        let affiliation = xml_blocks(&author, "arxiv:affiliation")
            .into_iter()
            .next()
            .map(|text| strip_tags(&text))
            .filter(|text| !text.is_empty());
        authors.push(LookupAuthor { name, affiliation });
    }
    let pdf_url = entry
        .split("href=\"")
        .skip(1)
        .filter_map(|part| part.split('"').next())
        .find(|href| href.contains("/pdf/"))
        .map(|href| href.to_string())
        .filter(|href| is_http_url(href));
    Some(finish(LookupHit {
        title,
        r#abstract: summary,
        year,
        venue,
        doi,
        arxiv_id,
        pdf_url,
        authors,
        confidence: 1.0,
        source_name: "arxiv".into(),
        providers: HashMap::new(),
    }))
}

pub fn parse_crossref(body: &str) -> Result<Option<LookupHit>, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("Crossref 响应无法解析：{err}"))?;
    let message = &value["message"];
    if message.is_null() {
        return Ok(None);
    }
    // Crossref 标题带行内标记，如 `Structure of <i>E. coli</i>`
    let title = message["title"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(strip_tags)
        .filter(|title| !title.is_empty());
    let Some(title) = title else { return Ok(None) };
    let year = message["published"]["date-parts"][0][0]
        .as_i64()
        .or_else(|| message["issued"]["date-parts"][0][0].as_i64())
        .map(|year| year as i32);
    let venue = message["container-title"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(|text| text.to_string());
    let doi = message["DOI"].as_str().and_then(normalize_doi);
    let abstract_text = message["abstract"]
        .as_str()
        .map(strip_tags)
        .unwrap_or_default();
    let mut authors = Vec::new();
    if let Some(list) = message["author"].as_array() {
        for author in list {
            let name = match (author["given"].as_str(), author["family"].as_str()) {
                (Some(given), Some(family)) => format!("{given} {family}"),
                (None, Some(family)) => family.to_string(),
                (Some(given), None) => given.to_string(),
                _ => author["name"].as_str().unwrap_or("").to_string(),
            };
            if name.trim().is_empty() {
                continue;
            }
            let affiliation = author["affiliation"]
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item["name"].as_str())
                .map(|text| text.to_string());
            authors.push(LookupAuthor {
                name: clean_text(&name),
                affiliation,
            });
        }
    }
    let pdf_url = message["link"]
        .as_array()
        .and_then(|links| {
            links.iter().find_map(|link| {
                let url = link["URL"].as_str()?;
                let kind = link["content-type"].as_str().unwrap_or("");
                if kind.contains("pdf") || url.contains("pdf") {
                    Some(url.to_string())
                } else {
                    None
                }
            })
        })
        .filter(|url| is_http_url(url));
    Ok(Some(finish(LookupHit {
        title,
        r#abstract: abstract_text,
        year,
        venue: venue
            .map(|text| clean_text(&text))
            .filter(|text| !text.is_empty()),
        doi,
        arxiv_id: None,
        pdf_url,
        authors,
        confidence: 1.0,
        source_name: "crossref".into(),
        providers: HashMap::new(),
    })))
}

pub fn parse_crossref_query(body: &str, query: &TitleQuery) -> Result<Option<LookupHit>, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("Crossref 响应无法解析：{err}"))?;
    let Some(items) = value["message"]["items"].as_array() else {
        return Ok(None);
    };
    let mut best: Option<LookupHit> = None;
    for item in items {
        let wrapped = serde_json::json!({ "message": item });
        let Ok(Some(hit)) = parse_crossref(&wrapped.to_string()) else {
            continue;
        };
        let Some(hit) = scored(query, hit) else {
            continue;
        };
        if best
            .as_ref()
            .map(|current| hit.confidence > current.confidence)
            .unwrap_or(true)
        {
            best = Some(hit);
        }
    }
    Ok(best)
}

fn scored(query: &TitleQuery, mut hit: LookupHit) -> Option<LookupHit> {
    hit.confidence = titles_match(query, &hit)?;
    Some(hit)
}

fn inverted_abstract(index: &Value) -> String {
    let Some(map) = index.as_object() else {
        return String::new();
    };
    let mut words: Vec<(usize, &str)> = Vec::new();
    for (word, positions) in map {
        if let Some(list) = positions.as_array() {
            for position in list {
                if let Some(index) = position.as_u64() {
                    words.push((index as usize, word));
                }
            }
        }
    }
    words.sort_by_key(|item| item.0);
    words
        .into_iter()
        .map(|item| item.1)
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn parse_openalex(body: &str, query: &TitleQuery) -> Result<Option<LookupHit>, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("OpenAlex 响应无法解析：{err}"))?;
    let Some(results) = value["results"].as_array() else {
        return Ok(None);
    };
    let mut best: Option<LookupHit> = None;
    for result in results {
        let Some(hit) = openalex_hit(result) else {
            continue;
        };
        let Some(hit) = scored(query, hit) else {
            continue;
        };
        if best
            .as_ref()
            .map(|current| hit.confidence > current.confidence)
            .unwrap_or(true)
        {
            best = Some(hit);
        }
    }
    Ok(best)
}

fn openalex_hit(result: &Value) -> Option<LookupHit> {
    // display_name 和 Crossref 一样会带 <i>、<sub> 之类的标记
    let title = result["display_name"].as_str().map(strip_tags)?;
    let mut authors = Vec::new();
    if let Some(list) = result["authorships"].as_array() {
        for authorship in list {
            let Some(name) = authorship["author"]["display_name"].as_str() else {
                continue;
            };
            let affiliation = authorship["institutions"]
                .as_array()
                .and_then(|items| items.first())
                .and_then(|item| item["display_name"].as_str())
                .map(|text| text.to_string());
            authors.push(LookupAuthor {
                name: name.to_string(),
                affiliation,
            });
        }
    }
    let pdf_url = result["primary_location"]["pdf_url"]
        .as_str()
        .or_else(|| result["open_access"]["oa_url"].as_str())
        .filter(|url| is_http_url(url))
        .map(|url| url.to_string());
    Some(finish(LookupHit {
        title,
        r#abstract: inverted_abstract(&result["abstract_inverted_index"]),
        year: result["publication_year"].as_i64().map(|year| year as i32),
        venue: result["primary_location"]["source"]["display_name"]
            .as_str()
            .map(clean_text)
            .filter(|text| !text.is_empty()),
        doi: result["doi"].as_str().and_then(normalize_doi),
        arxiv_id: None,
        pdf_url,
        authors,
        confidence: 0.0,
        source_name: "openalex".into(),
        providers: HashMap::new(),
    }))
}

/// 按 id 取回的单条记录不比标题，由调用方用 DOI / arXiv id 核对。
fn by_identifier(hit: Option<LookupHit>) -> Option<LookupHit> {
    hit.filter(|item| !normalize_title(&item.title).is_empty())
        .map(|mut item| {
            item.confidence = 1.0;
            item
        })
}

pub fn parse_openalex_single(body: &str) -> Result<Option<LookupHit>, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("OpenAlex 响应无法解析：{err}"))?;
    Ok(by_identifier(openalex_hit(&value)))
}

pub fn parse_semantic_scholar(body: &str, query: &TitleQuery) -> Result<Option<LookupHit>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| format!("Semantic Scholar 响应无法解析：{err}"))?;
    let Some(results) = value["data"].as_array() else {
        return Ok(None);
    };
    let mut best: Option<LookupHit> = None;
    for result in results {
        let Some(hit) = s2_hit(result) else {
            continue;
        };
        let Some(hit) = scored(query, hit) else {
            continue;
        };
        if best
            .as_ref()
            .map(|current| hit.confidence > current.confidence)
            .unwrap_or(true)
        {
            best = Some(hit);
        }
    }
    Ok(best)
}

fn s2_hit(result: &Value) -> Option<LookupHit> {
    let title = result["title"].as_str().map(clean_text)?;
    let mut authors = Vec::new();
    if let Some(list) = result["authors"].as_array() {
        for author in list {
            let Some(name) = author["name"].as_str() else {
                continue;
            };
            let affiliation = author["affiliations"]
                .as_array()
                .and_then(|items| items.first())
                .and_then(Value::as_str)
                .map(|text| text.to_string());
            authors.push(LookupAuthor {
                name: name.to_string(),
                affiliation,
            });
        }
    }
    Some(finish(LookupHit {
        title,
        r#abstract: clean_text(result["abstract"].as_str().unwrap_or("")),
        year: result["year"].as_i64().map(|year| year as i32),
        venue: result["venue"]
            .as_str()
            .map(clean_text)
            .filter(|text| !text.is_empty()),
        doi: result["externalIds"]["DOI"]
            .as_str()
            .and_then(normalize_doi),
        arxiv_id: result["externalIds"]["ArXiv"]
            .as_str()
            .and_then(normalize_arxiv_id),
        pdf_url: result["openAccessPdf"]["url"]
            .as_str()
            .filter(|url| is_http_url(url))
            .map(|url| url.to_string()),
        authors,
        confidence: 0.0,
        source_name: "semanticscholar".into(),
        providers: HashMap::new(),
    }))
}

pub fn parse_s2_paper(body: &str) -> Result<Option<LookupHit>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| format!("Semantic Scholar 响应无法解析：{err}"))?;
    Ok(by_identifier(s2_hit(&value)))
}

/// `/paper/search/match` returns `{ "data": [ paper, ... ] }`. A bare paper object is accepted too.
pub fn parse_s2_match(body: &str, query: &TitleQuery) -> Result<Option<LookupHit>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| format!("Semantic Scholar 响应无法解析：{err}"))?;
    let wrapped = if value.get("data").and_then(Value::as_array).is_some() {
        value
    } else if value.get("title").and_then(Value::as_str).is_some() {
        serde_json::json!({ "data": [value] })
    } else {
        return Ok(None);
    };
    parse_semantic_scholar(&wrapped.to_string(), query)
}

pub(crate) fn urlencoding_min(value: &str) -> String {
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

/// Addresses `verify_url` must never dial: anything not on the public internet.
pub(crate) fn is_forbidden(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 shared CGNAT
                || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15 benchmarking
                || o[0] >= 240
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_forbidden(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            // deprecated IPv4-compatible ::a.b.c.d (but not :: or ::1)
            if seg[..6].iter().all(|&x| x == 0) && !v6.is_loopback() && !v6.is_unspecified() {
                if let Some(v4) = v6.to_ipv4() {
                    return is_forbidden(IpAddr::V4(v4));
                }
            }
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (seg[0] & 0xfe00) == 0xfc00 // fc00::/7 unique local
                || (seg[0] & 0xffc0) == 0xfe80 // fe80::/10 link local
                || (seg[0] == 0x64 && seg[1] == 0xff9b) // 64:ff9b::/96 NAT64
        }
    }
}

/// Outcome of a link check. Only `Unreachable` (a definite 404/410 or a
/// malformed URL) justifies dropping a link; everything else keeps it.
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Reach {
    Reachable,
    Unreachable,
    Unknown,
}

/// Mirrors reqwest's env-based proxy detection (system-proxy feature is off).
pub(crate) fn proxy_configured() -> bool {
    ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|k| std::env::var(k).is_ok_and(|v| !v.trim().is_empty()))
}

pub(crate) enum Resolved {
    /// Checked address to pin the connection to.
    Pinned(std::net::SocketAddr),
    /// Behind a proxy whose own DNS we cannot pin; host not known to be internal.
    ViaProxy,
}

/// Refuse internal targets before any request. Without a proxy: resolve once,
/// reject if any address is internal, and pin to one (no DNS rebinding). With
/// a proxy: reject IP literals and names that resolve locally to internal
/// addresses; a name that only the proxy can resolve is allowed through.
async fn check_target(
    url: &reqwest::Url,
    proxied: bool,
    forbidden: fn(std::net::IpAddr) -> bool,
) -> Option<Resolved> {
    check_target_with(url, proxied, forbidden, system_resolve).await
}

/// Name resolver; injectable so tests can point a name anywhere without DNS.
pub(crate) type Resolver = fn(String, u16) -> std::io::Result<Vec<std::net::SocketAddr>>;

pub(crate) fn system_resolve(host: String, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
    use std::net::ToSocketAddrs as _;
    Ok((host.as_str(), port).to_socket_addrs()?.collect())
}

pub(crate) async fn check_target_with(
    url: &reqwest::Url,
    proxied: bool,
    forbidden: fn(std::net::IpAddr) -> bool,
    resolve: Resolver,
) -> Option<Resolved> {
    let port = url.port_or_known_default()?;
    let host = url.host_str()?;
    let literal = host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::IpAddr>();
    let addrs: Vec<std::net::SocketAddr> = match literal {
        Ok(ip) => vec![(ip, port).into()],
        Err(_) => {
            let name = host.to_string();
            match tokio::task::spawn_blocking(move || resolve(name, port)).await {
                Ok(Ok(addrs)) => addrs,
                _ if proxied => return Some(Resolved::ViaProxy),
                _ => return None,
            }
        }
    };
    if addrs.is_empty() || addrs.iter().any(|a| forbidden(a.ip())) {
        return None;
    }
    if proxied {
        Some(Resolved::ViaProxy)
    } else {
        addrs.first().copied().map(Resolved::Pinned)
    }
}

const MAX_HOPS: usize = 5;

pub async fn probe_url(url: &str) -> Reach {
    probe_with(url, proxy_configured(), is_forbidden).await
}

/// Redirects are followed by hand so every hop is checked before it is dialed.
async fn probe_with(url: &str, proxied: bool, forbidden: fn(std::net::IpAddr) -> bool) -> Reach {
    if !is_http_url(url) {
        return Reach::Unreachable;
    }
    let Ok(mut current) = reqwest::Url::parse(url) else {
        return Reach::Unreachable;
    };
    for _ in 0..MAX_HOPS {
        if !matches!(current.scheme(), "http" | "https") {
            return Reach::Unknown;
        }
        let Some(target) = check_target(&current, proxied, forbidden).await else {
            return Reach::Unknown;
        };
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(8))
            .timeout(Duration::from_secs(12))
            .redirect(reqwest::redirect::Policy::none());
        match target {
            Resolved::Pinned(addr) => {
                builder = builder.no_proxy();
                if let Some(d) = current.host_str().filter(|h| h.parse::<std::net::IpAddr>().is_err() && !h.starts_with('[')) {
                    builder = builder.resolve(d, addr);
                }
            }
            Resolved::ViaProxy => {}
        }
        let Ok(client) = builder.build() else {
            return Reach::Unknown;
        };
        let mut response = client.head(current.clone()).send().await.ok();
        if !response.as_ref().is_some_and(|r| r.status().is_success() || r.status().is_redirection()) {
            // many servers reject HEAD; ask with GET before judging
            response = client.get(current.clone()).header("Range", "bytes=0-0").send().await.ok();
        }
        let Some(response) = response else {
            return Reach::Unknown;
        };
        let status = response.status();
        if status.is_success() {
            return Reach::Reachable;
        }
        if status == reqwest::StatusCode::NOT_FOUND || status == reqwest::StatusCode::GONE {
            return Reach::Unreachable;
        }
        if !status.is_redirection() {
            return Reach::Unknown;
        }
        let next = response
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|loc| current.join(loc).ok());
        match next {
            Some(n) => current = n,
            None => return Reach::Unknown,
        }
    }
    Reach::Unknown
}

pub async fn url_reachable(url: &str) -> bool {
    probe_url(url).await == Reach::Reachable
}

/// `force` 为 true 时（「刷新链接」）跳过缓存读取，查到的新结果照常写回。旧调用不传就是 false。
#[tauri::command]
pub async fn lookup_paper(
    app: tauri::AppHandle,
    arxiv_id: Option<String>,
    doi: Option<String>,
    title: Option<String>,
    year: Option<i32>,
    authors: Option<Vec<String>>,
    force: Option<bool>,
) -> Result<crate::lookup_run::LookupOutcome, String> {
    contain_panic(async move {
        // 凭据读不出来不该让查询整个失败：按未配置查，并留一条说明
        let (auth, notice) = crate::lookup_run::auth_or_anonymous(crate::biblio::load_auth(&app));
        let names = authors.unwrap_or_default();
        let mut outcome = crate::lookup_run::lookup_live(
            &auth,
            arxiv_id.as_deref(),
            doi.as_deref(),
            title.as_deref(),
            year,
            &names,
            force.unwrap_or(false),
        )
        .await;
        if let Some(notice) = notice {
            outcome.notices.insert(0, notice);
        }
        outcome
    })
    .await
}

/// 查询放进独立任务：里面 panic 只让这次调用返回错误，不会挂住或拖垮命令。
async fn contain_panic<T: Send + 'static>(
    work: impl std::future::Future<Output = T> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn(work)
        .await
        .map_err(|_| "文献库查询内部错误".to_string())
}

#[tauri::command]
pub async fn verify_url(url: String) -> Result<Reach, String> {
    Ok(probe_url(&url).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arxiv_id_from_doi(value: &str) -> Option<String> {
        let doi = Doi::parse(value)?;
        ArxivId::from_doi(&doi).map(ArxivId::into_string)
    }

    #[test]
    fn parses_recorded_arxiv_atom() {
        let hit =
            parse_arxiv_atom(include_str!("../fixtures/arxiv-attention.xml")).expect("arxiv hit");
        assert_eq!(hit.title, "Attention Is All You Need");
        assert_eq!(hit.year, Some(2017));
        assert_eq!(hit.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(hit.authors.len(), 2);
        assert_eq!(hit.authors[0].name, "Ashish Vaswani");
        assert_eq!(hit.authors[0].affiliation.as_deref(), Some("Google Brain"));
        assert_eq!(hit.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
        assert!(hit
            .pdf_url
            .as_deref()
            .unwrap_or("")
            .contains("/pdf/1706.03762"));
        assert!(hit.r#abstract.contains("dominant sequence"));
        assert_eq!(hit.confidence, 1.0);
    }

    #[test]
    fn parses_recorded_crossref() {
        let hit = parse_crossref(include_str!("../fixtures/crossref-attention.json"))
            .unwrap()
            .expect("crossref hit");
        assert_eq!(hit.title, "Attention Is All You Need");
        assert_eq!(hit.year, Some(2017));
        assert_eq!(
            hit.venue.as_deref(),
            Some("Advances in Neural Information Processing Systems")
        );
        assert_eq!(hit.authors[0].affiliation.as_deref(), Some("Google Brain"));
        assert_eq!(hit.authors[1].name, "Noam Shazeer");
        assert!(hit.r#abstract.contains("dominant sequence"));
        assert!(!hit.r#abstract.contains("jats:p"));
        assert_eq!(
            hit.pdf_url.as_deref(),
            Some("https://arxiv.org/pdf/1706.03762")
        );
    }

    #[test]
    fn openalex_accepts_only_titles_above_the_threshold() {
        let body = include_str!("../fixtures/openalex-attention.json");
        let hit = parse_openalex(body, &TitleQuery::title_only("Attention Is All You Need"))
            .unwrap()
            .expect("match");
        assert_eq!(hit.source_name, "openalex");
        assert_eq!(hit.confidence, 1.0);
        assert_eq!(
            hit.authors[0].affiliation.as_deref(),
            Some("Google (United States)")
        );
        assert_eq!(hit.r#abstract, "The dominant sequence");
        assert_eq!(hit.year, Some(2017));
        assert!(parse_openalex(
            body,
            &TitleQuery::title_only("Quantum error correction on a lattice")
        )
        .unwrap()
        .is_none());
    }

    #[test]
    fn semantic_scholar_uses_the_same_title_threshold() {
        let body = include_str!("../fixtures/semanticscholar-attention.json");
        let hit =
            parse_semantic_scholar(body, &TitleQuery::title_only("Attention Is All You Need"))
                .unwrap()
                .expect("match");
        assert_eq!(hit.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(hit.authors[0].affiliation.as_deref(), Some("Google Brain"));
        assert!(
            parse_semantic_scholar(body, &TitleQuery::title_only("Unrelated protein folding"))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn journal_ref_is_the_venue_and_a_missing_one_is_not_labelled_arxiv() {
        let plain = parse_arxiv_atom(include_str!("../fixtures/arxiv-attention.xml")).unwrap();
        assert!(plain.venue.is_none());
        let xml = r#"<entry><title>T</title><summary>S</summary><id>http://arxiv.org/abs/hep-th/9901001v2</id><arxiv:journal_ref>Phys. Rev. D 60</arxiv:journal_ref><arxiv:doi>10.1103/PhysRevD.60.1</arxiv:doi></entry>"#;
        let hit = parse_arxiv_atom(xml).unwrap();
        assert_eq!(hit.arxiv_id.as_deref(), Some("hep-th/9901001"));
        assert_eq!(hit.venue.as_deref(), Some("Phys. Rev. D 60"));
        assert_eq!(
            hit.providers.get("venue").map(String::as_str),
            Some("arxiv")
        );
    }

    #[test]
    fn rejects_non_http_pdf_links() {
        let xml = r#"<entry><title>T</title><summary>S</summary><id>http://arxiv.org/abs/1706.03762v1</id><link href="javascript:alert(1)" /></entry>"#;
        let hit = parse_arxiv_atom(xml).unwrap();
        assert!(hit.pdf_url.is_none());
    }

    fn sample(
        title: &str,
        year: Option<i32>,
        authors: &[&str],
        doi: Option<&str>,
        arxiv_id: Option<&str>,
    ) -> LookupHit {
        LookupHit {
            title: title.into(),
            r#abstract: String::new(),
            year,
            venue: None,
            doi: doi.map(str::to_string),
            arxiv_id: arxiv_id.map(str::to_string),
            pdf_url: None,
            authors: authors
                .iter()
                .map(|name| LookupAuthor {
                    name: (*name).into(),
                    affiliation: None,
                })
                .collect(),
            confidence: 0.0,
            source_name: "test".into(),
            providers: HashMap::new(),
        }
    }

    fn asked(
        title: &str,
        year: Option<i32>,
        authors: &[&str],
        doi: Option<&str>,
        arxiv_id: Option<&str>,
    ) -> TitleQuery {
        TitleQuery {
            title: title.into(),
            year,
            authors: authors.iter().map(|name| (*name).to_string()).collect(),
            doi: doi.map(str::to_string),
            arxiv_id: arxiv_id.map(str::to_string),
        }
    }

    #[test]
    fn punctuation_case_and_dash_variants_are_exact() {
        let candidate = sample(
            "Attention Is All You Need",
            Some(2017),
            &["Ashish Vaswani"],
            None,
            None,
        );
        for title in [
            "attention is all you need.",
            "“Attention Is All You Need”",
            "Attention Is All You Need!",
        ] {
            let score = titles_match(&asked(title, None, &[], None, None), &candidate);
            assert_eq!(score, Some(1.0), "{title}");
        }
        assert_eq!(normalize_title("Well—Known"), normalize_title("Well-Known"));
        assert_eq!(normalize_title("Well—Known"), normalize_title("Well Known"));
        assert_eq!(
            normalize_title("GPT-4 Technical Report"),
            normalize_title("GPT4 Technical Report")
        );
    }

    #[test]
    fn same_title_different_paper_is_rejected() {
        let query = asked(
            "Attention Is All You Need",
            Some(2017),
            &["Ashish Vaswani", "Noam Shazeer"],
            Some("10.48550/arXiv.1706.03762"),
            Some("1706.03762"),
        );
        let impostor = sample(
            "Attention Is All You Need",
            Some(2024),
            &["Jane Doe", "Alex Roe"],
            Some("10.9999/impostor"),
            Some("2401.00001"),
        );
        assert!(titles_match(&query, &impostor).is_none());
        let reordered = sample(
            "All You Need Is Attention",
            Some(2017),
            &["Ashish Vaswani"],
            None,
            None,
        );
        assert!(titles_match(
            &asked(
                "Attention Is All You Need",
                Some(2017),
                &["Ashish Vaswani"],
                None,
                None
            ),
            &reordered
        )
        .is_none());
    }

    #[test]
    fn preprint_and_published_versions_match() {
        let query = asked(
            "Attention Is All You Need.",
            Some(2017),
            &["Ashish Vaswani", "Noam Shazeer"],
            None,
            Some("1706.03762"),
        );
        let published = sample(
            "Attention is all you need",
            Some(2018),
            &["A. Vaswani", "Noam Shazeer"],
            Some("10.5555/3295222.3295349"),
            Some("1706.03762"),
        );
        assert_eq!(titles_match(&query, &published), Some(1.0));
        let typo = asked(
            "Attnetion Is All You Need",
            Some(2017),
            &["Ashish Vaswani"],
            None,
            None,
        );
        assert!(titles_match(&typo, &published).is_some());
        let drifted = sample(
            "Attention Is All You Need",
            Some(2021),
            &["Ashish Vaswani"],
            None,
            None,
        );
        assert!(titles_match(
            &asked(
                "Attention Is All You Need",
                Some(2017),
                &["Ashish Vaswani"],
                None,
                None
            ),
            &drifted
        )
        .is_none());
        let same_doi = sample(
            "Attention Is All You Need",
            Some(2021),
            &["Ashish Vaswani"],
            Some("10.5555/3295222.3295349"),
            None,
        );
        assert!(titles_match(
            &asked(
                "Attention Is All You Need",
                Some(2017),
                &[],
                Some("10.5555/3295222.3295349"),
                None
            ),
            &same_doi
        )
        .is_some());
    }

    #[test]
    fn chinese_titles_use_character_ngrams() {
        let query = asked(
            "注意力就是你所需要的一切",
            Some(2020),
            &["王伟"],
            None,
            None,
        );
        let near = sample("注意力就是你需要的一切", Some(2020), &["王伟"], None, None);
        assert!(titles_match(&query, &near).is_some());
        assert_ne!(normalize_title(&query.title), normalize_title(&near.title));
        assert!(titles_match(&TitleQuery::title_only(&query.title), &near).is_none());
        let other = sample(
            "基于注意力机制的语音识别",
            Some(2020),
            &["王伟"],
            None,
            None,
        );
        assert!(titles_match(
            &asked(
                "基于注意力机制的神经机器翻译",
                Some(2020),
                &["王伟"],
                None,
                None
            ),
            &other
        )
        .is_none());
        assert_eq!(
            titles_match(
                &TitleQuery::title_only("《注意力就是你所需要的一切》"),
                &sample("注意力就是你所需要的一切。", None, &[], None, None)
            ),
            Some(1.0)
        );
    }

    #[test]
    fn doi_mismatch_rejects_regardless_of_title_score() {
        let query = asked(
            "Attention Is All You Need",
            Some(2017),
            &["Ashish Vaswani"],
            Some("10.1000/real"),
            None,
        );
        let other = sample(
            "Attention Is All You Need",
            Some(2017),
            &["Ashish Vaswani"],
            Some("10.1000/other"),
            None,
        );
        assert!(titles_match(&query, &other).is_none());
        let extended = sample(
            "Attention Is All You Need: A Survey",
            Some(2017),
            &["Ashish Vaswani"],
            None,
            None,
        );
        assert!(titles_match(
            &asked(
                "Attention Is All You Need",
                Some(2017),
                &["Ashish Vaswani"],
                None,
                None
            ),
            &extended
        )
        .is_none());
    }

    #[test]
    fn arxiv_doi_yields_an_arxiv_id() {
        assert_eq!(
            arxiv_id_from_doi("10.48550/arXiv.1706.03762").as_deref(),
            Some("1706.03762")
        );
        assert_eq!(
            arxiv_id_from_doi("https://doi.org/10.48550/arxiv.1706.03762v3").as_deref(),
            Some("1706.03762")
        );
        assert_eq!(
            arxiv_id_from_doi("10.48550/arXiv.hep-th/9901001").as_deref(),
            Some("hep-th/9901001")
        );
        assert!(arxiv_id_from_doi("10.5555/3295222.3295349").is_none());
    }

    #[test]
    fn semantic_scholar_match_reads_a_data_array_and_rejects_a_doi_conflict() {
        let body = r#"{"data":[{"title":"Attention Is All You Need","year":2017,"externalIds":{"DOI":"10.48550/arXiv.1706.03762","ArXiv":"1706.03762"},"authors":[{"name":"Ashish Vaswani","affiliations":["Google Brain"]}]}]}"#;
        let hit = parse_s2_match(body, &TitleQuery::title_only("attention is all you need."))
            .unwrap()
            .expect("match");
        assert_eq!(hit.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(hit.authors[0].affiliation.as_deref(), Some("Google Brain"));
        let impostor = r#"{"data":[{"title":"Attention Is All You Need","year":2017,"externalIds":{"DOI":"10.9999/impostor"},"authors":[{"name":"Ashish Vaswani"}]}]}"#;
        let query = asked(
            "Attention Is All You Need",
            Some(2017),
            &["Ashish Vaswani"],
            Some("10.1000/real"),
            None,
        );
        assert!(parse_s2_match(impostor, &query).unwrap().is_none());
        assert!(parse_s2_paper(body).unwrap().is_none());
        let value: Value = serde_json::from_str(body).unwrap();
        let direct = parse_s2_paper(&value["data"][0].to_string())
            .unwrap()
            .expect("id paper");
        assert_eq!(direct.arxiv_id.as_deref(), Some("1706.03762"));
    }

    #[test]
    fn arxiv_id_parse_accepts_labels_urls_and_versions() {
        for (raw, want) in [
            ("2401.01234", "2401.01234"),
            ("  2401.01234v3 ", "2401.01234"),
            ("arXiv：2401.01234", "2401.01234"),
            ("\u{3000}arXiv：2401.01234\u{a0}", "2401.01234"),
            ("ARXIV: 2401.01234v2", "2401.01234"),
            ("arxiv：  2401.01234", "2401.01234"),
            ("２４０１.０１２３４", "2401.01234"),
            ("https://arxiv.org/abs/2401.01234v2", "2401.01234"),
            ("HTTP://WWW.ARXIV.ORG/PDF/2401.01234V1.PDF", "2401.01234"),
            ("http://arxiv.org/pdf/2401.01234.pdf", "2401.01234"),
            ("arxiv.org/abs/2401.01234?context=cs", "2401.01234"),
            ("https://arxiv.org/abs/hep-th/9901001v2", "hep-th/9901001"),
            ("hep-th/9901001", "hep-th/9901001"),
            ("solv-int/9901001", "solv-int/9901001"),
            ("math.AG/0601001v1", "math.AG/0601001"),
        ] {
            assert_eq!(
                ArxivId::parse(raw).as_ref().map(ArxivId::as_str),
                Some(want),
                "{raw:?}"
            );
        }
        for raw in [
            "",
            "arXiv:",
            "arXiv：",
            "2401.1",
            "v2",
            "1234/5678",
            "2401.01234 extra",
            "https://example.org/abs/2401.01234",
            "http://arxiv.org/api/errors#incorrect_id_format_for_2401.0123",
            "doi:10.1000/x",
        ] {
            assert!(ArxivId::parse(raw).is_none(), "{raw:?}");
        }
        assert_eq!(
            ArxivId::parse("HEP-TH/9901001"),
            ArxivId::parse("hep-th/9901001")
        );
        assert_eq!(
            normalize_arxiv_id("arXiv：2401.01234").as_deref(),
            Some("2401.01234")
        );
    }

    #[test]
    fn doi_parse_accepts_labels_and_resolver_urls() {
        for raw in [
            "10.1000/ABC",
            "doi:10.1000/ABC",
            "DOI: 10.1000/ABC",
            "doi：10.1000/ABC",
            "https://doi.org/10.1000/ABC",
            "http://dx.doi.org/10.1000/ABC",
            "https://www.doi.org/10.1000/ABC",
            "HTTPS://DOI.ORG/10.1000/ABC",
            "doi.org/10.1000/ABC",
            " \u{3000}10.1000/ABC\u{a0}",
        ] {
            assert_eq!(
                Doi::parse(raw).as_ref().map(Doi::as_str),
                Some("10.1000/ABC"),
                "{raw:?}"
            );
        }
        for raw in [
            "",
            "10.1000",
            "10./abc",
            "11.1000/abc",
            "10.1000/",
            "10.1000/a b",
            "doi:",
            "https://doi.org/",
            "https://example.org/10.1000/abc",
        ] {
            assert!(Doi::parse(raw).is_none(), "{raw:?}");
        }
        // 后缀原样保存，比较忽略大小写
        assert_eq!(Doi::parse("10.1000/ABC"), Doi::parse("doi:10.1000/abc"));
        let query = asked(
            "Attention Is All You Need",
            None,
            &[],
            Some("10.1000/ABC"),
            None,
        );
        let hit = sample(
            "Attention Is All You Need",
            None,
            &[],
            Some("https://doi.org/10.1000/abc"),
            None,
        );
        assert!(!identifiers_conflict(&query, &hit));
        assert!(identifiers_match(&query, &hit));
    }

    fn exercise(input: &str) {
        let _ = ArxivId::parse(input);
        let _ = Doi::parse(input);
        let _ = arxiv_id_from_doi(input);
        let _ = is_http_url(input);
        let _ = strip_tags(input);
        let _ = parse_arxiv_atom(input);
        let _ = is_arxiv_error_feed(input);
        let _ = distinctive_title(input, &normalize_title(input));
    }

    #[test]
    fn identifier_and_text_parsers_never_panic_on_multibyte_input() {
        let pieces = [
            "arXiv",
            "arxiv:",
            "ARXIV：",
            "：",
            ":",
            " ",
            "\u{3000}",
            "\u{a0}",
            "\u{200b}",
            "é",
            "中",
            "😀",
            "ａ",
            "２",
            "\u{301}",
            "2401.01234",
            "hep-th/9901001",
            "v",
            "V2",
            ".pdf",
            "/",
            "?",
            "https://",
            "http://",
            "www.",
            "arxiv.org/abs/",
            "arxiv.org/pdf/",
            "doi:",
            "DOI：",
            "doi.org/",
            "dx.",
            "10.",
            "10.1000/",
            "&",
            "&lt;",
            "&#x1F600;",
            "&#",
            ";",
            "<",
            ">",
            "<i>",
            "</",
            "<entry>",
            "</entry>",
            "<id>",
            "</id>",
        ];
        let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
        let mut next = move || {
            seed = seed
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (seed >> 33) as usize
        };
        for _ in 0..3000 {
            let mut input = String::new();
            for _ in 0..next() % 8 {
                input.push_str(pieces[next() % pieces.len()]);
            }
            exercise(&input);
            for (at, _) in input.char_indices() {
                exercise(input.get(..at).unwrap_or(""));
                exercise(input.get(at..).unwrap_or(""));
            }
        }
        // 原来按字节切 id[..6]，全角冒号正好跨过第 6 字节
        for ascii in 0..8 {
            for wide in ['：', '中', '😀', '\u{3000}'] {
                let input = format!(
                    "{}{wide}2401.01234",
                    "arxiv:".get(..ascii).unwrap_or("arxiv:")
                );
                exercise(&input);
            }
        }
    }

    #[test]
    fn http_url_check_is_boundary_safe() {
        assert!(is_http_url("http://x"));
        assert!(is_http_url(" HTTPS://arxiv.org/pdf/1 "));
        assert!(!is_http_url("https://"));
        assert!(!is_http_url("ftp://example.org"));
        assert!(!is_http_url("javascript:alert(1)"));
        assert!(!is_http_url("ｈttps://中文"));
    }

    #[test]
    fn generic_exact_titles_need_corroboration_or_length() {
        for generic in ["untitled", "Introduction", "main", "fulltext", "Full Text"] {
            let record = sample(generic, Some(2015), &["Jane Doe"], None, None);
            assert!(
                titles_match(&TitleQuery::title_only(generic), &record).is_none(),
                "{generic}"
            );
            assert_eq!(
                titles_match(&asked(generic, Some(2015), &[], None, None), &record),
                Some(1.0),
                "{generic}"
            );
            assert_eq!(
                titles_match(&asked(generic, None, &["J. Doe"], None, None), &record),
                Some(1.0),
                "{generic}"
            );
        }
        let exact = |title: &str| {
            titles_match(
                &TitleQuery::title_only(title),
                &sample(title, None, &[], None, None),
            )
        };
        assert_eq!(exact("Deep Residual Learning Networks"), Some(1.0));
        assert_eq!(exact("Electroencephalographic Characterization"), Some(1.0));
        assert!(exact("Deep Residual Learning").is_none());
        assert!(exact("注意力机制研究").is_none());
        assert_eq!(exact("注意力机制研究综述"), Some(1.0));
        // 同一个 DOI 本身就是佐证
        assert_eq!(
            titles_match(
                &asked("Main", None, &[], Some("10.1000/x"), None),
                &sample("main", None, &[], Some("10.1000/X"), None)
            ),
            Some(1.0)
        );
    }

    #[test]
    fn markup_is_stripped_before_entities_are_decoded() {
        let body = r#"{"message":{"title":["Structure of <i>E. coli</i> &amp; CO<sub>2</sub>"],"abstract":"<jats:title>Abstract</jats:title><jats:p>Significant at p &lt; 0.05 and x &gt; 1; raw x < y kept; &amp;lt; stays escaped.</jats:p>","DOI":"10.1000/x"}}"#;
        let hit = parse_crossref(body).unwrap().expect("crossref hit");
        assert_eq!(hit.title, "Structure of E. coli & CO2");
        assert_eq!(
            hit.r#abstract,
            "Abstract Significant at p < 0.05 and x > 1; raw x < y kept; &lt; stays escaped."
        );
        let openalex = r#"{"results":[{"display_name":"Structure of <i>E. coli</i> membranes in vivo","publication_year":2020}]}"#;
        let hit = parse_openalex(
            openalex,
            &TitleQuery::title_only("Structure of E. coli membranes in vivo"),
        )
        .unwrap()
        .expect("openalex hit");
        assert_eq!(hit.title, "Structure of E. coli membranes in vivo");
        let xml = "<entry><id>http://arxiv.org/abs/2401.01234v1</id><title>Bounds for p &lt; 0.05</title><summary>We show x &lt;i&gt; y.</summary></entry>";
        let hit = parse_arxiv_atom(xml).expect("arxiv hit");
        assert_eq!(hit.title, "Bounds for p < 0.05");
        assert_eq!(hit.r#abstract, "We show x <i> y.");
        assert_eq!(strip_tags("p&lt;0.05"), "p<0.05");
        assert_eq!(strip_tags("&#x3B1;-helix &#946; &#0;"), "α-helix β &#0;");
        assert_eq!(strip_tags("AT&T &unknown; & more"), "AT&T &unknown; & more");
    }

    #[test]
    fn arxiv_error_entries_are_not_hits() {
        let by_id = r#"<feed><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_2401.0123</id><title>Error</title><summary>incorrect id format for 2401.0123</summary><author><name>arXiv api core</name></author></entry></feed>"#;
        assert!(is_arxiv_error_feed(by_id));
        assert!(parse_arxiv_atom(by_id).is_none());
        let by_title = r#"<feed><entry><id>http://arxiv.org/abs/2401.01234v1</id><title>error</title><author><name>arXiv API Core</name></author></entry></feed>"#;
        assert!(is_arxiv_error_feed(by_title));
        assert!(parse_arxiv_atom(by_title).is_none());
        let real = r#"<feed><entry><id>http://arxiv.org/abs/2401.01234v1</id><title>Error</title><author><name>Jane Doe</name></author></entry></feed>"#;
        assert!(!is_arxiv_error_feed(real));
        assert_eq!(
            parse_arxiv_atom(real).unwrap().arxiv_id.as_deref(),
            Some("2401.01234")
        );
    }

    #[test]
    fn id_lookups_keep_short_titles() {
        // 按 DOI / arXiv id 取回的单条记录不比标题，短标题也留着，由 accepts_ids 核对
        let openalex = r#"{"display_name":"Graphene","doi":"https://doi.org/10.1000/g"}"#;
        let hit = parse_openalex_single(openalex).unwrap().expect("openalex");
        assert_eq!(hit.title, "Graphene");
        assert_eq!(hit.confidence, 1.0);
        let s2 = r#"{"title":"Main","externalIds":{"ArXiv":"2401.01234"}}"#;
        assert_eq!(parse_s2_paper(s2).unwrap().expect("s2").title, "Main");
    }

    #[tokio::test]
    async fn a_panicking_lookup_becomes_an_error() {
        let failed: Result<(), String> = contain_panic(async {
            if true {
                panic!("boom");
            }
        })
        .await;
        assert_eq!(failed, Err("文献库查询内部错误".to_string()));
        assert_eq!(contain_panic(async { 7 }).await, Ok(7));
    }

    // ---- Tester #6 repro: verify_url must not reach internal addresses ----
    mod tester_ssrf {
        use super::super::*;
        use std::io::{Read, Write};
        use std::net::TcpListener;

        /// Tiny HTTP server answering every request with `resp`; returns port.
        fn serve(bind: &str, resp: &'static str) -> Option<u16> {
            let l = TcpListener::bind(bind).ok()?;
            let port = l.local_addr().ok()?.port();
            std::thread::spawn(move || {
                for s in l.incoming().flatten() {
                    let mut s = s;
                    let mut buf = [0u8; 2048];
                    let _ = s.read(&mut buf);
                    let _ = s.write_all(resp.as_bytes());
                }
            });
            Some(port)
        }
        const OK: &str = "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

        #[tokio::test]
        async fn tester_ssrf_ipv4_loopback_rejected() {
            let p = serve("127.0.0.1:0", OK).unwrap();
            assert!(!url_reachable(&format!("http://127.0.0.1:{p}/")).await, "loopback probed");
        }

        #[tokio::test]
        async fn tester_ssrf_localhost_name_rejected() {
            let p = serve("127.0.0.1:0", OK).unwrap();
            assert!(!url_reachable(&format!("http://localhost:{p}/")).await, "localhost probed");
        }

        #[tokio::test]
        async fn tester_ssrf_ipv6_loopback_rejected() {
            let Some(p) = serve("[::1]:0", OK) else { eprintln!("no ipv6, skip"); return };
            assert!(!url_reachable(&format!("http://[::1]:{p}/")).await, "[::1] probed");
        }

        #[tokio::test]
        async fn tester_ssrf_ipv4_mapped_v6_rejected() {
            let Some(p) = serve("[::]:0", OK) else { eprintln!("no ipv6, skip"); return };
            assert!(!url_reachable(&format!("http://[::ffff:127.0.0.1]:{p}/")).await, "mapped probed");
        }

        #[tokio::test]
        async fn tester_ssrf_redirect_to_internal_not_followed_as_reachable() {
            // Server A 302s to an internal target; even a 3xx must not count as "reachable"
            // when the hop target is internal. (A is loopback here only because the test
            // has no public host; after the fix A itself is rejected too.)
            let target = serve("127.0.0.1:0", OK).unwrap();
            let resp: &'static str = Box::leak(format!(
                "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{target}/admin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_boxed_str());
            let a = serve("127.0.0.1:0", resp).unwrap();
            assert!(!url_reachable(&format!("http://127.0.0.1:{a}/")).await);
        }

        // 10.x and 169.254.169.254 cannot be served on this box; they must be rejected
        // before any connect. Asserting a fast `false` (well under connect_timeout=8s)
        // shows the address was refused up front, not just timed out.
        #[tokio::test]
        async fn tester_ssrf_private_and_metadata_rejected_without_connecting() {
            for u in ["http://10.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/"] {
                let t = std::time::Instant::now();
                assert!(!url_reachable(u).await, "{u}");
                assert!(t.elapsed() < std::time::Duration::from_secs(1), "{u} was dialed ({:?})", t.elapsed());
            }
        }
    }

    #[test]
    fn is_forbidden_covers_internal_ranges() {
        for ip in ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "0.0.0.0",
                   "100.64.0.1", "255.255.255.255", "224.0.0.1", "::1", "::", "fc00::1", "fd12::1",
                   "fe80::1", "::ffff:127.0.0.1", "::127.0.0.1", "::10.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1"] {
            assert!(is_forbidden(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "::8.8.8.8"] {
            assert!(!is_forbidden(ip.parse().unwrap()), "{ip}");
        }
    }

    mod probe {
        use super::super::*;
        use std::io::{Read, Write};
        use std::net::TcpListener;

        fn serve(resp: &'static str) -> u16 {
            let l = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = l.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for mut s in l.incoming().flatten() {
                    let mut buf = [0u8; 2048];
                    let _ = s.read(&mut buf);
                    let _ = s.write_all(resp.as_bytes());
                }
            });
            port
        }
        fn allow_all(_: std::net::IpAddr) -> bool {
            false
        }

        #[tokio::test]
        async fn definite_404_and_410_are_unreachable() {
            for r in ["HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                      "HTTP/1.1 410 Gone\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"] {
                let p = serve(r);
                assert_eq!(probe_with(&format!("http://127.0.0.1:{p}/"), false, allow_all).await, Reach::Unreachable);
            }
        }

        #[tokio::test]
        async fn server_errors_and_refused_connections_are_unknown() {
            let p = serve("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            assert_eq!(probe_with(&format!("http://127.0.0.1:{p}/"), false, allow_all).await, Reach::Unknown);
            let closed = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
            assert_eq!(probe_with(&format!("http://127.0.0.1:{closed}/"), false, allow_all).await, Reach::Unknown);
        }

        #[tokio::test]
        async fn dns_failure_is_unknown_not_unreachable() {
            assert_eq!(probe_with("http://no-such-host.invalid/", false, is_forbidden).await, Reach::Unknown);
        }

        #[tokio::test]
        async fn forbidden_target_is_unknown_so_link_is_kept() {
            assert_eq!(probe_with("http://10.0.0.1/", false, is_forbidden).await, Reach::Unknown);
        }

        #[tokio::test]
        async fn with_proxy_internal_literals_and_names_are_still_refused_without_dialing() {
            for u in ["http://10.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "http://localhost/"] {
                let t = std::time::Instant::now();
                assert_eq!(probe_with(u, true, is_forbidden).await, Reach::Unknown, "{u}");
                assert!(t.elapsed() < std::time::Duration::from_secs(1), "{u} dialed");
            }
        }

        #[test]
        fn proxy_env_is_detected() {
            // read-only check of the detector's key list; no env mutation (tests run in parallel)
            let any = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
                .iter().any(|k| std::env::var(k).is_ok_and(|v| !v.trim().is_empty()));
            assert_eq!(proxy_configured(), any);
        }
    }
}
