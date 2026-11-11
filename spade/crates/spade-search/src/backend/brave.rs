//! Brave Search API: `GET {base}web/search?q=…&count=N` with `X-Subscription-Token`.

use serde::Deserialize;

use super::{http_reason, transport_reason};

#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    web: Option<Web>,
}

#[derive(Deserialize)]
struct Web {
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
    description: String,
}

pub(crate) async fn search(
    http: &reqwest::Client,
    base_url: &str,
    key: &str,
    query: &str,
    count: usize,
) -> Result<Vec<(String, String, String)>, String> {
    let response = http
        .get(format!("{base_url}web/search"))
        .query(&[("q", query), ("count", &count.to_string())])
        .header("Accept", "application/json")
        .header("X-Subscription-Token", key)
        .send()
        .await
        .map_err(|e| transport_reason(&e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(http_reason(status, "Brave"));
    }
    let page: Page = response.json().await.map_err(|e| transport_reason(&e))?;
    Ok(page
        .web
        .map(|web| web.results)
        .unwrap_or_default()
        .into_iter()
        .map(|item| (item.title, item.url, item.description))
        .collect())
}
