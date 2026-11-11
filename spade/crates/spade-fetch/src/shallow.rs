//! A cheap guard in front of the HTML parser, whose time grows with the square of nesting depth.
//! A linear scan estimates how many elements are open and cuts the source where that passes
//! [`MOST_OPEN`]. Real pages stay far below it; a hostile page of endless `<div>`s is cut short.

/// The deepest nesting kept. Elements whose end tag may be left out (`p`, `li`, `td` and so on)
/// and void elements are not counted, so sloppy but ordinary pages never reach it.
pub const MOST_OPEN: usize = 512;

/// `source` up to where nesting first passes [`MOST_OPEN`], or all of it.
#[must_use]
pub fn shallow(source: &str) -> &str {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut at = 0;
    while let Some(lt) = find(bytes, at, b"<") {
        let rest = &bytes[lt + 1..];
        if rest.starts_with(b"!--") {
            at = find(bytes, lt + 4, b"-->").map_or(bytes.len(), |end| end + 3);
            continue;
        }
        let closing = rest.first() == Some(&b'/');
        let name_start = lt + 1 + usize::from(closing);
        let name_len = bytes[name_start..]
            .iter()
            .take_while(|b| b.is_ascii_alphanumeric())
            .count();
        if name_len == 0 {
            at = lt + 1;
            continue;
        }
        let name = source[name_start..name_start + name_len].to_ascii_lowercase();
        let Some(gt) = find(bytes, name_start + name_len, b">") else {
            break;
        };
        at = gt + 1;
        if !counted(&name) {
            continue;
        }
        if closing {
            depth = depth.saturating_sub(1);
        } else if bytes[gt - 1] != b'/' {
            if raw_text(&name) {
                at = close_of(bytes, at, &name).unwrap_or(bytes.len());
                continue;
            }
            depth += 1;
            if depth > MOST_OPEN {
                return &source[..lt];
            }
        }
    }
    source
}

fn find(hay: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|i| i + from)
}

/// Where the `</name` that ends a raw-text element starts, searching from `from`.
fn close_of(bytes: &[u8], from: usize, name: &str) -> Option<usize> {
    let mut at = from;
    while let Some(lt) = find(bytes, at, b"</") {
        let tail = bytes.get(lt + 2..lt + 2 + name.len())?;
        if tail.eq_ignore_ascii_case(name.as_bytes()) {
            return Some(lt);
        }
        at = lt + 2;
    }
    None
}

fn raw_text(name: &str) -> bool {
    matches!(
        name,
        "script"
            | "style"
            | "textarea"
            | "title"
            | "xmp"
            | "iframe"
            | "noembed"
            | "noframes"
            | "plaintext"
    )
}

fn counted(name: &str) -> bool {
    !matches!(
        name,
        // void
        "area" | "base" | "br" | "col" | "embed" | "hr" | "img" | "input" | "link" | "meta"
            | "source" | "track" | "wbr" | "param" | "keygen"
            // end tag may be left out
            | "html" | "head" | "body" | "p" | "li" | "dt" | "dd" | "option" | "optgroup"
            | "tr" | "td" | "th" | "thead" | "tbody" | "tfoot" | "colgroup" | "caption"
            | "rb" | "rt" | "rtc" | "rp"
    )
}
