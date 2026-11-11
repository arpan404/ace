//! The person's own SearXNG: `GET {base}search?q=…&format=json`. JSON must be enabled in its
//! `settings.yml` (`search.formats`), or SearXNG answers 403.

use serde::Deserialize;

use super::{http_reason, transport_reason};

#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    results: Vec<Item>,
}

#[derive(Deserialize)]
struct Item {
    #[serde(default)]
    url: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    content: String,
}

pub(crate) async fn search(
    http: &reqwest::Client,
    base_url: &str,
    query: &str,
) -> Result<Vec<(String, String, String)>, String> {
    let response = http
        .get(format!("{base_url}search"))
        .query(&[("q", query), ("format", "json"), ("pageno", "1")])
        .send()
        .await
        .map_err(|e| transport_reason(&e))?;
    let status = response.status();
    if status.as_u16() == 403 {
        return Err(
            "SearXNG refused JSON: add json to search.formats in its settings.yml".to_owned(),
        );
    }
    if !status.is_success() {
        return Err(http_reason(status, "SearXNG"));
    }
    let page: Page = response.json().await.map_err(|e| transport_reason(&e))?;
    Ok(page
        .results
        .into_iter()
        .map(|item| (item.title, item.url, item.content))
        .collect())
}
