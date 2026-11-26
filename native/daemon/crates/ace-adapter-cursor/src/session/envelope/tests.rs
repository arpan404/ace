// SPDX-License-Identifier: Apache-2.0
//! The envelope contract's tables: the key order a frame crosses with, the code-point bounds, the
//! batch cases moved from `frame-batch.test.ts`, and the limits.

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
