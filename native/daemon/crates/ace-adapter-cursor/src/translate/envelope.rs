// SPDX-License-Identifier: Apache-2.0
//! The SDK boundary envelope (`contracts.ts`): lenient envelope decoding plus
//! the `object`/`string`/`nativeIdentity` readers the translator uses on every
//! frame. Unknown fields stay; only the envelope this translator reads is
//! validated.

use serde_json::{Map, Value};

use super::{BudgetError, BudgetResult};

/// A decoded SDK boundary envelope, borrowed from the frame's payload.
pub struct Envelope<'a> {
    pub generation: &'a str,
    pub operation_id: &'a str,
    pub command_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub run_id: Option<&'a str>,
    pub kind: &'a str,
    pub segment: i64,
    pub body: &'a Value,
    pub raw: Option<&'a Value>,
}

/// Read a decoded provider value as a JSON object, borrowed, never copied.
pub fn object(value: &Value) -> &Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => &EMPTY_MAP,
    }
}

static EMPTY_MAP: std::sync::LazyLock<Map<String, Value>> = std::sync::LazyLock::new(Map::new);

/// The value when it is a string.
pub fn string(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) => Some(text.as_str()),
        _ => None,
    }
}

/// A native identity the translator routes on. Non-strings read as absent;
/// empty or over-long identities exceed the SDK budget.
pub fn native_identity(value: &Value) -> BudgetResult<Option<String>> {
    match value {
        Value::String(text) => {
            if text.is_empty() || text.len() > 512 {
                return Err(BudgetError::Exceeded);
            }
            Ok(Some(text.clone()))
        }
        _ => Ok(None),
    }
}

fn identity(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) if !text.is_empty() && text.len() <= 512 => Some(text.as_str()),
        _ => None,
    }
}

fn is_hex64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn pending_event(value: &Value) -> bool {
    match value {
        Value::String(text) => {
            if is_hex64(text) {
                return true;
            }
            if text.len() == 129
                && text.as_bytes()[64] == b':'
                && is_hex64(&text[..64])
                && is_hex64(&text[65..])
            {
                return true;
            }
            false
        }
        _ => false,
    }
}

/// Decode the envelope the TypeScript `Envelope.safeParse` accepts. Anything
/// else is `None`, and the caller files a malformed-envelope notice.
pub fn parse_envelope(value: &Value) -> Option<Envelope<'_>> {
    let map = match value {
        Value::Object(map) => map,
        _ => return None,
    };
    match map.get("schemaVersion") {
        Some(Value::Number(version)) if version.as_i64() == Some(1) => {}
        _ => return None,
    }
    let generation = map.get("generation").and_then(identity)?;
    let operation_id = map.get("operationId").and_then(identity)?;
    let kind = match map.get("kind") {
        Some(Value::String(kind)) if !kind.is_empty() && kind.len() <= 128 => kind.as_str(),
        _ => return None,
    };
    let segment = match map.get("segment") {
        Some(Value::Number(segment)) => {
            let segment = segment.as_i64()?;
            if segment < 0 {
                return None;
            }
            segment
        }
        _ => return None,
    };
    for key in ["commandId", "agentId", "runId"] {
        if let Some(value) = map.get(key)
            && identity(value).is_none()
        {
            return None;
        }
    }
    if let Some(value) = map.get("eventSeq")
        && !matches!(value, Value::Number(seq) if seq.as_i64().is_some_and(|seq| (0..=100_000_000).contains(&seq)))
    {
        return None;
    }
    if let Some(value) = map.get("eventOffset")
        && identity(value).is_none()
    {
        return None;
    }
    if let Some(Value::Array(events)) = map.get("pendingEvents") {
        if events.len() > 64 || !events.iter().all(pending_event) {
            return None;
        }
    } else if map.contains_key("pendingEvents") {
        return None;
    }
    if let Some(raw) = map.get("raw")
        && !matches!(raw, Value::Object(_))
    {
        return None;
    }
    let body = map.get("body")?;
    Some(Envelope {
        generation,
        operation_id,
        command_id: map.get("commandId").and_then(identity),
        agent_id: map.get("agentId").and_then(identity),
        run_id: map.get("runId").and_then(identity),
        kind,
        segment,
        body,
        raw: map.get("raw"),
    })
}
