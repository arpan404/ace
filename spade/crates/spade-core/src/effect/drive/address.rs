//! A web address as a browser reads it (WHATWG URL parsing, IDNA mapping), so a host written with
//! percent escapes (`%70aypal.com`), full-width letters (`ｐａｙｐａｌ.com`) or a trailing dot is
//! the host it loads, and a path, query or `#/route` is read with its escapes decoded. Pure.

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use url::Url;

/// A page, as a step is bound to it and as its parts are classified.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Page {
    /// The whole address, serialized as a browser would (`URL.href`): scheme, host, port, path,
    /// query and fragment. A step runs only at this address.
    pub url: String,
    /// Lower case, IDNA-mapped, without a trailing dot or a leading `www.`: what a site grant
    /// names.
    pub host: String,
    /// The path, decoded and in lower case.
    pub path: String,
    /// The query, decoded and in lower case (`view=settings`).
    #[serde(default)]
    pub query: String,
    /// The fragment, decoded and in lower case: a single-page app's route.
    #[serde(default)]
    pub fragment: String,
}

/// The page at an `http` or `https` address; `None` for anything else (`about:blank`,
/// `chrome://settings`, `javascript:`) or an address that doesn't parse.
pub fn parse(text: &str) -> Option<Page> {
    let url = Url::parse(text.trim()).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host).to_owned();
    if host.is_empty() {
        return None;
    }
    Some(Page {
        url: url.as_str().to_owned(),
        host,
        path: decoded(url.path()),
        query: decoded(&url.query().unwrap_or("").replace('+', " ")),
        fragment: decoded(url.fragment().unwrap_or("")),
    })
}

/// Escapes decoded (twice, so `%2573` reads as `s`), in lower case.
fn decoded(text: &str) -> String {
    let once = percent_decode_str(text).decode_utf8_lossy().into_owned();
    percent_decode_str(&once).decode_utf8_lossy().to_lowercase()
}
