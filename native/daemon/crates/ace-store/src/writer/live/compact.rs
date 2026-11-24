// SPDX-License-Identifier: Apache-2.0
//! Delta compaction for the live write buffer (task 5.4a). Ports `compactDeltas` from
//! `apps/daemon/src/live-write-buffer.ts`: adjacent `item.delta` events of one thread, item,
//! agent and field become one row while their appends' UTF-8 bytes fit 4 KiB. The merged row
//! is the later event's envelope with the append replaced in place by `earlier + later`, so the
//! appended pair of UTF-16 units joins like JavaScript's `+` and key order is the later
//! payload's. The events are consumed and untouched rows are moved, never cloned.

use ace_json::{JsString, Map, Value};

/// The most UTF-8 bytes two appends may total and still become one row.
const MAX_DELTA_BYTES: usize = 4096;

/// Whether `unit` is a UTF-16 high surrogate.
fn is_high(unit: u16) -> bool {
    (0xd800..0xdc00).contains(&unit)
}

/// Whether `unit` is a UTF-16 low surrogate.
fn is_low(unit: u16) -> bool {
    (0xdc00..0xe000).contains(&unit)
}

/// `Buffer.byteLength(text)`: its UTF-8 bytes, where a lone surrogate counts three (Node
/// encodes it as WTF-8) and a surrogate pair four.
fn byte_length(text: &JsString) -> usize {
    let Some(utf8) = text.as_well_formed() else {
        let mut bytes = 0;
        let mut units = text.units().peekable();
        while let Some(unit) = units.next() {
            bytes += if unit < 0x80 {
                1
            } else if unit < 0x800 {
                2
            } else if is_high(unit) && units.peek().is_some_and(|next| is_low(*next)) {
                units.next();
                4
            } else {
                3
            };
        }
        return bytes;
    };
    utf8.len()
}

/// The `payload` object of an event, when it has one.
fn payload(event: &Map) -> Option<&Map> {
    event.get("payload").and_then(Value::as_object)
}

/// Whether a payload is an `item.delta`.
fn is_delta(payload: &Map) -> bool {
    payload
        .get("type")
        .and_then(Value::as_js_str)
        .is_some_and(|kind| kind == "item.delta")
}

/// Whether `event` belongs in the row `previous`: the TypeScript's merge conditions, including
/// the 4 KiB sum counted on the two parts, so a pair split across them costs six bytes.
fn can_merge(previous: &Map, event: &Map) -> bool {
    let Some(earlier_payload) = payload(previous) else {
        return false;
    };
    let Some(later_payload) = payload(event) else {
        return false;
    };
    if !is_delta(earlier_payload)
        || !is_delta(later_payload)
        || previous.get("threadId") != event.get("threadId")
        || earlier_payload.get("itemId") != later_payload.get("itemId")
        || earlier_payload.get("agentId") != later_payload.get("agentId")
        || earlier_payload.get("field") != later_payload.get("field")
    {
        return false;
    }
    let (Some(Value::String(earlier)), Some(Value::String(later))) =
        (earlier_payload.get("append"), later_payload.get("append"))
    else {
        return false;
    };
    byte_length(earlier).saturating_add(byte_length(later)) <= MAX_DELTA_BYTES
}

/// Merge `event` into the row `previous` in place, or hand `event` back unchanged.
fn merge(previous: &mut Map, event: Map) -> Result<(), Map> {
    if !can_merge(previous, &event) {
        return Err(event);
    }
    let mut event = event;
    // The later event's envelope: its keys keep their order, and `append` keeps its own place.
    let Some(later_slot) = event
        .get_mut("payload")
        .and_then(Value::as_object_mut)
        .and_then(|payload| payload.get_mut("append"))
    else {
        return Err(event);
    };
    let Value::String(later_append) = later_slot else {
        return Err(event);
    };
    // The earlier string is moved out of the row being replaced and extended with the later
    // one, then put back where the later append was. Nothing is cloned.
    let Some(Value::String(mut joined)) = previous
        .get_mut("payload")
        .and_then(Value::as_object_mut)
        .and_then(|payload| payload.remove("append"))
    else {
        return Err(event);
    };
    joined.push_js(later_append);
    *later_slot = Value::String(joined);
    *previous = event;
    Ok(())
}

/// Adjacent `item.delta` events of one thread, item, agent and field merge into one row while
/// the UTF-8 bytes of both appends total at most 4096. Consumes the events; the returned rows
/// are the survivors themselves.
pub fn compact_deltas(events: Vec<Map>) -> Vec<Map> {
    let mut rows: Vec<Map> = Vec::with_capacity(events.len());
    for event in events {
        let merged = match rows.last_mut() {
            Some(previous) => merge(previous, event),
            None => Err(event),
        };
        if let Err(event) = merged {
            rows.push(event);
        }
    }
    rows
}
