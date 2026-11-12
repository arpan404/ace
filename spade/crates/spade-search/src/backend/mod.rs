//! One module per search service. Each turns a query into raw `(title, url, snippet)` triples or a
//! short reason it could not, which never contains the key.

pub(crate) mod brave;
pub(crate) mod searxng;

use serde_json::Value;

/// The largest answer body read from a backend, in bytes. Larger answers are refused.
pub(crate) const MOST_BODY_BYTES: usize = 2 * 1024 * 1024;

/// Why a backend gave no results.
pub(crate) fn http_reason(status: reqwest::StatusCode, service: &str) -> String {
    match status.as_u16() {
        401 | 403 => {
            format!("{service} refused the request (HTTP {status}): check the key or settings")
        }
        429 => format!("{service} is rate limiting (HTTP 429)"),
        _ => format!("{service} answered HTTP {status}"),
    }
}

/// The reason given when nothing listens at a backend's address.
pub(crate) const NO_CONNECTION: &str = "could not connect";

/// A request error in a few words, without the URL (which can carry the query).
pub(crate) fn transport_reason(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timed out".to_owned()
    } else if error.is_connect() {
        NO_CONNECTION.to_owned()
    } else if error.is_decode() {
        "answered with something that is not the expected JSON".to_owned()
    } else {
        "the request failed".to_owned()
    }
}

/// Reads the body as JSON, refusing it once it grows past `most` bytes without reading further.
pub(crate) async fn json_body(
    mut response: reqwest::Response,
    most: usize,
) -> Result<Value, String> {
    let too_big = || format!("answered with more than {} KiB", most / 1024);
    if response
        .content_length()
        .is_some_and(|length| length > most as u64)
    {
        return Err(too_big());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| transport_reason(&e))? {
        if body.len() + chunk.len() > most {
            return Err(too_big());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| "answered with something that is not the expected JSON".to_owned())
}

/// Decodes each result on its own: an item without a usable url is skipped, and a missing, null
/// or non-text title or snippet becomes empty, so one odd item never loses the rest.
pub(crate) fn triples(items: Option<&Value>, snippet: &str) -> Vec<(String, String, String)> {
    let text = |item: &Value, field: &str| {
        item.get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    items
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|item| {
            let url = item.get("url").and_then(Value::as_str)?;
            Some((text(item, "title"), url.to_owned(), text(item, snippet)))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::triples;

    #[test]
    fn odd_items_are_skipped_or_emptied_and_good_ones_kept() {
        let items = json!([
            { "url": "https://a.example/", "title": "A", "content": "a" },
            { "url": "https://b.example/", "title": 7, "content": null },
            { "title": "no url", "content": "x" },
            { "url": null, "title": "null url" },
            "not an object",
            { "url": "https://c.example/" }
        ]);
        assert_eq!(
            triples(Some(&items), "content"),
            vec![
                ("A".into(), "https://a.example/".into(), "a".into()),
                (String::new(), "https://b.example/".into(), String::new()),
                (String::new(), "https://c.example/".into(), String::new()),
            ]
        );
    }

    #[test]
    fn results_that_are_missing_or_not_a_list_give_nothing() {
        assert!(triples(None, "content").is_empty());
        assert!(triples(Some(&json!({ "url": "https://a.example/" })), "content").is_empty());
    }
}
