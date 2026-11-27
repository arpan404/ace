// SPDX-License-Identifier: Apache-2.0
//! Search hits and snippets, as `@ace/search` `thread-query.ts` reads them.
//!
//! Snippets count UTF-16 code units, as JavaScript string lengths do, so
//! highlight offsets land where the client's do. Nothing here builds a JSON
//! tree; hits serialize in the protocol's field order.

/// One candidate row the hit list reads.
pub struct HitRow {
    pub thread: String,
    pub item: String,
    pub seq: i64,
    pub marked: String,
}

/// One highlight: half-open UTF-16 offsets within the snippet text.
pub struct Highlight {
    pub start: usize,
    pub end: usize,
}

/// A snippet: plain text with up to 256 highlights.
pub struct Snippet {
    pub text: String,
    pub highlights: Vec<Highlight>,
}

/// The snippet of FTS-marked text, counting UTF-16 units as JavaScript does.
pub fn snippet(marked: &str) -> Snippet {
    let units: Vec<u16> = marked.encode_utf16().collect();
    let mut first = units.len();
    for (index, unit) in units.iter().enumerate() {
        if *unit == 1 {
            first = index;
            break;
        }
    }
    let mut offset = 0usize;
    if units.len() > 4096 && first != units.len() && first > 256 {
        offset = first - 256;
    }
    // A split low surrogate belongs to the unit before it.
    if offset < units.len() && (0xDC00..=0xDFFF).contains(&units[offset]) {
        offset += 1;
    }
    let mut source: Vec<u16> = Vec::with_capacity(units.len() + 1);
    if offset > 0 {
        source.push(0x2026);
        source.extend_from_slice(&units[offset..]);
    } else {
        source.extend_from_slice(&units);
    }
    let mut text = String::new();
    let mut text_units = 0usize;
    let mut start: Option<usize> = None;
    let mut highlights = Vec::new();
    for decoded in char::decode_utf16(source) {
        let ch = decoded.unwrap_or(char::REPLACEMENT_CHARACTER);
        if ch == '\u{1}' {
            start = Some(text_units);
        } else if ch == '\u{2}' {
            if let Some(begin) = start.take()
                && highlights.len() < 256
            {
                highlights.push(Highlight {
                    start: begin,
                    end: text_units,
                });
            }
        } else {
            let width = ch.len_utf16();
            if text_units + width > 4096 {
                break;
            }
            text.push(ch);
            text_units += width;
        }
    }
    if let Some(begin) = start
        && highlights.len() < 256
    {
        highlights.push(Highlight {
            start: begin,
            end: text_units,
        });
    }
    Snippet { text, highlights }
}
