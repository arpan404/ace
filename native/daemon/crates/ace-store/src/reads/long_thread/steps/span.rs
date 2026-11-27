// SPDX-License-Identifier: Apache-2.0
//! Stored step bytes: verbatim keeps and the surgical `raw` replacement.
//!
//! A step without native payloads splices its item verbatim; one with payloads
//! replaces only the `call.raw` array's span, keeping every other byte.

use super::super::common::LongError;
use super::items::parse_item;

/// Steps keep native payloads only where arguments live nowhere else.
/// Steps keep their native payloads only where arguments live nowhere else.
pub fn lightened(text: &str) -> Result<Option<String>, LongError> {
    let item = parse_item(text)?;
    if item.type_.as_deref() != Some("tool_call") {
        return Ok(None);
    }
    let Some(call) = item.call.as_ref() else {
        return Ok(None);
    };
    let kind = call
        .detail
        .as_ref()
        .and_then(|detail| detail.kind.as_deref());
    if kind == Some("custom") {
        return Ok(None);
    }
    let Some(raw) = call.raw.as_ref() else {
        // The loader throws here; an older row without `raw` keeps its body.
        return Ok(None);
    };
    let entries: Vec<&serde_json::value::RawValue> =
        serde_json::from_str(raw.get()).unwrap_or_default();
    if entries.is_empty() {
        return Ok(None);
    }
    Ok(Some(replace_raw(text).unwrap_or_else(|| text.to_owned())))
}

/// Replace the `call.raw` array's span with an empty one, keeping every other byte.
fn replace_raw(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let call_key = find_key(bytes, 0, "call")?;
    let mut pos = skip_ws(bytes, call_key.end)?;
    if bytes.get(pos) != Some(&b'{') {
        return None;
    }
    let raw_key = find_key(bytes, pos, "raw")?;
    pos = skip_ws(bytes, raw_key.end)?;
    if bytes.get(pos) != Some(&b'[') {
        return None;
    }
    let close = match_bracket(bytes, pos, 100)?;
    let mut out = String::with_capacity(text.len());
    out.push_str(&text[..pos]);
    out.push_str("[]");
    out.push_str(&text[close + 1..]);
    Some(out)
}

pub(super) struct KeySpan {
    pub(super) end: usize,
}

/// The value's end offset of `key` in the object opening at `open`.
pub(super) fn find_key(bytes: &[u8], open: usize, key: &str) -> Option<KeySpan> {
    let mut pos = open + 1;
    let mut depth: usize = 1;
    while pos < bytes.len() && depth > 0 {
        match bytes[pos] {
            b'"' => {
                let start = pos + 1;
                let end = scan_string(bytes, start)?;
                if depth == 1 {
                    let name = std::str::from_utf8(&bytes[start..end]).ok()?;
                    pos = skip_ws(bytes, end + 1)?;
                    if bytes.get(pos) != Some(&b':') {
                        return None;
                    }
                    pos = skip_ws(bytes, pos + 1)?;
                    if name == key {
                        return Some(KeySpan { end: pos });
                    }
                    pos = skip_value(bytes, pos)?;
                } else {
                    pos = end + 1;
                }
            }
            b'{' | b'[' => {
                depth += 1;
                if depth > 100 {
                    return None;
                }
                pos += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                pos += 1;
            }
            _ => pos += 1,
        }
    }
    None
}

pub(super) fn scan_string(bytes: &[u8], mut pos: usize) -> Option<usize> {
    while pos < bytes.len() {
        match bytes[pos] {
            b'\\' => pos += 2,
            b'"' => return Some(pos),
            _ => pos += 1,
        }
    }
    None
}

pub(super) fn skip_ws(bytes: &[u8], mut pos: usize) -> Option<usize> {
    while pos < bytes.len() && matches!(bytes[pos], b' ' | b'\t' | b'\n' | b'\r') {
        pos += 1;
    }
    if pos <= bytes.len() { Some(pos) } else { None }
}

pub(super) fn skip_value(bytes: &[u8], pos: usize) -> Option<usize> {
    let mut depth: usize = 0;
    let mut pos = pos;
    loop {
        if pos >= bytes.len() {
            return if depth == 0 { Some(pos) } else { None };
        }
        match bytes[pos] {
            b'"' => pos = scan_string(bytes, pos + 1)? + 1,
            b'{' | b'[' => {
                depth += 1;
                if depth > 100 {
                    return None;
                }
                pos += 1;
            }
            b'}' | b']' => {
                if depth == 0 {
                    return Some(pos);
                }
                depth -= 1;
                pos += 1;
                if depth == 0 {
                    return Some(pos);
                }
            }
            // A trailing comma ends the value but is not part of it.
            b',' if depth == 0 => return Some(pos),
            _ => pos += 1,
        }
    }
}

fn match_bracket(bytes: &[u8], open: usize, bound: usize) -> Option<usize> {
    let mut depth: usize = 0;
    let mut pos = open;
    while pos < bytes.len() {
        match bytes[pos] {
            b'"' => pos = scan_string(bytes, pos + 1)? + 1,
            b'[' => {
                depth += 1;
                if depth > bound {
                    return None;
                }
                pos += 1;
            }
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(pos);
                }
                pos += 1;
            }
            _ => pos += 1,
        }
    }
    None
}

/// The stored `call` object a surface reads, borrowed from the step's bytes.
pub fn extract_call(light: &str) -> Option<&str> {
    let bytes = light.as_bytes();
    let key = find_key(bytes, 0, "call")?;
    let end = skip_value(bytes, key.end)?;
    light.get(key.end..end)
}
