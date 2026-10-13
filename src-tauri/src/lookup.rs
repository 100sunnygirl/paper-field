//! Bibliographic lookup parsers. Network order, rate limits, and credentials live in lookup_run.
//! A miss, 429, or mismatch is not fatal: the command still returns whatever later sources found.

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
        return Some(1.0);
    }
    let score = fuzzy_title_score(&left, &right)?;
    if !corroborated(query, hit) {
        return None;
    }
    Some(score)
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
    if let (Some(want), Some(got)) = (norm_doi(query.doi.as_deref()), norm_doi(hit.doi.as_deref()))
    {
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
    let doi_match = match (norm_doi(query.doi.as_deref()), norm_doi(hit.doi.as_deref())) {
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

fn norm_doi(value: Option<&str>) -> Option<String> {
    value
        .and_then(normalize_doi)
        .map(|doi| doi.to_ascii_lowercase())
}

fn canonical_arxiv(doi: Option<&str>, arxiv_id: Option<&str>) -> Option<String> {
    arxiv_id
        .and_then(normalize_arxiv_id)
        .or_else(|| doi.and_then(arxiv_id_from_doi))
        .map(|id| id.to_ascii_lowercase())
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

pub fn normalize_arxiv_id(value: &str) -> Option<String> {
    let mut id = value.trim();
    if id.len() > 6 && id[..6].eq_ignore_ascii_case("arxiv:") {
        id = id[6..].trim();
    }
    let lower = id.to_ascii_lowercase();
    if let Some(index) = lower.find("arxiv.org/abs/") {
        id = id[index + "arxiv.org/abs/".len()..].trim();
    } else if let Some(index) = lower.find("arxiv.org/pdf/") {
        id = id[index + "arxiv.org/pdf/".len()..].trim();
    }
    id = id.trim_end_matches(".pdf");
    let versionless = strip_arxiv_version(id);
    if is_new_arxiv(versionless) || is_old_arxiv(versionless) {
        Some(versionless.to_string())
    } else {
        None
    }
}

fn strip_arxiv_version(id: &str) -> &str {
    let Some(index) = id.rfind(['v', 'V']) else {
        return id;
    };
    if index == 0
        || !id[index + 1..].chars().all(|ch| ch.is_ascii_digit())
        || id[index + 1..].is_empty()
    {
        return id;
    }
    &id[..index]
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
    let mut doi = value.trim();
    for prefix in [
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
    ] {
        if let Some(rest) = doi.strip_prefix(prefix) {
            doi = rest;
        }
    }
    if doi.len() > 4 && doi.starts_with("10.") && !doi.chars().any(|ch| ch.is_whitespace()) {
        Some(doi.to_string())
    } else {
        None
    }
}

/// `10.48550/arXiv.1706.03762` is an arXiv id, not a Crossref work. Crossref 404s these.
pub fn arxiv_id_from_doi(value: &str) -> Option<String> {
    let doi = normalize_doi(value)?;
    let lower = doi.to_ascii_lowercase();
    let rest = lower.strip_prefix("10.48550/arxiv.")?;
    if rest.is_empty() {
        return None;
    }
    let original = &doi[doi.len() - rest.len()..];
    normalize_arxiv_id(original)
}

fn is_http_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && !lower[8.min(lower.len())..].is_empty()
}

fn clean_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn decode_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "")
        .replace("&gt;", "")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
}

fn strip_tags(value: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        if ch == '<' {
            in_tag = true;
        } else if ch == '>' {
            in_tag = false;
        } else if !in_tag {
            out.push(ch);
        }
    }
    clean_text(&decode_entities(&out).replace(['<', '>'], ""))
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
    while let Some(start) = rest.find(&open) {
        let after = &rest[start..];
        let Some(content_at) = after.find('>') else {
            break;
        };
        let body = &after[content_at + 1..];
        let Some(end) = body.find(&close) else { break };
        blocks.push(body[..end].to_string());
        rest = &body[end + close.len()..];
    }
    blocks
}

fn xml_text(block: &str, tag: &str) -> Option<String> {
    xml_blocks(block, tag)
        .into_iter()
        .next()
        .map(|text| strip_tags(&text))
}

pub fn parse_arxiv_atom(xml: &str) -> Option<LookupHit> {
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
    let title = message["title"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(Value::as_str)
        .map(clean_text)
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
        let Some(title) = result["display_name"].as_str().map(clean_text) else {
            continue;
        };
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
        let hit = finish(LookupHit {
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
        });
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

pub fn parse_openalex_single(body: &str) -> Result<Option<LookupHit>, String> {
    let value: Value =
        serde_json::from_str(body).map_err(|err| format!("OpenAlex 响应无法解析：{err}"))?;
    if value["display_name"].as_str().is_none() {
        return Ok(None);
    }
    let title = value["display_name"].as_str().unwrap_or("").to_string();
    let wrapped = serde_json::json!({ "results": [value] });
    parse_openalex(&wrapped.to_string(), &TitleQuery::title_only(&title))
}

pub fn parse_semantic_scholar(body: &str, query: &TitleQuery) -> Result<Option<LookupHit>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| format!("Semantic Scholar 响应无法解析：{err}"))?;
    let Some(results) = value["data"].as_array() else {
        return Ok(None);
    };
    let mut best: Option<LookupHit> = None;
    for result in results {
        let Some(title) = result["title"].as_str().map(clean_text) else {
            continue;
        };
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
        let hit = finish(LookupHit {
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
        });
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

pub fn parse_s2_paper(body: &str) -> Result<Option<LookupHit>, String> {
    let value: Value = serde_json::from_str(body)
        .map_err(|err| format!("Semantic Scholar 响应无法解析：{err}"))?;
    let Some(title) = value["title"]
        .as_str()
        .map(clean_text)
        .filter(|title| !title.is_empty())
    else {
        return Ok(None);
    };
    let wrapped = serde_json::json!({ "data": [value] });
    parse_semantic_scholar(&wrapped.to_string(), &TitleQuery::title_only(&title))
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

#[tauri::command]
pub async fn lookup_paper(
    app: tauri::AppHandle,
    arxiv_id: Option<String>,
    doi: Option<String>,
    title: Option<String>,
    year: Option<i32>,
    authors: Option<Vec<String>>,
) -> Result<crate::lookup_run::LookupOutcome, String> {
    let auth = crate::biblio::load_auth(&app)?;
    let names = authors.unwrap_or_default();
    Ok(crate::lookup_run::lookup_live(
        &auth,
        arxiv_id.as_deref(),
        doi.as_deref(),
        title.as_deref(),
        year,
        &names,
    )
    .await)
}

#[tauri::command]
pub async fn verify_url(url: String) -> Result<Reach, String> {
    Ok(probe_url(&url).await)
}

#[cfg(test)]
mod tests {
    use super::*;

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
