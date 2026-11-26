// SPDX-License-Identifier: Apache-2.0
//! Attachment bytes in recorded provider frames.
//!
//! Images, PDFs and other files reach providers inline as base64 or base64
//! data URLs, and providers echo them back in user messages and tool results.
//! Those bytes belong to the attachment, not to the frame: a frame records
//! the structure around them, so frames stay small whatever the person
//! attaches. Each elided string becomes a short marker carrying the decoded
//! size and SHA-256, which is how uploaded attachments are hashed, so an echo
//! can still be matched to the attachment it carries.
//!
//! Ported from `packages/provider-kit/src/binary-elision.ts`; the TypeScript
//! module stays for the daemon code that still uses it.

use ace_json::{JsString, Value};
use sha2::Digest as _;
use std::borrow::Cow;

/// A string at least this long that is only base64 (or a base64 data URL) is
/// attachment bytes.
pub const BINARY_ELISION_CHARS: usize = 16 * 1024;

/// Marker digests are only read off short strings; anything longer cannot be
/// a marker the elider wrote.
const MARKER_MAX_UNITS: usize = 420;

fn is_mime_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'+' | b'-')
}

fn scan_mime(bytes: &[u8], mut at: usize) -> Option<usize> {
    let start = at;
    while at < bytes.len() && is_mime_char(bytes[at]) {
        at += 1;
    }
    (at > start).then_some(at)
}

/// Splits `data:<type>/<subtype>(;<key>=<value>)*;base64,<payload>` exactly
/// like the TypeScript's `dataUrl` pattern, returning the media type and the
/// payload's byte offset. Only ASCII can match, so this scans bytes and
/// slices on boundaries it proved.
fn split_data_url(value: &str) -> Option<(&str, usize)> {
    let bytes = value.as_bytes();
    let mut at = "data:".len();
    if bytes.get(..at) != Some(b"data:") {
        return None;
    }
    let subtype = scan_mime(bytes, at)?;
    if bytes.get(subtype) != Some(&b'/') {
        return None;
    }
    at = scan_mime(bytes, subtype + 1)?;
    // The marker names the media type alone; parameters stay matched but unnamed.
    let mime_end = at;
    loop {
        if bytes.get(at..)?.starts_with(b";base64,") {
            return Some((value.get("data:".len()..mime_end)?, at + ";base64,".len()));
        }
        if bytes.get(at) != Some(&b';') {
            return None;
        }
        let key_end = scan_mime(bytes, at + 1)?;
        if bytes.get(key_end) != Some(&b'=') {
            return None;
        }
        at = scan_mime(bytes, key_end + 1)?;
    }
}

/// Whether the string is shorter than the elision threshold, counted in
/// UTF-16 code units like the TypeScript's `string.length`. Byte length
/// decides the fast path: UTF-8 never uses fewer bytes than units.
fn below_threshold(value: &str) -> bool {
    if value.len() < BINARY_ELISION_CHARS {
        return true;
    }
    ace_json::utf16_len(value) < BINARY_ELISION_CHARS
}

fn is_elision_alphabet(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
}

/// Decodes like `Buffer.from(payload, "base64")`: `-` and `_` read as 62 and
/// 63, a trailing partial quantum yields its whole bytes, and `=` ends the
/// data. The elider only calls this on alphabet-only strings.
fn decode_forgiving(payload: &str) -> Vec<u8> {
    fn sextet(byte: u8) -> u8 {
        match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            _ => 63,
        }
    }
    let mut out = Vec::with_capacity(payload.len() / 4 * 3);
    let mut acc: u32 = 0;
    let mut count = 0;
    for byte in payload.bytes() {
        if byte == b'=' {
            break;
        }
        acc = (acc << 6) | u32::from(sextet(byte));
        count += 1;
        if count == 4 {
            out.push((acc >> 16) as u8);
            out.push((acc >> 8) as u8);
            out.push(acc as u8);
            acc = 0;
            count = 0;
        }
    }
    for i in 0..count * 6 / 8 {
        out.push((acc >> (count * 6 - 8 * (i + 1))) as u8);
    }
    out
}

/// Lowercase hex of 32 digest bytes.
fn hex(digest: &[u8]) -> String {
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn elide(value: &str) -> Cow<'_, str> {
    if below_threshold(value) {
        return Cow::Borrowed(value);
    }
    let head_len = value.floor_char_boundary(320.min(value.len()));
    let (label, start) = match split_data_url(&value[..head_len]) {
        Some((mime, start)) => (format!("data:{mime};base64"), start),
        None => ("base64 data".to_owned(), 0),
    };
    if !value.as_bytes()[start..]
        .iter()
        .all(|byte| is_elision_alphabet(*byte))
    {
        return Cow::Borrowed(value);
    }
    let bytes = decode_forgiving(&value[start..]);
    let hex = hex(&sha2::Sha256::digest(&bytes));
    Cow::Owned(format!(
        "[ace: {} bytes of {label} elided; sha256 {hex}]",
        bytes.len(),
    ))
}

/// Replace attachment strings in place, with a heap stack so deep values never recurse.
fn elide_value(value: &mut Value) {
    let mut stack = vec![value];
    while let Some(value) = stack.pop() {
        match value {
            Value::String(text) => {
                if let Some(Cow::Owned(marker)) = text.as_well_formed().map(elide) {
                    *text = JsString::from(marker);
                }
            }
            Value::Array(items) => stack.extend(items.iter_mut()),
            Value::Object(map) => stack.extend(map.values_mut()),
            _ => {}
        }
    }
}

/// JSON text of `value` with attachment bytes replaced by digest markers.
/// Prose, code and every other string are kept whole. Work is one
/// serialization for small values; only a value long enough to hold
/// attachment bytes is visited string by string.
pub fn elided_json(value: &Value) -> String {
    let plain = ace_json::to_string(value);
    if below_threshold(&plain) {
        return plain;
    }
    let mut owned = value.clone();
    elide_value(&mut owned);
    ace_json::to_string(&owned)
}

/// `JSON.stringify(value)` with attachment strings replaced by their digest markers, in one
/// pass over the tree and one write: nothing is cloned, so a 16 KiB line costs its own bytes
/// and no more. This is the session capture's serializer (E3-claude.2).
pub fn elided_text(value: &Value) -> String {
    let mut out = String::with_capacity(64);
    let mut stack = vec![Job::Value(value)];
    while let Some(job) = stack.pop() {
        match job {
            Job::Raw(text) => out.push_str(text),
            Job::Key(key) => {
                ace_json::write_js_string(&mut out, key);
                out.push(':');
            }
            Job::Value(value) => match value {
                Value::Null => out.push_str("null"),
                Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
                Value::Number(number) => ace_json::write_number(&mut out, number.value()),
                Value::String(text) => match text.as_well_formed() {
                    Some(plain) => match elide(plain) {
                        Cow::Owned(marker) => ace_json::write_str(&mut out, &marker),
                        Cow::Borrowed(_) => ace_json::write_js_string(&mut out, text),
                    },
                    None => ace_json::write_js_string(&mut out, text),
                },
                Value::Array(items) => {
                    out.push('[');
                    stack.push(Job::Raw("]"));
                    for (index, item) in items.iter().enumerate().rev() {
                        stack.push(Job::Value(item));
                        if index > 0 {
                            stack.push(Job::Raw(","));
                        }
                    }
                }
                Value::Object(map) => {
                    out.push('{');
                    stack.push(Job::Raw("}"));
                    for (index, (key, item)) in map.iter().enumerate().rev() {
                        stack.push(Job::Value(item));
                        stack.push(Job::Key(key));
                        if index > 0 {
                            stack.push(Job::Raw(","));
                        }
                    }
                }
            },
        }
    }
    out
}

/// One piece of the iterative write above.
enum Job<'a> {
    Value(&'a Value),
    Key(&'a JsString),
    Raw(&'static str),
}

/// The SHA-256 of the bytes an elision marker stands for, or None for any
/// other string.
pub fn elided_digest(value: &str) -> Option<&str> {
    let units = if value.len() <= MARKER_MAX_UNITS {
        value.len()
    } else {
        value.encode_utf16().count()
    };
    if units > MARKER_MAX_UNITS {
        return None;
    }
    let body = value.strip_prefix("[ace: ")?;
    let digits = body.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let body = body.get(digits..)?.strip_prefix(" bytes of ")?;
    let body = body.strip_suffix(']')?;
    let hex = body.get(body.len().checked_sub(64)?..)?;
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let label = body
        .get(..body.len() - 64)?
        .strip_suffix(" elided; sha256 ")?;
    if label.is_empty() || label.encode_utf16().count() > 300 {
        return None;
    }
    Some(hex)
}

#[cfg(test)]
mod tests {
    use super::{BINARY_ELISION_CHARS, elided_digest, elided_json, elided_text};
    use ace_json::{Value, json};
    use base64::Engine as _;
    use sha2::Digest as _;

    fn screenshot() -> (Vec<u8>, String) {
        let mut bytes = vec![0u8; 3 * 1024 * 1024];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = ((i * 31 + (i >> 9)) % 256) as u8;
        }
        let digest = sha2::Sha256::digest(&bytes);
        (bytes, super::hex(&digest))
    }

    fn strings(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::String(text) => out.push(text.to_string()),
            Value::Array(items) => {
                for item in items {
                    strings(item, out);
                }
            }
            Value::Object(map) => {
                for (_, item) in map {
                    strings(item, out);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn astral_text_at_the_elision_threshold_is_recorded_whole() {
        // 8,187 emoji are 16,374 UTF-16 units, and the JSON wrapper adds 11:
        // 16,385 units, 8,187 code points and 32,759 bytes. Only the unit
        // `JSON.stringify(value).length` counts reaches the threshold, so
        // `elided_json` scans only the longer value and both are recorded
        // whole, as prose always is.
        for (emoji, at_limit) in [(8_186, false), (8_187, true)] {
            let value = json!({ "text": "😀".repeat(emoji) });
            let plain = ace_json::to_string(&value);
            assert_eq!(
                ace_json::utf16_len(&plain) >= BINARY_ELISION_CHARS,
                at_limit,
                "{emoji} emoji"
            );
            assert!(plain.len() > BINARY_ELISION_CHARS, "{emoji} emoji in bytes");
            assert_eq!(elided_json(&value), plain);
            assert_eq!(elided_text(&value), plain);
        }
    }

    #[test]
    fn a_marker_label_is_bounded_in_utf16_units_like_its_length() {
        let digest = "a".repeat(64);
        let marker = |label: String| format!("[ace: 3 bytes of {label} elided; sha256 {digest}]");
        // 150 emoji are 300 units (the label's limit) and 600 bytes.
        assert_eq!(
            elided_digest(&marker("😀".repeat(150))),
            Some(digest.as_str())
        );
        assert_eq!(elided_digest(&marker("😀".repeat(151))), None);
    }

    #[test]
    fn screenshots_record_as_a_small_payload_naming_each_image_digest() {
        let (bytes, sha256) = screenshot();
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let message = json!({
            "type": "user",
            "message": {
                "content": [
                    { "type": "text", "text": "what is wrong here?" },
                    { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": encoded } },
                    { "type": "image", "url": format!("data:image/png;base64,{encoded}") },
                ],
            },
        });
        let payload = elided_json(&message);
        assert!(payload.len() < 4096, "attachments elide to markers");
        let data: Value = ace_json::parse(&payload).expect("markers stay valid JSON");
        let content = data
            .pointer("/message/content")
            .expect("structure survives");
        assert_eq!(content[0]["text"], json!("what is wrong here?"));
        let mut texts = Vec::new();
        strings(&data, &mut texts);
        let mut found = Vec::new();
        for text in &texts {
            if let Some(digest) = elided_digest(text) {
                found.push(digest.to_owned());
            }
        }
        assert_eq!(found, vec![sha256.clone(), sha256]);
        assert!(
            payload.contains(&format!("{} bytes of data:image/png", bytes.len())),
            "marker names the decoded size and media type"
        );
        assert_eq!(BINARY_ELISION_CHARS, 16 * 1024);
    }

    #[test]
    fn long_prose_code_and_pasted_text_are_recorded_whole() {
        let prose = "The build fails when the cache is cold. ".repeat(2048);
        let code = format!(
            "const values = [{}];",
            (0..6000)
                .map(|i: u32| i.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        let message = json!({
            "content": [
                { "type": "text", "text": prose },
                { "type": "text", "text": code },
            ],
        });
        let parsed: Value = ace_json::parse(&elided_json(&message)).expect("stays JSON");
        assert_eq!(parsed, message);
    }

    #[test]
    fn elided_text_serializes_like_elided_json_without_a_tree_copy() {
        let attachment = "A".repeat(20_000);
        let value = json!({
            "a": [1, 2.5, null, true, -0.0],
            "b": "plain \u{2028} text",
            "c": attachment,
            "d": { "nested": "A".repeat(30_000) },
        });
        assert_eq!(elided_text(&value), elided_json(&value));
    }

    #[test]
    fn short_base64_such_as_ids_and_tokens_is_never_elided() {
        let id = base64::engine::general_purpose::STANDARD.encode("tool-call-identifier");
        let value = json!({ "id": id, "n": 1 });
        assert_eq!(elided_json(&value), ace_json::to_string(&value));
        assert_eq!(elided_digest(&id), None);
    }
}
