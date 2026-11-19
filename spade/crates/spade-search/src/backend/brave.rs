//! Brave Search API: `GET {base}web/search?q=…&count=N` with `X-Subscription-Token`.

use super::{MOST_BODY_BYTES, http_reason, json_body, transport_reason, triples};

/// `http` must not follow redirects: the key is a custom header, which a client keeps when
/// following one to another server.
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
    if status.is_redirection() {
        return Err(format!(
            "Brave redirected the request (HTTP {status}), which is not followed with a key"
        ));
    }
    if !status.is_success() {
        return Err(http_reason(status, "Brave"));
    }
    let page = json_body(response, MOST_BODY_BYTES).await?;
    Ok(triples(
        page.get("web").and_then(|web| web.get("results")),
        "description",
    ))
}
