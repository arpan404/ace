// SPDX-License-Identifier: Apache-2.0
//! The SDK boundary envelope readers (`contracts.ts`): identity and native-id
//! checks over exact UTF-16 units, plus the small concatenation helper for
//! native ids and item keys.

use super::json::{J, units_eq};
use super::{BudgetError, BudgetResult};

/// A decoded SDK boundary envelope, borrowed from the frame's payload.
pub struct Envelope<'a> {
    pub generation: &'a [u16],
    pub operation_id: &'a [u16],
    pub command_id: Option<&'a [u16]>,
    pub agent_id: Option<&'a [u16]>,
    pub run_id: Option<&'a [u16]>,
    pub kind: &'a [u16],
    pub segment: i64,
    pub body: &'a J,
    pub raw: Option<&'a J>,
}

/// The string units, if the value is a string.
pub fn string(value: &J) -> Option<&[u16]> {
    match value {
        J::Str(units) => Some(units),
        _ => None,
    }
}

/// Whether the value is a string equal to the ASCII literal.
pub fn is(value: &J, lit: &str) -> bool {
    matches!(value, J::Str(units) if units_eq(units, lit))
}

/// The decimal text of an integer, as units.
pub fn num_units(value: i64) -> Vec<u16> {
    value.to_string().encode_utf16().collect()
}

/// Concatenate unit slices, for native ids and item keys.
pub fn cat(parts: &[&[u16]]) -> Vec<u16> {
    let mut out = Vec::with_capacity(parts.iter().map(|part| part.len()).sum());
    for part in parts {
        out.extend_from_slice(part);
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
pub fn trim_text(units: &[u16]) -> Vec<u16> {
    let mut start = 0;
    while start < units.len() && is_trim(units[start]) {
        start += 1;
    }
    let mut end = units.len();
    while end > start && is_trim(units[end - 1]) {
        end -= 1;
    }
    units[start..end].to_vec()
}

/// A native identity the translator routes on. Non-strings read as absent;
/// empty or over-long identities exceed the SDK budget.
pub fn native_identity(value: &J) -> BudgetResult<Option<Vec<u16>>> {
    match value {
        J::Str(text) => {
            if text.is_empty() || text.len() > 512 {
                return Err(BudgetError::Exceeded);
            }
            Ok(Some(text.clone()))
        }
        _ => Ok(None),
    }
}

fn identity(value: &J) -> Option<&[u16]> {
    match value {
        J::Str(text) if !text.is_empty() && text.len() <= 512 => Some(text),
        _ => None,
    }
}

fn is_hex64(units: &[u16]) -> bool {
    units.len() == 64
        && units
            .iter()
            .all(|unit| matches!(unit, 0x30..=0x39 | 0x61..=0x66))
}

fn pending_event(value: &J) -> bool {
    let J::Str(text) = value else {
        return false;
    };
    if is_hex64(text) {
        return true;
    }
    if text.len() == 129 && text[64] == 0x3a && is_hex64(&text[..64]) && is_hex64(&text[65..]) {
        return true;
    }
    false
}

/// Decode the envelope the TypeScript `Envelope.safeParse` accepts. Anything
/// else is `None`, and the caller files a malformed-envelope notice.
pub fn parse_envelope(value: &J) -> Option<Envelope<'_>> {
    let J::Obj(_) = value else {
        return None;
    };
    match value.get("schemaVersion") {
        Some(version) if version.as_int().is_ok_and(|version| version == 1) => {}
        _ => return None,
    }
    let generation = value.get("generation").and_then(identity)?;
    let operation_id = value.get("operationId").and_then(identity)?;
    let kind = match value.get("kind") {
        Some(J::Str(kind)) if !kind.is_empty() && kind.len() <= 128 => kind.as_slice(),
        _ => return None,
    };
    let segment = match value.get("segment") {
        Some(value) => {
            let segment = value.as_int().ok()?;
            if segment < 0 {
                return None;
            }
            segment
        }
        None => return None,
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
            .as_int()
            .is_ok_and(|seq| (0..=100_000_000).contains(&seq)))
    {
        return None;
    }
    if let Some(value) = value.get("eventOffset")
        && identity(value).is_none()
    {
        return None;
    }
    if let Some(J::Arr(events)) = value.get("pendingEvents") {
        if events.len() > 64 || !events.iter().all(pending_event) {
            return None;
        }
    } else if value.get("pendingEvents").is_some() {
        return None;
    }
    if let Some(raw) = value.get("raw")
        && !matches!(raw, J::Obj(_))
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
