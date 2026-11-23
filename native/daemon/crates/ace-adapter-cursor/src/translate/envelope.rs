// SPDX-License-Identifier: Apache-2.0
//! The SDK boundary envelope readers (`contracts.ts`): identity and native-id
//! checks over exact UTF-16 units, plus the small concatenation helper for
//! native ids and item keys.

use super::text::JsString;
use super::text::{Value, units_eq};
use super::{BudgetError, BudgetResult};

/// A decoded SDK boundary envelope, borrowed from the frame's payload.
pub struct Envelope<'a> {
    pub generation: &'a JsString,
    pub operation_id: &'a JsString,
    pub command_id: Option<&'a JsString>,
    pub agent_id: Option<&'a JsString>,
    pub run_id: Option<&'a JsString>,
    pub kind: &'a JsString,
    pub segment: i64,
    pub body: &'a Value,
    pub raw: Option<&'a Value>,
}

/// The string units, if the value is a string.
pub fn string(value: &Value) -> Option<&JsString> {
    match value {
        Value::String(units) => Some(units),
        _ => None,
    }
}

/// Whether the value is a string equal to the ASCII literal.
pub fn is(value: &Value, lit: &str) -> bool {
    matches!(value, Value::String(units) if units_eq(units, lit))
}

/// The decimal text of an integer, as units.
pub fn num_units(value: i64) -> JsString {
    value.to_string().encode_utf16().collect()
}

/// Concatenate unit slices, for native ids and item keys.
pub fn cat(parts: &[&JsString]) -> JsString {
    let mut out = JsString::new();
    for part in parts {
        out.push_js(part);
    }
    out
}

/// Whether the unit is whitespace the TypeScript `trim` removes: WhiteSpace
/// and line terminators, including the byte-order mark, but not NEL.
fn is_trim(unit: u16) -> bool {
    unit == 0xfeff
        || matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000)
}

/// Trim the units the way the TypeScript `trim` does.
pub fn trim_text(text: &JsString) -> JsString {
    let units: Vec<u16> = text.units().collect();
    let mut start = 0;
    while start < units.len() && is_trim(units[start]) {
        start += 1;
    }
    let mut end = units.len();
    while end > start && is_trim(units[end - 1]) {
        end -= 1;
    }
    JsString::from_units(&units[start..end])
}

/// A native identity the translator routes on. Non-strings read as absent;
/// empty or over-long identities exceed the SDK budget.
pub fn native_identity(value: &Value) -> BudgetResult<Option<JsString>> {
    match value {
        Value::String(text) => {
            if text.is_empty() || text.len_utf16() > 512 {
                return Err(BudgetError::Exceeded);
            }
            Ok(Some(text.clone()))
        }
        _ => Ok(None),
    }
}

fn identity(value: &Value) -> Option<&JsString> {
    match value {
        Value::String(text) if !text.is_empty() && text.len_utf16() <= 512 => Some(text),
        _ => None,
    }
}

fn is_hex64(units: &[u16]) -> bool {
    units.len() == 64
        && units
            .iter()
            .all(|unit| matches!(unit, 0x30..=0x39 | 0x61..=0x66))
}

fn pending_event(value: &Value) -> bool {
    let Value::String(text) = value else {
        return false;
    };
    let text: Vec<u16> = text.units().collect();
    if is_hex64(&text) {
        return true;
    }
    if text.len() == 129 && text[64] == 0x3a && is_hex64(&text[..64]) && is_hex64(&text[65..]) {
        return true;
    }
    false
}

/// Decode the envelope the TypeScript `Envelope.safeParse` accepts. Anything
/// else is `None`, and the caller files a malformed-envelope notice.
pub fn parse_envelope(value: &Value) -> Option<Envelope<'_>> {
    let Value::Object(_) = value else {
        return None;
    };
    match value.get("schemaVersion") {
        Some(version) if version.as_i64() == Some(1) => {}
        _ => return None,
    }
    let generation = value.get("generation").and_then(identity)?;
    let operation_id = value.get("operationId").and_then(identity)?;
    let kind = match value.get("kind") {
        Some(Value::String(kind)) if !kind.is_empty() && kind.len_utf16() <= 128 => kind,
        _ => return None,
    };
    let segment = {
        let value = value.get("segment")?;
        let segment = value.as_i64()?;
        if segment < 0 {
            return None;
        }
        segment
    };
    for key in ["commandId", "agentId", "runId"] {
        if let Some(value) = value.get(key)
            && identity(value).is_none()
        {
            return None;
        }
    }
    if let Some(value) = value.get("eventSeq")
        && !(value
            .as_i64()
            .is_some_and(|seq| (0..=100_000_000).contains(&seq)))
    {
        return None;
    }
    if let Some(value) = value.get("eventOffset")
        && identity(value).is_none()
    {
        return None;
    }
    if let Some(Value::Array(events)) = value.get("pendingEvents") {
        if events.len() > 64 || !events.iter().all(pending_event) {
            return None;
        }
    } else if value.get("pendingEvents").is_some() {
        return None;
    }
    if let Some(raw) = value.get("raw")
        && !matches!(raw, Value::Object(_))
    {
        return None;
    }
    let body = value.get("body")?;
    Some(Envelope {
        generation,
        operation_id,
        command_id: value.get("commandId").and_then(identity),
        agent_id: value.get("agentId").and_then(identity),
        run_id: value.get("runId").and_then(identity),
        kind,
        segment,
        body,
        raw: value.get("raw"),
    })
}
