//! Reading ace cloud's answers: a size-capped body and lenient result items. Pure apart from
//! reading the body.

use serde_json::Value;

/// The largest answer body read from ace cloud, in bytes. Larger answers are refused.
pub(crate) const MOST_BODY_BYTES: usize = 256 * 1024;

/// One raw result: title, address, snippet, site.
pub(crate) struct Raw {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub site: String,
}

/// Why a body could not be read.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum BodyError {
    TooBig,
    Transport,
    NotJson,
}

/// Reads the body as JSON, refusing it once it grows past `most` bytes without reading further.
pub(crate) async fn json_body(
    mut response: reqwest::Response,
    most: usize,
) -> Result<Value, BodyError> {
    if response
        .content_length()
        .is_some_and(|length| length > most as u64)
    {
        return Err(BodyError::TooBig);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| BodyError::Transport)? {
        if body.len() + chunk.len() > most {
            return Err(BodyError::TooBig);
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| BodyError::NotJson)
}

/// Decodes each result on its own: an item without a string url is skipped, and a missing, null
/// or non-text title, snippet or site becomes empty, so one odd item never loses the rest.
pub(crate) fn items(items: Option<&Value>) -> Vec<Raw> {
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
            Some(Raw {
                title: text(item, "title"),
                url: url.to_owned(),
                snippet: text(item, "snippet"),
                site: text(item, "site"),
            })
        })
        .collect()
}

/// Whether ace cloud may be called at `address` with a bearer: `https`, or `http` on this
/// machine only (development).
pub(crate) fn secure_cloud_url(address: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(address) else {
        return false;
    };
    match url.scheme() {
        "https" => url.host_str().is_some(),
        "http" => url.host_str().is_some_and(|host| {
            let bare = host.trim_start_matches('[').trim_end_matches(']');
            host == "localhost"
                || bare
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn odd_items_are_skipped_or_emptied_and_good_ones_kept() {
        let list = json!([
            { "url": "https://a.example/", "title": "A", "snippet": "a", "site": "a.example", "rank": 1 },
            { "url": "https://b.example/", "title": 7, "snippet": null },
            { "title": "no url", "snippet": "x" },
            { "url": null, "title": "null url" },
            { "url": 42 },
            "not an object",
            { "url": "https://c.example/" }
        ]);
        let kept: Vec<_> = items(Some(&list))
            .into_iter()
            .map(|r| (r.url, r.title, r.snippet, r.site))
            .collect();
        assert_eq!(
            kept,
            vec![
                (
                    "https://a.example/".into(),
                    "A".into(),
                    "a".into(),
                    "a.example".into()
                ),
                (
                    "https://b.example/".into(),
                    String::new(),
                    String::new(),
                    String::new()
                ),
                (
                    "https://c.example/".into(),
                    String::new(),
                    String::new(),
                    String::new()
                ),
            ]
        );
        assert!(items(None).is_empty());
        assert!(items(Some(&json!({ "url": "https://a.example/" }))).is_empty());
    }

    #[test]
    fn only_https_or_loopback_http_carries_the_grant() {
        for address in [
            "https://cloud.acehq.dev",
            "http://localhost:8080",
            "http://127.0.0.2",
            "http://[::1]:8080",
        ] {
            assert!(secure_cloud_url(address), "{address}");
        }
        for address in [
            "http://cloud.acehq.dev",
            "ftp://localhost",
            "http://localhost.evil",
            "http://10.0.0.1",
            "broken",
        ] {
            assert!(!secure_cloud_url(address), "{address}");
        }
    }
}
