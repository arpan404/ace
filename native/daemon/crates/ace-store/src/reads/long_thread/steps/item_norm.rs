// SPDX-License-Identifier: Apache-2.0
//! Stored items re-encoded in the schema's order.
//!
//! Rows below the trust boundary are decoded as the loader decodes them, which
//! reorders their keys to the schema's order and fills in defaults. Fields
//! splice their stored spans verbatim; only the key order and the defaults
//! change, so numbers and strings keep their exact bytes.

use super::super::common::{LongError, invalid};
use super::span::{skip_value, skip_ws};
use std::borrow::Cow;

pub(super) fn obj(text: &str) -> Result<&serde_json::value::RawValue, LongError> {
    serde_json::from_str(text).map_err(|_| invalid("invalid index row"))
}

/// The object's field, or none when the key is absent.
pub(super) fn opt_field<'a>(
    obj: &'a serde_json::value::RawValue,
    key: &str,
) -> Result<Option<&'a serde_json::value::RawValue>, LongError> {
    let text = obj.get();
    let bytes = text.as_bytes();
    let mut pos = skip_ws(bytes, 0).ok_or_else(|| invalid("invalid index row"))?;
    if bytes.get(pos) != Some(&b'{') {
        return Err(invalid("invalid index row"));
    }
    let mut scan = pos + 1;
    let mut depth = 1usize;
    while scan < bytes.len() && depth > 0 {
        match bytes[scan] {
            b'"' => {
                let start = scan + 1;
                let end = super::span::scan_string(bytes, start)
                    .ok_or_else(|| invalid("invalid index row"))?;
                if depth == 1 {
                    let name = std::str::from_utf8(&bytes[start..end]).unwrap_or_default();
                    pos = skip_ws(bytes, end + 1).ok_or_else(|| invalid("invalid index row"))?;
                    if bytes.get(pos) != Some(&b':') {
                        return Err(invalid("invalid index row"));
                    }
                    pos = skip_ws(bytes, pos + 1).ok_or_else(|| invalid("invalid index row"))?;
                    if name == key {
                        let end =
                            skip_value(bytes, pos).ok_or_else(|| invalid("invalid index row"))?;
                        let span = text
                            .get(pos..end)
                            .ok_or_else(|| invalid("invalid index row"))?;
                        return serde_json::from_str(span)
                            .map(Some)
                            .map_err(|_| invalid("invalid index row"));
                    }
                    scan = skip_value(bytes, pos).ok_or_else(|| invalid("invalid index row"))?;
                    continue;
                }
                scan = end + 1;
            }
            b'{' | b'[' => {
                depth += 1;
                scan += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                scan += 1;
            }
            _ => scan += 1,
        }
    }
    Ok(None)
}

pub(super) fn req<'a>(
    obj: &'a serde_json::value::RawValue,
    key: &str,
) -> Result<&'a serde_json::value::RawValue, LongError> {
    opt_field(obj, key)?.ok_or_else(|| invalid("invalid index row"))
}

pub(super) fn req_str<'a>(
    obj: &'a serde_json::value::RawValue,
    key: &str,
) -> Result<Cow<'a, str>, LongError> {
    let raw = req(obj, key)?;
    serde_json::from_str(raw.get()).map_err(|_| invalid("invalid index row"))
}

pub(super) fn req_bool(
    obj: &serde_json::value::RawValue,
    key: &str,
    default: bool,
) -> Result<bool, LongError> {
    match opt_field(obj, key)? {
        None => Ok(default),
        Some(raw) => serde_json::from_str(raw.get()).map_err(|_| invalid("invalid index row")),
    }
}

/// One JSON object written in field order, values spliced verbatim.
pub(super) struct Out {
    buf: String,
    first: Vec<bool>,
}

impl Out {
    pub(super) fn new(capacity: usize) -> Out {
        Out {
            buf: String::with_capacity(capacity),
            first: vec![true],
        }
    }

    pub(super) fn begin(&mut self) {
        self.buf.push('{');
        self.first.push(true);
    }

    pub(super) fn field(&mut self, name: &str, raw: &str) {
        if !self.first.last().copied().unwrap_or(true) {
            self.buf.push(',');
        }
        *self.first.last_mut().unwrap_or(&mut true) = false;
        self.buf.push('"');
        self.buf.push_str(name);
        self.buf.push_str("\":");
        self.buf.push_str(raw);
    }

    pub(super) fn end(&mut self) {
        self.buf.push('}');
        self.first.pop();
    }

    pub(super) fn finish(self) -> String {
        self.buf
    }
}

/// The item's stored body, re-encoded in the schema's field order.
pub fn normalize_item(text: &str) -> Result<String, LongError> {
    let root = obj(text)?;
    let kind: Cow<'_, str> = req_str(root, "type")?;
    match &*kind {
        "message" => super::item_kinds::normalize_message(root),
        "notice" => super::item_kinds::normalize_notice(root),
        "reasoning" => super::item_kinds::normalize_reasoning(root),
        "tool_call" => super::item_call::normalize_tool_call(root),
        "delegation.started" => super::item_kinds::normalize_delegation_started(root),
        "delegation.settled" => super::item_kinds::normalize_delegation_settled(root),
        "compaction" => super::item_kinds::normalize_compaction(root),
        "html" => super::item_kinds::normalize_wrapped(root, "visualization"),
        "image" => super::item_kinds::normalize_wrapped(root, "image"),
        "artifact" => super::item_kinds::normalize_artifact(root),
        _ => super::item_kinds::normalize_unknown(root),
    }
}
