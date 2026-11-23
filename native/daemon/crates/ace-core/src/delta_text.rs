// SPDX-License-Identifier: Apache-2.0
//! The text-stream helpers `items.ts` takes from `@ace/projection`
//! (`delta.ts`): appending text, reasoning and shell output, splitting
//! output into transport deltas, and summarizing shell streams. JavaScript
//! string indexing counts UTF-16 code units, so every length, slice and
//! boundary below runs on UTF-16 units; UTF-8 bytes are only measured for
//! budgets, exactly like `TextEncoder` does.

/// UTF-16 code units of a string, like `charCodeAt` indexing.
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// UTF-8 bytes of a string as `TextEncoder` writes it.
fn utf8_bytes(text: &str) -> usize {
    text.len()
}

fn is_high(unit: u16) -> bool {
    (0xd800..0xdc00).contains(&unit)
}

fn is_low(unit: u16) -> bool {
    (0xdc00..0xe000).contains(&unit)
}

const BOM: u16 = 0xfeff;

/// JSON-escaped size of one UTF-8 lead byte, like `serializedBytes`.
fn serialized_bytes(byte: u8) -> usize {
    if byte == b'"' || byte == b'\\' {
        return 2;
    }
    if byte < 0x80 {
        if [8, 9, 10, 12, 13].contains(&byte) {
            return 2;
        }
        return if byte < 32 { 6 } else { 1 };
    }
    if byte < 0xe0 {
        2
    } else if byte < 0xf0 {
        3
    } else {
        4
    }
}

/// UTF-8 length of one UTF-16 unit, like `characterBytes` on the lead byte.
fn character_bytes(byte: u8) -> usize {
    if byte < 0x80 {
        1
    } else if byte < 0xe0 {
        2
    } else if byte < 0xf0 {
        3
    } else {
        4
    }
}

fn ascii_cost(unit: u16) -> usize {
    if unit == 34 || unit == 92 {
        2
    } else if unit >= 32 {
        1
    } else if [8, 9, 10, 12, 13].contains(&(unit as u8)) {
        2
    } else {
        6
    }
}

/// UTF-8 bytes of a string as `TextEncoder` writes it: a lone surrogate
/// becomes U+FFFD (3 bytes). Strings here never hold lone surrogates (the
/// napi boundary already replaced them), so this matches exactly.
fn utf8_length(text: &str) -> usize {
    let units = units(text);
    let mut bytes = 0;
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if unit < 0x80 {
            bytes += 1;
        } else if unit < 0x800 {
            bytes += 2;
        } else if is_high(unit) && units.get(index + 1).is_some_and(|next| is_low(*next)) {
            bytes += 4;
            index += 1;
        } else {
            bytes += 3;
        }
        index += 1;
    }
    bytes
}

/// Decode bytes that end on whole UTF-8 characters.
fn decode_valid(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// The longest suffix of whole characters within the 4 KiB transport budget,
/// read off the string without encoding it. `None` when a lone surrogate or
/// a U+FEFF falls inside it: the caller takes the encoding path instead.
fn scan_tail(text: &str) -> Option<(String, usize)> {
    let units = units(text);
    let mut start = units.len();
    let mut size = 0;
    let mut bytes = 0;
    while start > 0 {
        let unit = units[start - 1];
        let mut width = 1;
        let cost = if unit < 0x80 {
            ascii_cost(unit)
        } else if unit < 0x800 {
            2
        } else if is_low(unit) && start >= 2 && is_high(units[start - 2]) {
            width = 2;
            4
        } else if is_high(unit) || is_low(unit) {
            return None;
        } else {
            3
        };
        if size + cost > 4096 {
            break;
        }
        if unit == BOM {
            return None;
        }
        size += cost;
        bytes += if unit < 0x80 { 1 } else { cost };
        start -= width;
    }
    let tail = String::from_utf16(&units[start..]).unwrap_or_default();
    Some((tail, bytes))
}

/// Whether well-formed text fits one delta's 4 KiB transport budget whole.
fn fits_one_delta(text: &str) -> bool {
    let units = units(text);
    if units.first() == Some(&BOM) {
        return false;
    }
    let mut size = 0;
    let mut index = 0;
    while index < units.len() {
        let unit = units[index];
        if unit < 0x80 {
            size += ascii_cost(unit);
        } else if unit < 0x800 {
            size += 2;
        } else if is_high(unit) && units.get(index + 1).is_some_and(|next| is_low(*next)) {
            size += 4;
            index += 1;
        } else if is_high(unit) || is_low(unit) {
            return false;
        } else {
            size += 3;
        }
        if size > 4096 {
            return false;
        }
        index += 1;
    }
    true
}

/// Split output at whole characters, budgeting both UTF-8 and JSON bytes.
pub fn output_deltas(text: &str) -> Vec<String> {
    if fits_one_delta(text) {
        return vec![text.to_owned()];
    }
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return vec![String::new()];
    }
    let mut parts = Vec::new();
    let mut start = 0;
    let mut size = 0;
    let mut end = 0;
    while end < bytes.len() {
        let byte = bytes[end];
        let cost = serialized_bytes(byte);
        if size + cost > 4096 {
            parts.push(decode_valid(&bytes[start..end]));
            start = end;
            size = 0;
        }
        size += cost;
        end += character_bytes(byte);
    }
    parts.push(decode_valid(&bytes[start..]));
    parts
}

/// The reference encoding path: slice the tail, then walk back whole
/// characters within the serialized budget.
fn encoded_tail(text: &str) -> String {
    let tail_bytes = utf8_slice_tail(text, 4096);
    let mut start = tail_bytes.len();
    let mut size = 0;
    while start > 0 {
        let mut next = start - 1;
        while tail_bytes.get(next).is_some_and(|byte| byte & 0xc0 == 0x80) {
            next -= 1;
        }
        let cost = serialized_bytes(tail_bytes[next]);
        if size + cost > 4096 {
            break;
        }
        size += cost;
        start = next;
    }
    decode_valid(&tail_bytes[start..])
}

/// Whole UTF-8 characters within the byte budget from the tail.
fn utf8_slice_tail(text: &str, limit: usize) -> Vec<u8> {
    let bytes = text.as_bytes();
    let mut start = bytes.len().saturating_sub(limit);
    while start < bytes.len() && bytes[start] & 0xc0 == 0x80 {
        start += 1;
    }
    bytes[start..].to_vec()
}

/// Whole UTF-8 characters within the byte budget from the head.
fn utf8_slice_head(text: &str, limit: usize) -> Vec<u8> {
    let bytes = text.as_bytes();
    if bytes.len() <= limit {
        return bytes.to_vec();
    }
    let mut end = limit;
    while end > 0 && bytes[end] & 0xc0 == 0x80 {
        end -= 1;
    }
    bytes[..end].to_vec()
}

/// Summarize a shell stream after one more append: the whole stream's byte
/// count and its last 4 KiB, exactly like `summarizeOutput`.
pub fn summarize_output(item_id: &str, append: &str, previous: Option<&OutputSummaryView>) -> OutputSummaryData {
    let added_bytes = utf8_length(append);
    let bytes = previous.map_or(0, |summary| summary.bytes) + added_bytes as i64;
    let stream_id = previous.map_or_else(
        || format!("output:{item_id}"),
        |summary| summary.stream_id.clone(),
    );
    let previous_tail = previous.map_or("", |summary| summary.tail.as_str());
    let kept = if added_bytes >= 4096 {
        scan_tail(append)
    } else if units(append).first().is_some_and(|unit| is_low(*unit)) {
        None
    } else {
        scan_tail(&format!("{previous_tail}{append}"))
    };
    if let Some((tail, tail_bytes)) = kept {
        let tail_len = tail_bytes as i64;
        return OutputSummaryData {
            stream_id,
            bytes,
            tail,
            truncated: bytes > tail_len,
        };
    }
    let tail = if added_bytes >= 4096 {
        encoded_tail(append)
    } else {
        let head = utf8_slice_head(append, 4096);
        let mut joined = Vec::with_capacity(previous_tail.as_bytes().len() + head.len());
        joined.extend_from_slice(previous_tail.as_bytes());
        joined.extend_from_slice(&head);
        encoded_tail(&decode_valid(&joined))
    };
    let tail_bytes = utf8_bytes(&tail) as i64;
    OutputSummaryData {
        stream_id,
        bytes,
        tail,
        truncated: bytes > tail_bytes,
    }
}

/// A previously summarized shell stream.
pub struct OutputSummaryView {
    /// The stream's id (`output:<item id>`).
    pub stream_id: String,
    /// The whole stream's length in UTF-8 bytes.
    pub bytes: i64,
    /// Its last 4 KiB.
    pub tail: String,
}

/// The summary `summarizeOutput` returns.
pub struct OutputSummaryData {
    /// The stream's id (`output:<item id>`).
    pub stream_id: String,
    /// The whole stream's length in UTF-8 bytes.
    pub bytes: i64,
    /// Its last 4 KiB.
    pub tail: String,
    /// Whether the tail is shorter than the stream.
    pub truncated: bool,
}

/// Whether a text carries its stream's end, so a delta extends it.
pub fn holds_tail(text: &str, source: Option<&TextSourceView>) -> bool {
    match source {
        None => true,
        Some(source) => {
            source.offset.unwrap_or(0) + units(text).len() as i64 * 2 == source.bytes
        }
    }
}

/// The source of a text preview.
pub struct TextSourceView {
    /// The stream's whole length in UTF-16LE bytes.
    pub bytes: i64,
    /// Where the carried text starts in it.
    pub offset: Option<i64>,
}

/// Append to a text, keeping its source's byte count exact.
pub fn append_text(text: &mut String, source: &mut Option<TextSourceData>, append: &str) {
    let holds = match source {
        None => true,
        Some(source) => {
            source.offset.unwrap_or(0) + units(text).len() as i64 * 2 == source.bytes
        }
    };
    if holds {
        text.push_str(append);
    }
    if let Some(source) = source {
        source.bytes += units(append).len() as i64 * 2;
    }
}

/// The source of a text preview, owned.
pub struct TextSourceData {
    /// The stream's whole length in UTF-16LE bytes.
    pub bytes: i64,
    /// Where the carried text starts in it.
    pub offset: Option<i64>,
}
