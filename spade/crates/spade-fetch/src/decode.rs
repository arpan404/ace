//! Bytes to text in the page's own character encoding. Pure.
//!
//! The encoding is the first of: a byte order mark, the `charset` of the `Content-Type` header,
//! for HTML a `<meta charset>` (or `http-equiv` content type) in the first 1024 bytes, and
//! UTF-8. Bytes that do not decode become U+FFFD.

use encoding_rs::{Encoding, UTF_8};

/// How far into an HTML page a `<meta charset>` is looked for.
const META_PREFIX: usize = 1024;

/// `bytes` decoded, given the header's `charset` (if any) and whether the body is HTML.
#[must_use]
pub fn decode(bytes: &[u8], charset: Option<&str>, html: bool) -> String {
    let declared = charset.and_then(|label| Encoding::for_label(label.trim().as_bytes()));
    let sniffed = || {
        html.then(|| meta_charset(&bytes[..bytes.len().min(META_PREFIX)]))
            .flatten()
    };
    let encoding = declared.or_else(sniffed).unwrap_or(UTF_8);
    // `decode` lets a byte order mark override the choice and strips it.
    let (text, _, _) = encoding.decode(bytes);
    text.into_owned()
}

/// The `charset` value of a `Content-Type` header, if it names one.
#[must_use]
pub fn header_charset(content_type: &str) -> Option<String> {
    content_type.split(';').skip(1).find_map(|param| {
        let (key, value) = param.split_once('=')?;
        key.trim()
            .eq_ignore_ascii_case("charset")
            .then(|| value.trim().trim_matches(['"', '\'']).to_owned())
            .filter(|v| !v.is_empty())
    })
}

/// The encoding a `<meta>` in `prefix` declares. A page cannot declare UTF-16 this way, as it
/// would not have been readable as ASCII to get here, so that is read as UTF-8.
fn meta_charset(prefix: &[u8]) -> Option<&'static Encoding> {
    let lower = prefix.to_ascii_lowercase();
    let mut at = 0;
    while let Some(found) = find(&lower, at, b"<meta") {
        let end = find(&lower, found, b">").unwrap_or(lower.len());
        let tag = &lower[found..end];
        at = end;
        let Some(pos) = find(tag, 0, b"charset") else {
            continue;
        };
        let mut rest = &tag[pos + b"charset".len()..];
        rest = rest.trim_ascii_start();
        let Some(after_eq) = rest.strip_prefix(b"=") else {
            continue;
        };
        let value = after_eq.trim_ascii_start();
        let value = value
            .strip_prefix(b"\"")
            .or_else(|| value.strip_prefix(b"'"))
            .unwrap_or(value);
        let len = value
            .iter()
            .position(|b| b.is_ascii_whitespace() || matches!(b, b'"' | b'\'' | b';' | b'/' | b'>'))
            .unwrap_or(value.len());
        if let Some(encoding) = Encoding::for_label(&value[..len]) {
            return Some(encoding.output_encoding());
        }
    }
    None
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}
