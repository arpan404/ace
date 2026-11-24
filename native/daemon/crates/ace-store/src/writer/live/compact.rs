// SPDX-License-Identifier: Apache-2.0
//! Delta compaction for the live write buffer (task 5.4a). Ports `compactDeltas` from
//! `apps/daemon/src/live-write-buffer.ts`: adjacent `item.delta` events of one thread, item,
//! agent and field become one row while their appends' UTF-8 bytes fit 4 KiB. The merged row
//! is the later event's envelope with the append replaced in place by `earlier + later`, so the
//! appended pair of UTF-16 units joins like JavaScript's `+` and key order is the later
//! payload's. Pure: inputs are never changed.

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

/// Merge `event` into the previous row when the TypeScript would; says whether it did.
fn merge(previous: &mut Map, event: &Map) -> bool {
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
    // The 4 KiB check counts the two parts as the TypeScript does: the sum of their own byte
    // counts, not the count of the joined string, so a pair split across them counts six.
    if byte_length(earlier).saturating_add(byte_length(later)) > MAX_DELTA_BYTES {
        return false;
    }
    let mut joined = earlier.clone();
    joined.push_js(later);
    // The later event's envelope: its keys keep their order, and `append` keeps its own place.
    let mut merged = event.clone();
    if let Some(payload) = merged.get_mut("payload").and_then(Value::as_object_mut) {
        payload.insert("append", Value::String(joined));
    }
    *previous = merged;
    true
}

/// Adjacent `item.delta` events of one thread, item, agent and field merge into one row while
/// the UTF-8 bytes of both appends total at most 4096. Inputs are not changed.
pub fn compact_deltas(events: &[Map]) -> Vec<Map> {
    let mut rows: Vec<Map> = Vec::with_capacity(events.len());
    for event in events {
        let merged = match rows.last_mut() {
            Some(previous) => merge(previous, event),
            None => false,
        };
        if !merged {
            rows.push(event.clone());
        }
    }
    rows
}
