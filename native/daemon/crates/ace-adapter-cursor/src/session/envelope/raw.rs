// SPDX-License-Identifier: Apache-2.0
//! `RawPayload` (`provider-data.ts:20`-`:37`): the provider's original payload, the inline form
//! first and the blob form second, stripped to the schema's keys and order as zod's object parse
//! leaves it. `preview`'s bound is UTF-8 bytes of what `TextEncoder` writes.

use ace_json::{JsString, Map, Value};

use super::super::error::SessionError;
use super::{PREVIEW_BYTES, is_integer};

/// `RawPayload` (`provider-data.ts:20`-`:37`): the inline form first, else the blob form. zod's
/// object parse strips the keys it doesn't name and keeps the schema's order.
pub(super) fn normalize_raw(value: &Value) -> Result<Value, SessionError> {
    let object = value
        .as_object()
        .ok_or(SessionError::Envelope("raw is not an object"))?;
    let kind = match object.get("type") {
        Some(Value::String(kind)) => kind,
        _ => return Err(SessionError::Envelope("raw.type is not a string")),
    };
    let name = match object.get("name") {
        None => None,
        Some(Value::String(name)) => Some(name),
        Some(_) => return Err(SessionError::Envelope("raw.name is not a string")),
    };
    let mut normalized = Map::with_capacity(5);
    normalized.insert("type", Value::String(kind.clone()));
    if let Some(name) = name {
        normalized.insert("name", Value::String(name.clone()));
    }
    if let Some(data) = object.get("data") {
        normalized.insert("data", data.clone());
        return Ok(Value::Object(normalized));
    }
    let blob_ref = match object.get("blobRef") {
        Some(Value::String(blob_ref)) if !blob_ref.is_empty() => blob_ref,
        _ => return Err(SessionError::Envelope("raw has neither data nor a blobRef")),
    };
    let size = match object.get("size").and_then(Value::as_f64) {
        Some(size) if is_integer(size) && size >= 0.0 => size,
        _ => return Err(SessionError::Envelope("raw.size is not a stored size")),
    };
    let preview = match object.get("preview") {
        Some(Value::String(preview)) if utf8_len(preview) <= PREVIEW_BYTES => preview,
        _ => return Err(SessionError::Envelope("raw.preview exceeds 2048 bytes")),
    };
    normalized.insert("blobRef", Value::String(blob_ref.clone()));
    normalized.insert("size", Value::from(size));
    normalized.insert("preview", Value::String(preview.clone()));
    Ok(Value::Object(normalized))
}

/// `new TextEncoder().encode(text).length`: a lone surrogate encodes as U+FFFD, three bytes.
fn utf8_len(text: &JsString) -> usize {
    fn unit_len(unit: u16) -> usize {
        if unit < 0x80 {
            1
        } else if unit < 0x800 {
            2
        } else {
            3
        }
    }
    let mut bytes = 0usize;
    let mut pending = false;
    for unit in text.units() {
        if pending {
            pending = false;
            if (0xdc00..0xe000).contains(&unit) {
                bytes += 4;
                continue;
            }
            bytes += 3;
        }
        if (0xd800..0xdc00).contains(&unit) {
            pending = true;
        } else {
            bytes += unit_len(unit);
        }
    }
    if pending {
        bytes += 3;
    }
    bytes
}
