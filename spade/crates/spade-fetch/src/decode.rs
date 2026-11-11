//! Bytes to text in the page's own character encoding. Pure.
//!
//! The encoding is the first of: a byte order mark, the `charset` of the `Content-Type` header,
//! for HTML a `<meta charset>` (or `http-equiv` content type) in the first 1024 bytes, then
//! UTF-8 if the bytes are valid UTF-8 and windows-1252 if not. Bytes a declared encoding cannot
//! decode become U+FFFD.

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
    // Old pages often declare nothing and are not UTF-8; those read best as windows-1252.
    let fallback = || {
        if std::str::from_utf8(bytes).is_ok() || Encoding::for_bom(bytes).is_some() {
            UTF_8
        } else {
            encoding_rs::WINDOWS_1252
        }
    };
    let encoding = declared.or_else(sniffed).unwrap_or_else(fallback);
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

/// The encoding a `<meta>` in `prefix` declares, found the way the HTML standard's prescan
/// does: comments, other tags and their attributes are skipped whole, attribute names are
/// matched whole, `content=` counts only with `http-equiv="content-type"`, and a tag cut off by
/// the end of `prefix` is not read. UTF-16 is read as UTF-8 (a page cannot declare it this way,
/// as it would not have been readable as ASCII to get here) and x-user-defined as windows-1252.
fn meta_charset(prefix: &[u8]) -> Option<&'static Encoding> {
    let mut at = 0;
    while at < prefix.len() {
        let rest = &prefix[at..];
        if rest.starts_with(b"<!--") {
            // The `-->` may share its dashes with the `<!--`, so `<!-->` is a whole comment.
            at += find(rest, 2, b"-->")? + 3;
        } else if starts_with_ignore_case(rest, b"<meta")
            && rest.get(5).is_some_and(|b| is_space(*b) || *b == b'/')
        {
            let (found, end) = meta(prefix, at + 5)?;
            if found.is_some() {
                return found;
            }
            at = end;
        } else if rest.len() >= 2
            && rest[0] == b'<'
            && (rest[1].is_ascii_alphabetic()
                || (rest[1] == b'/' && rest.get(2).is_some_and(u8::is_ascii_alphabetic)))
        {
            let mut pos = at + 1;
            while prefix.get(pos).is_some_and(|b| !is_space(*b) && *b != b'>') {
                pos += 1;
            }
            while let Some((_, _, next)) = attribute(prefix, pos)? {
                pos = next;
            }
            at = pos + 1;
        } else if rest.starts_with(b"<!") || rest.starts_with(b"</") || rest.starts_with(b"<?") {
            at += find(rest, 0, b">")? + 1;
        } else {
            at += 1;
        }
    }
    None
}

/// Reads the attributes of a `<meta>` from `from`. Returns the encoding it declares, if any, and
/// where the tag ends; `None` when the prefix ends first.
fn meta(prefix: &[u8], from: usize) -> Option<(Option<&'static Encoding>, usize)> {
    let mut seen: Vec<Vec<u8>> = Vec::new();
    let mut got_pragma = false;
    let mut need_pragma: Option<bool> = None;
    let mut charset: Option<&'static Encoding> = None;
    let mut pos = from;
    while let Some((name, value, next)) = attribute(prefix, pos)? {
        pos = next;
        if seen.contains(&name) {
            continue;
        }
        match name.as_slice() {
            b"http-equiv" if value.eq_ignore_ascii_case(b"content-type") => got_pragma = true,
            b"content" if charset.is_none() => {
                if let Some(label) = charset_in_content(&value) {
                    charset = Encoding::for_label(label);
                    need_pragma = Some(true);
                }
            }
            b"charset" => {
                charset = Encoding::for_label(value.trim_ascii());
                need_pragma = Some(false);
            }
            _ => {}
        }
        seen.push(name);
    }
    let end = pos + 1;
    let declared = match need_pragma {
        None => None,
        Some(true) if !got_pragma => None,
        Some(_) => charset,
    };
    let declared = declared.map(|e| {
        if e == encoding_rs::X_USER_DEFINED {
            encoding_rs::WINDOWS_1252
        } else {
            e.output_encoding()
        }
    });
    Some((declared, end))
}

/// The next attribute at or after `pos`: its lowercased name, its value and where reading goes
/// on. `Some(None)` at the tag's `>`; `None` when the prefix ends first.
#[allow(clippy::type_complexity)]
fn attribute(prefix: &[u8], mut pos: usize) -> Option<Option<(Vec<u8>, Vec<u8>, usize)>> {
    while prefix.get(pos).is_some_and(|b| is_space(*b) || *b == b'/') {
        pos += 1;
    }
    if *prefix.get(pos)? == b'>' {
        return Some(None);
    }
    let mut name = Vec::new();
    loop {
        let b = *prefix.get(pos)?;
        if !name.is_empty() && (b == b'=' || is_space(b) || b == b'/' || b == b'>') {
            break;
        }
        name.push(b.to_ascii_lowercase());
        pos += 1;
    }
    while prefix.get(pos).is_some_and(|b| is_space(*b)) {
        pos += 1;
    }
    if prefix.get(pos) != Some(&b'=') {
        return Some(Some((name, Vec::new(), pos)));
    }
    pos += 1;
    while prefix.get(pos).is_some_and(|b| is_space(*b)) {
        pos += 1;
    }
    let mut value = Vec::new();
    match *prefix.get(pos)? {
        quote @ (b'"' | b'\'') => {
            pos += 1;
            loop {
                let b = *prefix.get(pos)?;
                pos += 1;
                if b == quote {
                    break;
                }
                value.push(b.to_ascii_lowercase());
            }
        }
        b'>' => {}
        _ => {
            while let Some(&b) = prefix.get(pos) {
                if is_space(b) || b == b'>' {
                    break;
                }
                value.push(b.to_ascii_lowercase());
                pos += 1;
            }
            prefix.get(pos)?;
        }
    }
    Some(Some((name, value, pos)))
}

/// The label in a `content` value such as `text/html; charset=utf-8`.
fn charset_in_content(content: &[u8]) -> Option<&[u8]> {
    let mut at = 0;
    loop {
        at = find(content, at, b"charset")?;
        let mut pos = at + b"charset".len();
        while content.get(pos).is_some_and(|b| is_space(*b)) {
            pos += 1;
        }
        if content.get(pos) != Some(&b'=') {
            at = pos;
            continue;
        }
        pos += 1;
        while content.get(pos).is_some_and(|b| is_space(*b)) {
            pos += 1;
        }
        return match *content.get(pos)? {
            quote @ (b'"' | b'\'') => {
                let len = content[pos + 1..].iter().position(|b| *b == quote)?;
                Some(&content[pos + 1..pos + 1 + len])
            }
            _ => {
                let len = content[pos..]
                    .iter()
                    .position(|b| is_space(*b) || *b == b';')
                    .unwrap_or(content.len() - pos);
                Some(&content[pos..pos + len])
            }
        };
    }
}

fn is_space(b: u8) -> bool {
    matches!(b, b'\t' | b'\n' | b'\x0c' | b'\r' | b' ')
}

fn starts_with_ignore_case(hay: &[u8], needle: &[u8]) -> bool {
    hay.get(..needle.len())
        .is_some_and(|h| h.eq_ignore_ascii_case(needle))
}

/// Where `needle` starts at or after `from`, as an offset from the start of `hay`.
fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}
