// SPDX-License-Identifier: Apache-2.0
//! The SDK boundary contract (`contracts.ts`): the `Envelope` every host frame must be, the
//! `Limits` its launch accepts, and `unbatch`'s inner frames (`frame-batch.ts:144`-`:148`).
//!
//! Everything is a lookup on an `ace_json::Value`, so a frame nobody parses again is not built
//! twice. The bounds are the zod ones, and rule 17 applies: `z.string().min()/.max()` counts
//! **code points** here, while a plain `.length`, `.slice()` or `charCodeAt` would count UTF-16
//! units. `raw` and a batch's inner frames are rebuilt in schema key order, as zod's parse leaves
//! them, because that order is the JSON text the frame crosses with.

mod limits;
mod raw;

#[cfg(test)]
mod tests;

pub use limits::{CursorLimits, limits};

use super::code_points;
use raw::normalize_raw;

use ace_json::{JsString, Map, Value};

use super::error::SessionError;

/// The envelope's keys, in the schema's order (`contracts.ts:34`-`:60`).
pub const ENVELOPE_KEYS: [&str; 13] = [
    "schemaVersion",
    "operationId",
    "commandId",
    "generation",
    "segment",
    "agentId",
    "runId",
    "kind",
    "body",
    "raw",
    "eventSeq",
    "eventOffset",
    "pendingEvents",
];
/// `identity`: `z.string().min(1).max(512)` code points.
const IDENTITY_POINTS: usize = 512;
/// `kind`: `z.string().min(1).max(128)` code points.
const KIND_POINTS: usize = 128;
/// `eventSeq`: `z.number().int().nonnegative().max(100_000_000)`.
const EVENT_SEQ_MAX: f64 = 100_000_000.0;
/// `pendingEvents`: an array of at most 64 ids.
const PENDING_MAX: usize = 64;
/// `BatchBody`: `z.array(Envelope).min(1).max(1024)`.
const BATCH_MAX: usize = 1024;
/// `RawPayload.preview`: at most 2,048 UTF-8 bytes (`provider-data.ts:32`-`:36`).
const PREVIEW_BYTES: usize = 2_048;

/// A decoded envelope, borrowed from its frame.
#[derive(Debug)]
pub struct Envelope<'a> {
    pub operation_id: &'a JsString,
    pub command_id: Option<&'a JsString>,
    pub generation: &'a JsString,
    pub segment: f64,
    pub agent_id: Option<&'a JsString>,
    pub run_id: Option<&'a JsString>,
    pub kind: &'a JsString,
    pub body: &'a Value,
    pub raw: Option<&'a Value>,
}

impl Envelope<'_> {
    /// `kind === "batch"`: the host coalesced several frames into one request.
    pub fn is_batch(&self) -> bool {
        self.kind.as_str() == "batch"
    }
}

/// `identity`: a non-empty string of at most 512 code points.
fn identity(value: &Value) -> Option<&JsString> {
    match value {
        Value::String(text) if !text.is_empty() && code_points(text) <= IDENTITY_POINTS => {
            Some(text)
        }
        _ => None,
    }
}

fn optional_identity<'a>(object: &'a Map, key: &str) -> Result<Option<&'a JsString>, SessionError> {
    match object.get(key) {
        None => Ok(None),
        Some(value) => identity(value)
            .map(Some)
            .ok_or(SessionError::Envelope(key_message(key))),
    }
}

fn key_message(key: &str) -> &'static str {
    match key {
        "operationId" => "operationId is not 1 to 512 characters",
        "commandId" => "commandId is not 1 to 512 characters",
        "generation" => "generation is not 1 to 512 characters",
        "agentId" => "agentId is not 1 to 512 characters",
        "runId" => "runId is not 1 to 512 characters",
        "eventOffset" => "eventOffset is not 1 to 512 characters",
        _ => "a field did not fit its bound",
    }
}

pub(super) fn is_integer(value: f64) -> bool {
    value.is_finite() && value.fract() == 0.0
}

fn integer_field(object: &Map, key: &str) -> Option<f64> {
    match object.get(key).and_then(Value::as_f64) {
        Some(value) if is_integer(value) => Some(value),
        _ => None,
    }
}

/// `Envelope.safeParse`, as a check plus a borrowed view.
pub fn parse(value: &Value) -> Result<Envelope<'_>, SessionError> {
    let object = value
        .as_object()
        .ok_or(SessionError::Envelope("not an object"))?;
    match integer_field(object, "schemaVersion") {
        Some(1.0) => {}
        _ => return Err(SessionError::Envelope("schemaVersion is not 1")),
    }
    let operation_id = object
        .get("operationId")
        .and_then(identity)
        .ok_or(SessionError::Envelope(key_message("operationId")))?;
    let generation = object
        .get("generation")
        .and_then(identity)
        .ok_or(SessionError::Envelope(key_message("generation")))?;
    let segment = match object.get("segment").and_then(Value::as_f64) {
        Some(segment) if is_integer(segment) && segment >= 0.0 => segment,
        _ => {
            return Err(SessionError::Envelope(
                "segment is not a non-negative integer",
            ));
        }
    };
    let kind = match object.get("kind") {
        Some(Value::String(kind)) if !kind.is_empty() && code_points(kind) <= KIND_POINTS => kind,
        _ => return Err(SessionError::Envelope("kind is not 1 to 128 characters")),
    };
    let body = object
        .get("body")
        .ok_or(SessionError::Envelope("body is missing"))?;
    if let Some(value) = object.get("raw") {
        normalize_raw(value)?;
    }
    if let Some(value) = object.get("eventSeq") {
        let valid = value
            .as_f64()
            .is_some_and(|seq| is_integer(seq) && (0.0..=EVENT_SEQ_MAX).contains(&seq));
        if !valid {
            return Err(SessionError::Envelope("eventSeq is not a stored sequence"));
        }
    }
    optional_identity(object, "eventOffset")?;
    if let Some(value) = object.get("pendingEvents") {
        let Value::Array(events) = value else {
            return Err(SessionError::Envelope("pendingEvents is not an array"));
        };
        if events.len() > PENDING_MAX {
            return Err(SessionError::Envelope("pendingEvents exceeds 64 entries"));
        }
        if !events.iter().all(pending_event) {
            return Err(SessionError::Envelope(
                "pendingEvents is not a run-seam id list",
            ));
        }
    }
    Ok(Envelope {
        operation_id,
        command_id: optional_identity(object, "commandId")?,
        generation,
        segment,
        agent_id: optional_identity(object, "agentId")?,
        run_id: optional_identity(object, "runId")?,
        kind,
        body,
        raw: object.get("raw"),
    })
}

/// A run-seam id: 64 lowercase hex digits, or two of them joined by a colon.
fn pending_event(value: &Value) -> bool {
    let Value::String(text) = value else {
        return false;
    };
    let units: Vec<u16> = text.units().collect();
    let hex = |slice: &[u16]| {
        slice.len() == 64
            && slice
                .iter()
                .all(|unit| matches!(unit, 0x30..=0x39 | 0x61..=0x66))
    };
    hex(&units)
        || (units.len() == 129
            && units.get(64) == Some(&0x3a)
            && hex(&units[..64])
            && hex(&units[65..]))
}

/// `JSON.stringify(Envelope.parse(value))`'s value: the schema's keys first, in schema order,
/// then the keys the schema doesn't name, in their own order (porting-guide rule 8).
pub fn normalize(value: &Value) -> Result<Value, SessionError> {
    let object = value
        .as_object()
        .ok_or(SessionError::Envelope("not an object"))?;
    parse(value)?;
    let mut normalized = Map::with_capacity(object.len());
    for key in ENVELOPE_KEYS {
        if let Some(field) = object.get(key) {
            let field = if key == "raw" {
                normalize_raw(field)?
            } else {
                field.clone()
            };
            normalized.insert(key, field);
        }
    }
    for (key, field) in object.iter() {
        if !ENVELOPE_KEYS.contains(&key.as_str()) {
            normalized.insert(key.clone(), field.clone());
        }
    }
    Ok(Value::Object(normalized))
}

/// `unbatch` (`frame-batch.ts:144`-`:148`): a batch's inner frames, each normalized.
pub fn unbatch(value: &Value) -> Result<Vec<Value>, SessionError> {
    match value.get("kind") {
        Some(Value::String(kind)) if kind.as_str() == "batch" => {}
        _ => return Ok(vec![value.clone()]),
    }
    let frames = value
        .get("body")
        .and_then(|body| body.get("frames"))
        .and_then(Value::as_array)
        .ok_or(SessionError::MalformedBatch)?;
    if frames.is_empty() || frames.len() > BATCH_MAX {
        return Err(SessionError::MalformedBatch);
    }
    frames
        .iter()
        .map(|frame| normalize(frame).map_err(|_| SessionError::MalformedBatch))
        .collect()
}
