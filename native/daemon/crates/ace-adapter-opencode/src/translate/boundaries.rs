// SPDX-License-Identifier: Apache-2.0
//! The translator's native envelope checks
//! (`packages/adapter-opencode/src/boundaries.ts`). A known message
//! deserializes into these views; an unknown one stays raw. Bounds match the
//! TypeScript schemas, so oversized or misshapen events fail the same way.

use crate::translate::data::{fields, get, s_in, utf16_len};
use ace_json::{Map, Value};
use thiserror::Error;

/// What a native envelope check can fail with. The translator maps every
/// failure to its disconnected fact, as the TypeScript `catch` does.
#[derive(Debug, Error)]
pub enum BoundaryError {
    /// The event is not the shape its type promises.
    #[error("event failed its envelope check: {0}")]
    Event(&'static str),
}

/// A validated OpenCode SSE envelope.
pub struct NativeEvent<'a> {
    pub id: &'a str,
    pub typ: &'a str,
    pub data: &'a Map,
    pub location: Option<&'a Map>,
    pub durable: Option<Durable<'a>>,
    /// The envelope's own creation time, when the provider sent one.
    pub created: Option<f64>,
}

/// A validated durable cursor for exactly-once delivery.
pub struct Durable<'a> {
    pub aggregate_id: &'a str,
    pub seq: f64,
}

fn bounded(text: &str, max: usize) -> bool {
    utf16_len(text) <= max
}

/// Validate an SSE envelope the way `NativeEvent.parse` does: known fields
/// checked, unknown fields kept by the caller.
pub fn parse_native_event(value: &Value) -> Result<NativeEvent<'_>, BoundaryError> {
    let envelope = fields(value);
    if !matches!(value, Value::Object(_)) {
        return Err(BoundaryError::Event("envelope"));
    }
    let id = match envelope.get("id") {
        Some(Value::String(id)) if bounded(id, 512) => id.as_str(),
        _ => return Err(BoundaryError::Event("id")),
    };
    let typ = match envelope.get("type") {
        Some(Value::String(typ)) if bounded(typ, 256) => typ.as_str(),
        _ => return Err(BoundaryError::Event("type")),
    };
    let data = match envelope.get("data") {
        Some(Value::Object(data)) => data,
        _ => return Err(BoundaryError::Event("data")),
    };
    let location = match envelope.get("location") {
        None | Some(Value::Null) => None,
        Some(Value::Object(location)) => match location.get("directory") {
            Some(Value::String(directory)) if bounded(directory, 4096) => Some(location),
            _ => return Err(BoundaryError::Event("location")),
        },
        _ => return Err(BoundaryError::Event("location")),
    };
    let durable = match envelope.get("durable") {
        None | Some(Value::Null) => None,
        Some(Value::Object(cursor)) => Some(parse_durable(cursor)?),
        _ => return Err(BoundaryError::Event("durable")),
    };
    Ok(NativeEvent {
        id,
        typ,
        data,
        location,
        durable,
        created: match envelope.get("created") {
            Some(Value::Number(created)) => created.as_f64(),
            _ => None,
        },
    })
}

fn parse_durable(cursor: &Map) -> Result<Durable<'_>, BoundaryError> {
    let aggregate_id = match cursor.get("aggregateID") {
        Some(Value::String(id)) if bounded(id, 512) => id.as_str(),
        _ => return Err(BoundaryError::Event("durable.aggregateID")),
    };
    let seq = match cursor.get("seq") {
        Some(Value::Number(seq)) => match seq.as_i64() {
            Some(seq) if seq >= 0 => seq as f64,
            _ => match seq.as_u64() {
                Some(seq) => seq as f64,
                None => match seq.as_f64() {
                    Some(seq) if seq.fract() == 0.0 && seq >= 0.0 => seq,
                    _ => return Err(BoundaryError::Event("durable.seq")),
                },
            },
        },
        _ => return Err(BoundaryError::Event("durable.seq")),
    };
    Ok(Durable { aggregate_id, seq })
}

/// The session an envelope reports, read through its fallbacks: the event's
/// own id, its form's, or its info metadata's.
pub fn event_session(value: &Value) -> String {
    let envelope = fields(value);
    let data = fields(get(envelope, "data"));
    let form = fields(get(data, "form"));
    let info = fields(get(data, "info"));
    let metadata = fields(get(info, "metadata"));
    // Mirror the nested fallback directly: inner first, outer last.
    let inner = s_in(metadata, "sessionID");
    let middle = if inner.is_empty() {
        s_in(form, "sessionID")
    } else {
        inner
    };
    let outer = s_in(data, "sessionID");
    if !outer.is_empty() {
        outer.to_owned()
    } else {
        middle.to_owned()
    }
}

/// A validated session snapshot (`SessionInfo` in TypeScript).
pub struct SessionInfo<'a> {
    pub id: &'a str,
    pub values: &'a Map,
}

/// Validate a session snapshot the way `SessionInfo.parse` does.
pub fn parse_session_info(value: &Value) -> Result<SessionInfo<'_>, BoundaryError> {
    let info = fields(value);
    match info.get("id") {
        Some(Value::String(id)) if !id.is_empty() && bounded(id, 512) => Ok(SessionInfo {
            id: id.as_str(),
            values: info,
        }),
        _ => Err(BoundaryError::Event("session.id")),
    }
}

/// Validate a page of native history (`Page` in TypeScript).
pub fn parse_page(value: &Value) -> Result<&[Value], BoundaryError> {
    let page = fields(value);
    match page.get("data") {
        Some(Value::Array(data)) if data.len() <= 200 => Ok(data),
        _ => Err(BoundaryError::Event("page")),
    }
}

/// Validate a pending-interaction listing (`PendingList` in TypeScript).
pub fn parse_pending_list(value: &Value) -> Result<&[Value], BoundaryError> {
    match value {
        Value::Array(items) if items.len() <= 1024 => Ok(items),
        _ => Err(BoundaryError::Event("pending")),
    }
}

/// Reorder an envelope the way `NativeEvent.parse` emits it: known keys in
/// schema order (`id`, `type`, `data`, `location`, `durable`), then unknown
/// keys in arrival order. Nested `location` and `durable` keep their schema
/// order the same way. Raw payloads embed this order byte for byte.
pub fn order_envelope(value: &Value) -> Value {
    let map = fields(value);
    if !matches!(value, Value::Object(_)) {
        return Value::Null;
    }
    let mut out = Map::new();
    for key in ["id", "type", "data", "location", "durable"] {
        if let Some(nested) = map.get(key) {
            out.insert(key.to_owned(), order_nested(key, nested));
        }
    }
    for (key, nested) in map.iter() {
        if !out.contains_key(key) {
            out.insert(key.clone(), nested.clone());
        }
    }
    Value::Object(out)
}

/// Reorder a nested envelope view the way its schema emits it.
fn order_nested(key: &str, value: &Value) -> Value {
    let map = fields(value);
    if !matches!(value, Value::Object(_)) {
        return value.clone();
    }
    let order: &[&str] = match key {
        "location" => &["directory"],
        "durable" => &["aggregateID", "seq", "version"],
        _ => return value.clone(),
    };
    let mut out = Map::new();
    for nested in order {
        if let Some(field) = map.get(*nested) {
            out.insert((*nested).to_owned(), field.clone());
        }
    }
    for (field, nested) in map.iter() {
        if !out.contains_key(field) {
            out.insert(field.clone(), nested.clone());
        }
    }
    Value::Object(out)
}

/// Validate a projected history message (`ProjectedMessage` in TypeScript).
pub fn parse_projected_message(value: &Value) -> Result<&Map, BoundaryError> {
    let message = fields(value);
    if !matches!(value, Value::Object(_)) {
        return Err(BoundaryError::Event("message"));
    }
    match (message.get("id"), message.get("type")) {
        (Some(Value::String(id)), Some(Value::String(typ)))
            if !id.is_empty() && bounded(id, 512) && bounded(typ, 256) =>
        {
            if let Some(Value::Array(content)) = message.get("content")
                && content.len() > 2048
            {
                return Err(BoundaryError::Event("message.content"));
            }
            Ok(message)
        }
        _ => Err(BoundaryError::Event("message")),
    }
}

/// Check an OpenCode server URL the way `loopback` does: a credential-free
/// loopback HTTP URL serving at its root.
pub fn check_loopback(value: &str) -> Result<&str, BoundaryError> {
    let rest = value
        .strip_prefix("http://")
        .ok_or(BoundaryError::Event("loopback"))?;
    if rest.contains(['?', '#']) || rest.contains('@') {
        return Err(BoundaryError::Event("loopback"));
    }
    let (authority, path) = match rest.find('/') {
        Some(at) => rest.split_at(at),
        None => return Err(BoundaryError::Event("loopback")),
    };
    if path != "/" {
        return Err(BoundaryError::Event("loopback"));
    }
    let (host, port) = match authority.rfind(':') {
        Some(at) => authority.split_at(at),
        None => return Err(BoundaryError::Event("loopback")),
    };
    if port.len() < 2 || !port[1..].bytes().all(|b| b.is_ascii_digit()) {
        return Err(BoundaryError::Event("loopback"));
    }
    if host != "127.0.0.1" && host != "[::1]" {
        return Err(BoundaryError::Event("loopback"));
    }
    Ok(value)
}
