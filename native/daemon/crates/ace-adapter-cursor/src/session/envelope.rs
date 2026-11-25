// SPDX-License-Identifier: Apache-2.0
//! The SDK boundary contract (`contracts.ts`): the `Envelope` every host frame must be, the
//! `Limits` its launch accepts, and `unbatch`'s inner frames (`frame-batch.ts:144`–`:148`).
//!
//! Everything is a lookup on an `ace_json::Value`, so a frame nobody parses again is not built
//! twice. The bounds are the zod ones, and rule 17 applies: `z.string().min()/.max()` counts
//! **code points** here, while a plain `.length`, `.slice()` or `charCodeAt` would count UTF-16
//! units. `raw` and a batch's inner frames are rebuilt in schema key order, as zod's parse leaves
//! them, because that order is the JSON text the frame crosses with.

use ace_json::{JsString, Map, Value};

use super::error::SessionError;

/// The envelope's keys, in the schema's order (`contracts.ts:34`–`:60`).
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
/// `RawPayload.preview`: at most 2,048 UTF-8 bytes (`provider-data.ts:32`–`:36`).
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

/// The cursor's `Limits`, after `Limits.parse` filled its defaults (`contracts.ts:17`–`:30`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CursorLimits {
    pub max_workers: u32,
    pub max_frame_bytes: usize,
    pub max_pending_bytes: usize,
    pub max_callbacks: u32,
    pub max_identities: u32,
    pub max_input_bytes: usize,
    pub max_checkpoint_bytes: u64,
    pub history_page_size: u32,
    pub heap_mb: u32,
    pub timeout_ms: f64,
    pub send_timeout_ms: f64,
    pub ack_timeout_ms: f64,
    pub grace_ms: f64,
}

impl Default for CursorLimits {
    fn default() -> CursorLimits {
        CursorLimits {
            max_workers: 8,
            max_frame_bytes: 1_048_576,
            max_pending_bytes: 2_097_152,
            max_callbacks: 32,
            max_identities: 2_048,
            max_input_bytes: 262_144,
            max_checkpoint_bytes: 8_589_934_592,
            history_page_size: 100,
            heap_mb: 2_048,
            timeout_ms: 30_000.0,
            send_timeout_ms: 300_000.0,
            ack_timeout_ms: 300_000.0,
            grace_ms: 5_000.0,
        }
    }
}

/// The limits' keys, in the schema's order (`contracts.ts:18`–`:29`); the object is strict.
const LIMIT_KEYS: [&str; 13] = [
    "maxWorkers",
    "maxFrameBytes",
    "maxPendingBytes",
    "maxCallbacks",
    "maxIdentities",
    "maxInputBytes",
    "maxCheckpointBytes",
    "historyPageSize",
    "heapMb",
    "timeoutMs",
    "sendTimeoutMs",
    "ackTimeoutMs",
    "graceMs",
];

/// JavaScript's character count: one per UTF-16 unit, except a surrogate pair.
fn code_points(text: &JsString) -> usize {
    let mut count = 0;
    let mut high = false;
    for unit in text.units() {
        if high && (0xdc00..0xe000).contains(&unit) {
            high = false;
            continue;
        }
        high = (0xd800..0xdc00).contains(&unit);
        count += 1;
    }
    count
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

fn is_integer(value: f64) -> bool {
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

/// `RawPayload` (`provider-data.ts:20`–`:37`): the inline form first, else the blob form. zod's
/// object parse strips the keys it doesn't name and keeps the schema's order.
fn normalize_raw(value: &Value) -> Result<Value, SessionError> {
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

/// `unbatch` (`frame-batch.ts:144`–`:148`): a batch's inner frames, each normalized.
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

/// `Limits.parse(value)` (`contracts.ts:17`–`:30`): every default, every bound, strict keys.
pub fn limits(value: &Value) -> Result<CursorLimits, SessionError> {
    let object = value
        .as_object()
        .ok_or_else(|| SessionError::Limits("not an object".into()))?;
    for key in object.keys() {
        if !LIMIT_KEYS.contains(&key.as_str()) {
            return Err(SessionError::Limits(format!("unknown limit {key}")));
        }
    }
    let defaults = CursorLimits::default();
    let mut parsed = defaults;
    parsed.max_workers = limit_integer(object, "maxWorkers", 1.0, 64.0)?
        .unwrap_or(defaults.max_workers as f64) as u32;
    parsed.max_frame_bytes = limit_integer(object, "maxFrameBytes", 4_096.0, 1_048_576.0)?
        .unwrap_or(defaults.max_frame_bytes as f64) as usize;
    parsed.max_pending_bytes = limit_integer(object, "maxPendingBytes", 4_096.0, 8_388_608.0)?
        .unwrap_or(defaults.max_pending_bytes as f64) as usize;
    parsed.max_callbacks = limit_integer(object, "maxCallbacks", 1.0, 256.0)?
        .unwrap_or(defaults.max_callbacks as f64) as u32;
    parsed.max_identities = limit_integer(object, "maxIdentities", 1.0, 8_192.0)?
        .unwrap_or(defaults.max_identities as f64) as u32;
    parsed.max_input_bytes = limit_integer(object, "maxInputBytes", 1.0, 524_288.0)?
        .unwrap_or(defaults.max_input_bytes as f64) as usize;
    parsed.max_checkpoint_bytes =
        limit_integer(object, "maxCheckpointBytes", 1.0, 68_719_476_736.0)?
            .unwrap_or(defaults.max_checkpoint_bytes as f64) as u64;
    parsed.history_page_size = limit_integer(object, "historyPageSize", 1.0, 200.0)?
        .unwrap_or(defaults.history_page_size as f64) as u32;
    parsed.heap_mb =
        limit_integer(object, "heapMb", 64.0, 8_192.0)?.unwrap_or(defaults.heap_mb as f64) as u32;
    parsed.timeout_ms =
        limit_integer(object, "timeoutMs", 1.0, 300_000.0)?.unwrap_or(defaults.timeout_ms);
    parsed.send_timeout_ms =
        limit_integer(object, "sendTimeoutMs", 1.0, 600_000.0)?.unwrap_or(defaults.send_timeout_ms);
    parsed.ack_timeout_ms =
        limit_integer(object, "ackTimeoutMs", 1.0, 600_000.0)?.unwrap_or(defaults.ack_timeout_ms);
    parsed.grace_ms = limit_integer(object, "graceMs", 0.0, 30_000.0)?.unwrap_or(defaults.grace_ms);
    Ok(parsed)
}

fn limit_integer(object: &Map, key: &str, min: f64, max: f64) -> Result<Option<f64>, SessionError> {
    match object.get(key) {
        None => Ok(None),
        Some(Value::Number(number)) => {
            let value = number.value();
            if is_integer(value) && value >= min && value <= max {
                Ok(Some(value))
            } else {
                Err(SessionError::Limits(format!(
                    "{key} is not an integer from {min} to {max}"
                )))
            }
        }
        Some(_) => Err(SessionError::Limits(format!("{key} is not a number"))),
    }
}

#[cfg(test)]
mod tests {
    use ace_json::{Value, json};

    use super::{CursorLimits, limits, normalize, parse, unbatch};
    use crate::session::error::SessionError;

    fn envelope_json() -> Value {
        json!({
            "schemaVersion": 1,
            "generation": "g",
            "operationId": "op",
            "segment": 0,
            "runId": "run",
            "kind": "delta",
            "body": {"type": "text-delta", "text": "hi"}
        })
    }

    #[test]
    fn an_envelope_in_any_key_order_parses() {
        let value = envelope_json();
        let envelope = parse(&value).expect("an envelope");
        assert_eq!(envelope.operation_id.as_str(), "op");
        assert_eq!(envelope.generation.as_str(), "g");
        assert_eq!(envelope.kind.as_str(), "delta");
        assert_eq!(envelope.segment, 0.0);
        assert!(envelope.command_id.is_none());
        assert!(envelope.body.get("text").is_some());
    }

    #[test]
    fn the_envelope_bounds_count_code_points_and_keep_body_mandatory() {
        let ok = json!({
            "schemaVersion": 1, "operationId": "😀".repeat(512), "generation": "g",
            "segment": 0, "kind": "😀".repeat(128), "body": null
        });
        assert!(parse(&ok).is_ok());
        let too_long = json!({
            "schemaVersion": 1, "operationId": "😀".repeat(513), "generation": "g",
            "segment": 0, "kind": "delta", "body": null
        });
        assert!(parse(&too_long).is_err());
        let no_body = json!({
            "schemaVersion": 1, "operationId": "op", "generation": "g",
            "segment": 0, "kind": "delta"
        });
        assert_eq!(
            parse(&no_body).err(),
            Some(SessionError::Envelope("body is missing"))
        );
    }

    #[test]
    fn a_stored_batch_unpacks_into_its_frames_in_order() {
        // The TypeScript case (`frame-batch.test.ts`): a batch unpacks into its frames in order,
        // and a frame that is not a batch is itself. The schema-order rewrite is proved by
        // `host.rs`, where the inner keys arrive in an order the schema does not use.
        let frames = vec![
            json!({
                "schemaVersion": 1, "operationId": "op", "generation": "g", "segment": 0,
                "kind": "delta", "body": {"type": "text-delta", "text": "1"}
            }),
            json!({
                "schemaVersion": 1, "operationId": "op", "generation": "g", "segment": 0,
                "kind": "delta", "body": {"type": "text-delta", "text": "2"}
            }),
        ];
        let mut batch = frames[0].clone();
        if let Value::Object(object) = &mut batch {
            object.insert("kind", json!("batch"));
            let mut body = ace_json::Map::new();
            body.insert("frames", Value::Array(frames.clone().into()));
            object.insert("body", Value::Object(body));
        }
        let unpacked = unbatch(&batch).expect("a batch");
        assert_eq!(unpacked.len(), 2);
        assert_eq!(unpacked[0].to_json(), frames[0].to_json());
        assert_eq!(unpacked[1].to_json(), frames[1].to_json());
        // A frame that is not a batch is itself, unchanged.
        assert_eq!(unbatch(&frames[0]).ok(), Some(vec![frames[0].clone()]));
    }

    #[test]
    fn a_batch_whose_body_has_no_frames_is_malformed() {
        let mut frame = envelope_json();
        if let Value::Object(object) = &mut frame {
            object.insert("kind", json!("batch"));
            object.insert("body", Value::Object(ace_json::Map::new()));
        }
        assert_eq!(unbatch(&frame).err(), Some(SessionError::MalformedBatch));
        let empty = json!({"frames": []});
        let mut frame = envelope_json();
        if let Value::Object(object) = &mut frame {
            object.insert("kind", json!("batch"));
            object.insert("body", empty);
        }
        assert_eq!(unbatch(&frame).err(), Some(SessionError::MalformedBatch));
    }

    #[test]
    fn the_schema_keys_come_first_and_the_others_keep_their_order() {
        let value = json!({
            "future": {"kept": true},
            "body": {"a": 1},
            "kind": "delta",
            "segment": 0,
            "generation": "g",
            "operationId": "op",
            "schemaVersion": 1,
            "raw": {"data": {"q": 1}, "type": "native", "dropped": false},
            "also": 2
        });
        let normalized = normalize(&value).expect("an envelope");
        assert_eq!(
            normalized.to_json(),
            r#"{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"delta","body":{"a":1},"raw":{"type":"native","data":{"q":1}},"future":{"kept":true},"also":2}"#
        );
    }

    #[test]
    fn a_blob_raw_keeps_its_own_schema_order_and_preview_bound() {
        let value = json!({
            "schemaVersion": 1, "operationId": "op", "generation": "g", "segment": 0,
            "kind": "delta", "body": null,
            "raw": {"preview": "p", "size": 2, "blobRef": "b", "type": "native", "junk": 1}
        });
        let normalized = normalize(&value).expect("an envelope");
        assert_eq!(
            normalized.get("raw").map(Value::to_json),
            Some(r#"{"type":"native","blobRef":"b","size":2,"preview":"p"}"#.to_owned())
        );
        let over = json!({
            "schemaVersion": 1, "operationId": "op", "generation": "g", "segment": 0,
            "kind": "delta", "body": null,
            "raw": {"type": "native", "blobRef": "b", "size": 1, "preview": "😀".repeat(683)}
        });
        assert_eq!(
            parse(&over).err(),
            Some(SessionError::Envelope("raw.preview exceeds 2048 bytes"))
        );
    }

    #[test]
    fn the_limits_fill_their_defaults_and_refuse_what_the_schema_refuses() {
        assert_eq!(limits(&json!({})), Ok(CursorLimits::default()));
        let widened =
            limits(&json!({"maxWorkers": 4, "timeoutMs": 1_000, "graceMs": 0})).expect("limits");
        assert_eq!(widened.max_workers, 4);
        assert_eq!(widened.timeout_ms, 1_000.0);
        assert_eq!(widened.grace_ms, 0.0);
        // `maxWorkers` is `positive().max(64)`: zero, 65 and 1.5 are all refused.
        assert!(limits(&json!({"maxWorkers": 0})).is_err());
        assert!(limits(&json!({"maxWorkers": 65})).is_err());
        assert!(limits(&json!({"maxWorkers": 1.5})).is_err());
        assert!(limits(&json!({"maxWorkers": "4"})).is_err());
        // The object is strict.
        assert!(limits(&json!({"maxWorkers": 4, "unknown": 1})).is_err());
    }
}
