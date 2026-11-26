#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! T4a's proof: `vectors/stored.json` is produced by `vectors/make-stored-vectors.ts` from
//! `apps/daemon/src/stored-decode.ts`, over legacy rows the trust tests describe. Every decoded
//! item, payload and event, its bytes, and the trust rule must be the TypeScript's.
//!
//! Cases ported by name from `apps/daemon/src/stored-history-trust.test.ts` and
//! `apps/daemon/src/item-store-trusted-reads.test.ts`:
//! - "history revisions written before a schema change are decoded with the new defaults"
//! - "an item's completion read from an older revision gets the new defaults"
//! - "one database read by two builds sees the same items" (the trusted and decoded rows agree)
//!
//! and from `apps/daemon/src/stored-trust-*.test.ts`, the trust rule itself.

use std::collections::BTreeSet;

use ace_json::Value;
use ace_store::reads::stored::{
    DecodeError, EntityKind, EventRow, Trust, decode_entity, decode_item, decode_payload,
    stored_entity, stored_event, stored_item, stored_payload, trusted_from, untrusted,
};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/stored.json");
    let text = std::fs::read_to_string(path).expect("read stored.json");
    ace_json::parse(&text).expect("parse stored.json")
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        _ => panic!("{key} is not an array"),
    }
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(seen)) => seen.as_str().to_owned(),
        _ => panic!("{key} is not a string"),
    }
}

fn number(value: &Value, key: &str) -> f64 {
    match value.get(key) {
        Some(Value::Number(seen)) => seen.value(),
        _ => panic!("{key} is not a number"),
    }
}

fn parse(text: &str) -> Value {
    ace_json::parse(text).expect("parse fixture JSON")
}

fn trust_of(value: &Value) -> Trust {
    let source = match value.get("from") {
        Some(Value::Number(seen)) => trusted_from(seen.value() as u64),
        _ => untrusted(),
    };
    let mut trust = source;
    for rejected in array(value, "rejected") {
        if let Value::Number(seq) = rejected {
            trust.rejected.insert(seq.value() as u64);
        }
    }
    trust
}

/// Every stored item decodes to the TypeScript's bytes.
#[test]
fn stored_items_decode_to_the_typescripts_bytes() {
    let vectors = vectors();
    for case in array(&vectors, "items") {
        let input = parse(&text(case, "input"));
        let decoded = decode_item(&input).expect("decode item");
        assert_eq!(
            ace_json::to_string(&decoded),
            text(case, "expected"),
            "{}",
            text(case, "name")
        );
    }
}

/// Every stored payload decodes to the TypeScript's bytes, the legacy transforms included.
#[test]
fn stored_payloads_decode_to_the_typescripts_bytes() {
    let vectors = vectors();
    for case in array(&vectors, "payloads") {
        let input = parse(&text(case, "input"));
        let decoded = decode_payload(&input).expect("decode payload");
        assert_eq!(
            ace_json::to_string(&decoded),
            text(case, "expected"),
            "{}",
            text(case, "name")
        );
    }
}

/// A stored event is the TypeScript's event and the same size a replay pages by.
#[test]
fn stored_events_are_the_typescripts_event_and_size() {
    let vectors = vectors();
    for case in array(&vectors, "rows") {
        let row = case.get("row").expect("row");
        let trust = trust_of(case.get("trust").expect("trust"));
        let (event, bytes) = stored_event(
            EventRow {
                seq: number(row, "seq") as u64,
                id: &text(row, "id"),
                thread_id: &text(row, "thread_id"),
                at: number(row, "at"),
                payload: &text(row, "payload"),
            },
            &trust,
        )
        .expect("stored event");
        assert_eq!(
            ace_json::to_string(&event),
            text(case, "event"),
            "{}",
            text(case, "name")
        );
        assert_eq!(
            bytes as f64,
            number(case, "bytes"),
            "{}",
            text(case, "name")
        );
    }
}

/// Every stored entity decodes to the TypeScript's bytes, for every `view_entities`
/// collection: the schema's defaults fill, unknown keys strip, and a trusted row is stored JSON.
#[test]
fn stored_entities_decode_to_the_typescripts_bytes() {
    let vectors = vectors();
    for case in array(&vectors, "entities") {
        let name = text(case, "name");
        let kind = entity_kind(&text(case, "collection"));
        let input = text(case, "input");
        let decoded = decode_entity(kind, &parse(&input));
        assert_eq!(
            ace_json::to_string(&decoded),
            text(case, "expected"),
            "{name}"
        );
        assert_eq!(
            ace_json::to_string(&stored_entity(kind, &input, true).expect("stored entity")),
            input,
            "{name} / trusted"
        );
    }
}

/// The collection a fixture names, as `storedEntitySchemas` spells it.
fn entity_kind(collection: &str) -> EntityKind {
    match collection {
        "agents" => EntityKind::Agent,
        "runs" => EntityKind::Run,
        "interactions" => EntityKind::Interaction,
        "backgroundTasks" => EntityKind::BackgroundTask,
        "usage" => EntityKind::Usage,
        "usageSnapshots" => EntityKind::UsageSnapshots,
        "contextMeters" => EntityKind::ContextMeter,
        "queue" => EntityKind::Queue,
        other => panic!("unknown entity collection {other}"),
    }
}

/// The trust rule: nothing until open, every row from the mark, a rejected sequence decoded.
#[test]
fn trust_is_the_typescripts() {
    let vectors = vectors();
    for case in array(&vectors, "trustCases") {
        let trust = trust_of(case.get("trust").expect("trust"));
        for entry in array(case, "seqs") {
            let seq = number(entry, "seq") as u64;
            let trusted = matches!(entry.get("trusted"), Some(Value::Bool(true)));
            assert_eq!(
                trust.is_trusted(seq),
                trusted,
                "{} / {seq}",
                text(case, "name")
            );
        }
    }
}

/// "History revisions written before a schema change are decoded with the new defaults."
#[test]
fn a_legacy_item_reads_with_the_new_defaults() {
    let legacy = parse(
        r#"{"id":"m0","agentId":"root","type":"message","role":"assistant","parts":[],"createdAt":1}"#,
    );
    let decoded = decode_item(&legacy).expect("decode");
    assert_eq!(decoded.get("complete"), Some(&Value::Bool(true)));
    assert_eq!(decoded.get("synthetic"), Some(&Value::Bool(false)));
    assert!(matches!(decoded.get("raw"), Some(Value::Array(items)) if items.is_empty()));
}

/// "An item's completion read from an older revision gets the new defaults": a stored row
/// without `synthetic` reads it as false.
#[test]
fn a_legacy_items_synthetic_reads_false() {
    let legacy = parse(
        r#"{"id":"m0","agentId":"root","type":"message","role":"assistant","parts":[],"createdAt":1,"complete":true}"#,
    );
    let decoded = decode_item(&legacy).expect("decode");
    assert_eq!(decoded.get("synthetic"), Some(&Value::Bool(false)));
}

/// "One database read by two builds sees the same items": a row this build wrote, read as
/// stored and decoded, gives the same bytes.
#[test]
fn a_trusted_row_and_a_decoded_row_agree() {
    let canonical = decode_item(&parse(
        r#"{"id":"m0","agentId":"root","type":"message","role":"assistant","parts":[],"createdAt":1}"#,
    ))
    .expect("decode");
    let json = ace_json::to_string(&canonical);
    let trusted = stored_item(10, &json, &trusted_from(5)).expect("trusted");
    let decoded = stored_item(0, &json, &untrusted()).expect("decoded");
    assert_eq!(ace_json::to_string(&trusted), ace_json::to_string(&decoded));
}

/// A trusted row is kept as stored (its unknown fields included); another row is decoded, which
/// strips them.
#[test]
fn a_trusted_payload_keeps_what_a_decoded_one_strips() {
    let json = r#"{"type":"thread.updated","title":"a \u00e9 \ud83d\ude00","complete":false}"#;
    let trusted = stored_payload(10, json, &trusted_from(5)).expect("trusted");
    assert_eq!(
        ace_json::to_string(&trusted),
        r#"{"type":"thread.updated","title":"a é 😀","complete":false}"#
    );
    let decoded = stored_payload(0, json, &untrusted()).expect("decoded");
    assert_eq!(
        ace_json::to_string(&decoded),
        r#"{"type":"thread.updated","title":"a é 😀"}"#
    );
}

/// A row that is not an object with a `type` is the one decode failure the TypeScript throws on.
#[test]
fn a_row_without_a_type_is_refused() {
    assert_eq!(decode_item(&parse("[]")), Err(DecodeError));
    assert_eq!(decode_payload(&parse(r#"{"type":1}"#)), Err(DecodeError));
    assert_eq!(stored_payload(0, "{", &untrusted()), Err(DecodeError));
    let mut rejected = BTreeSet::new();
    rejected.insert(5);
    let trust = Trust { from: 5, rejected };
    assert!(!trust.is_trusted(5));
}
