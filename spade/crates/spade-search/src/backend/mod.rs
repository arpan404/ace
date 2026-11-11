//! One module per search service. Each turns a query into raw `(title, url, snippet)` triples or a
//! short reason it could not, which never contains the key.

pub(crate) mod brave;
pub(crate) mod searxng;

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

/// A request error in a few words, without the URL (which can carry the query).
pub(crate) fn transport_reason(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timed out".to_owned()
    } else if error.is_connect() {
        "could not connect".to_owned()
    } else if error.is_decode() {
        "answered with something that is not the expected JSON".to_owned()
    } else {
        "the request failed".to_owned()
    }
}
