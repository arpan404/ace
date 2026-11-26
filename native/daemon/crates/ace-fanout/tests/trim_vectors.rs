#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Byte equality with `packages/projection/src/wire-trim.ts`. `vectors/wire-trim.json` is
//! produced by `vectors/make-trim-vectors.ts` from the TypeScript `WireTrimmer` and
//! `WireRestorer`: each step's frames are the bytes that connection received (events through
//! `WireEncoder`, every other message through `JSON.stringify`). The Rust trimmer and restorer
//! are driven over the same messages, in the same order, and must produce the same bytes.

use ace_fanout::WireEncoder;
use ace_fanout::encode::EventsMessage;
use ace_fanout::{WireRestorer, WireTrimmer};
use ace_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/wire-trim.json");
    let text = std::fs::read_to_string(path).expect("read wire-trim.json");
    ace_json::parse(&text).expect("parse wire-trim.json")
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(seen)) => seen.as_str().to_owned(),
        _ => panic!("{key} is not a string"),
    }
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        _ => panic!("{key} is not an array"),
    }
}

/// The bytes the daemon sends a frame as: an events message through the encoder, anything else
/// through `JSON.stringify`.
fn bytes_of(frame: &Value) -> String {
    if matches!(frame.get("type"), Some(Value::String(kind)) if kind == "events") {
        let message = EventsMessage::from_value(frame).expect("events message");
        return WireEncoder::new().encode(&message, ace_fanout::WHOLE_EVENTS);
    }
    ace_json::to_string(frame)
}

fn trims_of(case: &Value) -> Option<Vec<String>> {
    match case.get("trims") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|item| match item {
                    Value::String(text) => text.as_str().to_owned(),
                    _ => panic!("trim is not a string"),
                })
                .collect(),
        ),
        _ => panic!("trims is not an array"),
    }
}

#[test]
fn the_trimmer_sends_the_typescripts_bytes() {
    let vectors = vectors();
    for case in array(&vectors, "trimmer") {
        let trims = trims_of(case);
        let names: Vec<&str> = trims
            .as_ref()
            .map(|trims| trims.iter().map(String::as_str).collect())
            .unwrap_or_default();
        let mut trimmer = WireTrimmer::new(trims.as_ref().map(|_| names.as_slice()));
        for (index, step) in array(case, "steps").iter().enumerate() {
            let message = ace_json::parse(&text(step, "message")).expect("parse message");
            let frames = trimmer.outgoing(message);
            let sent: Vec<String> = frames.iter().map(bytes_of).collect();
            let expected: Vec<String> = array(step, "frames")
                .iter()
                .map(|frame| match frame {
                    Value::String(text) => text.as_str().to_owned(),
                    _ => panic!("frame is not a string"),
                })
                .collect();
            assert_eq!(sent, expected, "{} / step {index}", text(case, "name"));
        }
    }
}

#[test]
fn the_restorer_gives_back_the_typescripts_messages() {
    let vectors = vectors();
    for case in array(&vectors, "restorer") {
        let mut restorer = WireRestorer::new();
        let mut restored = Vec::new();
        for frame in array(case, "frames") {
            let Value::String(text) = frame else {
                panic!("frame is not a string");
            };
            let message = ace_json::parse(text).expect("parse frame");
            if let Some(message) = restorer.restore(message) {
                restored.push(bytes_of(&message));
            }
        }
        let expected: Vec<String> = array(case, "restored")
            .iter()
            .map(|message| match message {
                Value::String(text) => text.as_str().to_owned(),
                _ => panic!("restored is not a string"),
            })
            .collect();
        assert_eq!(restored, expected, "{}", text(case, "name"));
    }
}
