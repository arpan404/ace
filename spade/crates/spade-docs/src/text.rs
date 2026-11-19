//! Plain text, and the tidying every document's text gets before it is kept.

use crate::{Extracted, Kind, Limits};

/// UTF-8 text as it is (sniffing checked it is UTF-8), without a byte-order mark.
pub fn read(bytes: &[u8]) -> Extracted {
    read_as(bytes, Kind::Text)
}

pub fn read_as(bytes: &[u8], kind: Kind) -> Extracted {
    let body = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    Extracted {
        kind,
        text: String::from_utf8_lossy(body).into_owned(),
        pages: None,
        sheets: None,
        cut: false,
    }
}

/// `text` as kept: `\r` and control characters other than tab, newline and form feed (which
/// separates PDF pages) gone, spaces at line ends trimmed, more than two blank lines in a row
/// made two, and cut at the character and byte limits. Answers the text and whether it was cut.
pub fn tidy(text: &str, limits: &Limits) -> (String, bool) {
    let mut out = String::with_capacity(text.len().min(limits.text_bytes));
    let mut blank = 0usize;
    let mut chars = 0usize;
    let mut cut = false;
    for line in text.split('\n') {
        let line: String = line
            .chars()
            .filter(|c| !c.is_control() || *c == '\t' || *c == '\x0c')
            .collect();
        let line = line.trim_end();
        if line.is_empty() {
            blank += 1;
            if blank > 2 {
                continue;
            }
        } else {
            blank = 0;
        }
        let count = line.chars().count() + 1;
        if chars + count > limits.chars || out.len() + line.len() + 1 > limits.text_bytes {
            let room = limits
                .chars
                .saturating_sub(chars)
                .min(limits.text_bytes.saturating_sub(out.len()) / 4);
            out.extend(line.chars().take(room));
            cut = true;
            break;
        }
        out.push_str(line);
        out.push('\n');
        chars += count;
    }
    let trimmed = out.trim().len();
    if trimmed != out.len() {
        out = out.trim().to_owned();
    }
    (out, cut)
}
