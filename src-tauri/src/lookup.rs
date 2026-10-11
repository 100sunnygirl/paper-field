//! Bibliographic lookup. Parsing is pure and tested against recorded fixtures.
//! Network calls fail soft: the command returns an error string and the UI keeps the paper.

use std::collections::HashSet;
use std::time::Duration;

use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

pub const TITLE_MATCH_THRESHOLD: f64 = 0.82;

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
}

pub fn title_score(query: &str, candidate: &str) -> f64 {
    let left = tokens(query);
    let right = tokens(candidate);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let inter = left.intersection(&right).count() as f64;
    let union = left.union(&right).count() as f64;
    if union == 0.0 { 0.0 } else { inter / union }
}

fn tokens(value: &str) -> HashSet<String> {
    value
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_lowercase())
        .collect()
}

pub fn normalize_arxiv_id(value: &str) -> Option<String> {
    let mut id = value.trim().trim_start_matches("arXiv:").trim_start_matches("arxiv:");
    id = id.trim();
    if let Some(rest) = id.split("arxiv.org/abs/").nth(1) {
        id = rest;
    } else if let Some(rest) = id.split("arxiv.org/pdf/").nth(1) {
        id = rest;
    }
    id = id.trim_end_matches(".pdf");
    let versionless = id.split('v').next().unwrap_or(id);
    let ok = versionless.len() >= 9
        && versionless.as_bytes().get(4) == Some(&b'.')
        && versionless.chars().all(|ch| ch.is_ascii_digit() || ch == '.');
    if ok { Some(versionless.to_string()) } else { None }
}

pub fn normalize_doi(value: &str) -> Option<String> {
    let mut doi = value.trim();
    for prefix in ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/"] {
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

fn is_http_url(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")) && !lower[8.min(lower.len())..].is_empty()
}

fn clean_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
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
    clean_text(&out)
}

fn xml_blocks(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut blocks = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start..];
        let Some(content_at) = after.find('>') else { break };
        let body = &after[content_at + 1..];
        let Some(end) = body.find(&close) else { break };
        blocks.push(body[..end].to_string());
        rest = &body[end + close.len()..];
    }
    blocks
}

fn xml_text(block: &str, tag: &str) -> Option<String> {
    xml_blocks(block, tag).into_iter().next().map(|text| strip_tags(&text))
}

pub fn parse_arxiv_atom(xml: &str) -> Option<LookupHit> {
    let entry = xml_blocks(xml, "entry").into_iter().next()?;
    let title = xml_text(&entry, "title").filter(|title| !title.is_empty())?;
    let summary = xml_text(&entry, "summary").unwrap_or_default();
    let published = xml_text(&entry, "published").unwrap_or_default();
    let year = published.get(0..4).and_then(|text| text.parse::<i32>().ok());
    let id_raw = xml_text(&entry, "id").unwrap_or_default();
    let arxiv_id = normalize_arxiv_id(&id_raw);
    let doi = xml_blocks(&entry, "arxiv:doi")
        .into_iter()
        .next()
        .and_then(|text| normalize_doi(&strip_tags(&text)));
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
    Some(LookupHit {
        title,
        r#abstract: summary,
        year,
        venue: Some("arXiv".into()),
        doi,
        arxiv_id,
        pdf_url,
        authors,
        confidence: 1.0,
        source_name: "arxiv".into(),
    })
}

pub fn parse_crossref(body: &str) -> Result<Option<LookupHit>, String> {
    let value: Value = serde_json::from_str(body).map_err(|err| format!("Crossref 响应无法解析：{err}"))?;
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
    let abstract_text = message["abstract"].as_str().map(strip_tags).unwrap_or_default();
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
    Ok(Some(LookupHit {
        title,
        r#abstract: abstract_text,
        year,
        venue,
        doi,
        arxiv_id: None,
        pdf_url,
        authors,
        confidence: 1.0,
        source_name: "crossref".into(),
    }))
}

fn inverted_abstract(index: &Value) -> String {
    let Some(map) = index.as_object() else { return String::new() };
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
    words.into_iter().map(|item| item.1).collect::<Vec<_>>().join(" ")
}

fn accept_title(query: &str, candidate: &str) -> Option<f64> {
    let score = title_score(query, candidate);
    if score + f64::EPSILON >= TITLE_MATCH_THRESHOLD {
        Some(score)
    } else {
        None
    }
}

pub fn parse_openalex(body: &str, query_title: &str) -> Result<Option<LookupHit>, String> {
    let value: Value = serde_json::from_str(body).map_err(|err| format!("OpenAlex 响应无法解析：{err}"))?;
    let Some(results) = value["results"].as_array() else { return Ok(None) };
    let mut best: Option<LookupHit> = None;
    for result in results {
        let Some(title) = result["display_name"].as_str().map(clean_text) else { continue };
        let Some(score) = accept_title(query_title, &title) else { continue };
        let mut authors = Vec::new();
        if let Some(list) = result["authorships"].as_array() {
            for authorship in list {
                let Some(name) = authorship["author"]["display_name"].as_str() else { continue };
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
        let hit = LookupHit {
            title,
            r#abstract: inverted_abstract(&result["abstract_inverted_index"]),
            year: result["publication_year"].as_i64().map(|year| year as i32),
            venue: result["primary_location"]["source"]["display_name"]
                .as_str()
                .map(|text| text.to_string()),
            doi: result["doi"].as_str().and_then(normalize_doi),
            arxiv_id: None,
            pdf_url,
            authors,
            confidence: score,
            source_name: "openalex".into(),
        };
        if best.as_ref().map(|current| hit.confidence > current.confidence).unwrap_or(true) {
            best = Some(hit);
        }
    }
    Ok(best)
}

pub fn parse_semantic_scholar(body: &str, query_title: &str) -> Result<Option<LookupHit>, String> {
    let value: Value = serde_json::from_str(body).map_err(|err| format!("Semantic Scholar 响应无法解析：{err}"))?;
    let Some(results) = value["data"].as_array() else { return Ok(None) };
    let mut best: Option<LookupHit> = None;
    for result in results {
        let Some(title) = result["title"].as_str().map(clean_text) else { continue };
        let Some(score) = accept_title(query_title, &title) else { continue };
        let mut authors = Vec::new();
        if let Some(list) = result["authors"].as_array() {
            for author in list {
                let Some(name) = author["name"].as_str() else { continue };
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
        let hit = LookupHit {
            title,
            r#abstract: result["abstract"].as_str().unwrap_or("").to_string(),
            year: result["year"].as_i64().map(|year| year as i32),
            venue: result["venue"].as_str().filter(|text| !text.is_empty()).map(|text| text.to_string()),
            doi: result["externalIds"]["DOI"].as_str().and_then(normalize_doi),
            arxiv_id: result["externalIds"]["ArXiv"].as_str().and_then(normalize_arxiv_id),
            pdf_url: result["openAccessPdf"]["url"]
                .as_str()
                .filter(|url| is_http_url(url))
                .map(|url| url.to_string()),
            authors,
            confidence: score,
            source_name: "semanticscholar".into(),
        };
        if best.as_ref().map(|current| hit.confidence > current.confidence).unwrap_or(true) {
            best = Some(hit);
        }
    }
    Ok(best)
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(12))
        .user_agent("PaperField/0.2 (mailto:local@paperfield.app)")
        .build()
        .map_err(|err| format!("无法创建 HTTP 客户端：{err}"))
}

async fn get_text(client: &Client, url: &str) -> Result<String, String> {
    let response = client.get(url).send().await.map_err(|err| format!("文献库不可达：{err}"))?;
    let status = response.status();
    if status.as_u16() == 404 {
        return Ok(String::new());
    }
    if !status.is_success() {
        return Err(format!("文献库返回 HTTP {}", status.as_u16()));
    }
    response.text().await.map_err(|err| format!("读取文献库响应失败：{err}"))
}

pub async fn lookup_record(
    arxiv_id: Option<&str>,
    doi: Option<&str>,
    title: Option<&str>,
) -> Result<Option<LookupHit>, String> {
    let client = http_client()?;
    if let Some(id) = arxiv_id.and_then(normalize_arxiv_id) {
        let url = format!("https://export.arxiv.org/api/query?id_list={id}");
        let body = get_text(&client, &url).await?;
        if let Some(mut hit) = parse_arxiv_atom(&body) {
            hit.arxiv_id = Some(id);
            return Ok(Some(hit));
        }
    }
    if let Some(doi) = doi.and_then(normalize_doi) {
        let url = format!("https://api.crossref.org/works/{}", urlencoding_min(&doi));
        let body = get_text(&client, &url).await?;
        if !body.is_empty() {
            if let Some(hit) = parse_crossref(&body)? {
                return Ok(Some(hit));
            }
        }
    }
    let Some(title) = title.map(str::trim).filter(|title| !title.is_empty()) else {
        return Ok(None);
    };
    let openalex = format!(
        "https://api.openalex.org/works?search={}&per-page=5&mailto=local@paperfield.app",
        urlencoding_min(title)
    );
    if let Ok(body) = get_text(&client, &openalex).await {
        if let Some(hit) = parse_openalex(&body, title)? {
            return Ok(Some(hit));
        }
    }
    let scholar = format!(
        "https://api.semanticscholar.org/graph/v1/paper/search?query={}&limit=5&fields=title,year,abstract,venue,externalIds,authors,authors.affiliations,openAccessPdf",
        urlencoding_min(title)
    );
    match get_text(&client, &scholar).await {
        Ok(body) => parse_semantic_scholar(&body, title),
        Err(_) => Ok(None),
    }
}

fn urlencoding_min(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub async fn url_reachable(url: &str) -> bool {
    if !is_http_url(url) {
        return false;
    }
    let Ok(client) = http_client() else { return false };
    let head = client.head(url).send().await;
    if let Ok(response) = head {
        let status = response.status();
        if status.is_success() || status.is_redirection() {
            return true;
        }
    }
    client
        .get(url)
        .header("Range", "bytes=0-0")
        .send()
        .await
        .map(|response| response.status().is_success() || response.status().is_redirection())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn lookup_paper(
    arxiv_id: Option<String>,
    doi: Option<String>,
    title: Option<String>,
) -> Result<Option<LookupHit>, String> {
    lookup_record(arxiv_id.as_deref(), doi.as_deref(), title.as_deref()).await
}

#[tauri::command]
pub async fn verify_url(url: String) -> Result<bool, String> {
    Ok(url_reachable(&url).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_recorded_arxiv_atom() {
        let hit = parse_arxiv_atom(include_str!("../fixtures/arxiv-attention.xml")).expect("arxiv hit");
        assert_eq!(hit.title, "Attention Is All You Need");
        assert_eq!(hit.year, Some(2017));
        assert_eq!(hit.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(hit.authors.len(), 2);
        assert_eq!(hit.authors[0].name, "Ashish Vaswani");
        assert_eq!(hit.authors[0].affiliation.as_deref(), Some("Google Brain"));
        assert_eq!(hit.doi.as_deref(), Some("10.48550/arXiv.1706.03762"));
        assert!(hit.pdf_url.as_deref().unwrap_or("").contains("/pdf/1706.03762"));
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
        assert_eq!(hit.venue.as_deref(), Some("Advances in Neural Information Processing Systems"));
        assert_eq!(hit.authors[0].affiliation.as_deref(), Some("Google Brain"));
        assert_eq!(hit.authors[1].name, "Noam Shazeer");
        assert!(hit.r#abstract.contains("dominant sequence"));
        assert!(!hit.r#abstract.contains("jats:p"));
        assert_eq!(hit.pdf_url.as_deref(), Some("https://arxiv.org/pdf/1706.03762"));
    }

    #[test]
    fn openalex_accepts_only_titles_above_the_threshold() {
        let body = include_str!("../fixtures/openalex-attention.json");
        let hit = parse_openalex(body, "Attention Is All You Need").unwrap().expect("match");
        assert_eq!(hit.source_name, "openalex");
        assert!(hit.confidence >= TITLE_MATCH_THRESHOLD);
        assert_eq!(hit.authors[0].affiliation.as_deref(), Some("Google (United States)"));
        assert_eq!(hit.r#abstract, "The dominant sequence");
        assert_eq!(hit.year, Some(2017));
        assert!(parse_openalex(body, "Quantum error correction on a lattice").unwrap().is_none());
    }

    #[test]
    fn semantic_scholar_uses_the_same_title_threshold() {
        let body = include_str!("../fixtures/semanticscholar-attention.json");
        let hit = parse_semantic_scholar(body, "Attention Is All You Need").unwrap().expect("match");
        assert_eq!(hit.arxiv_id.as_deref(), Some("1706.03762"));
        assert_eq!(hit.authors[0].affiliation.as_deref(), Some("Google Brain"));
        assert!(parse_semantic_scholar(body, "Unrelated protein folding").unwrap().is_none());
    }

    #[test]
    fn rejects_non_http_pdf_links() {
        let xml = r#"<entry><title>T</title><summary>S</summary><id>http://arxiv.org/abs/1706.03762v1</id><link href="javascript:alert(1)" /></entry>"#;
        let hit = parse_arxiv_atom(xml).unwrap();
        assert!(hit.pdf_url.is_none());
    }
}
