#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Byte equality with the TypeScript encoder. `vectors/wire-encoder.json` is produced by
//! `vectors/make-vectors.ts` from `apps/daemon/src/wire-encoder.ts`'s `WireEncoder` and
//! `EventEncodings` (and `@ace/projection`'s short-delta and raw-on-demand trims). Every
//! expected string here is a byte the TypeScript produced, so a divergence in key order,
//! number printing, string escaping, frame boundaries or trimming fails this file.

use ace_fanout::encode::{EventShape, WHOLE_EVENTS};
use ace_fanout::{DeliveryEvent, EventEncodings, EventsMessage, WireEncoder, short_delta_json};
use ace_json::Value;

const GROUPS: [&str; 4] = ["whole", "rawOnDemand", "shortDeltas", "every"];

fn shape_named(group: &str) -> EventShape {
    match group {
        "whole" => WHOLE_EVENTS,
        "rawOnDemand" => EventShape {
            raw_on_demand: true,
            short_deltas: false,
        },
        "shortDeltas" => EventShape {
            raw_on_demand: false,
            short_deltas: true,
        },
        "every" => EventShape {
            raw_on_demand: true,
            short_deltas: true,
        },
        _ => panic!("unknown shape group {group}"),
    }
}

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/wire-encoder.json");
    let text = std::fs::read_to_string(path).expect("read wire-encoder.json");
    ace_json::parse(&text).expect("parse wire-encoder.json")
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

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        _ => panic!("{key} is not an array"),
    }
}

fn object<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.get(key).unwrap_or_else(|| panic!("{key} is missing"))
}

#[test]
fn one_event_is_encoded_as_the_typescript_encoded_it() {
    let vectors = vectors();
    let encodings = EventEncodings::new();
    for case in array(&vectors, "encodings") {
        let event = DeliveryEvent::parse(&text(case, "event")).expect("parse event");
        assert_eq!(
            encodings.json(&event),
            text(case, "whole"),
            "{}",
            text(case, "name")
        );
        assert_eq!(
            encodings.bytes(&event) as f64,
            number(case, "bytes"),
            "{}",
            text(case, "name")
        );
        assert_eq!(
            encodings.trimmed_json(&event),
            text(case, "trimmed"),
            "{}",
            text(case, "name")
        );
        assert_eq!(
            encodings.trimmed_bytes(&event) as f64,
            number(case, "trimmedBytes"),
            "{}",
            text(case, "name")
        );
        // The short-delta frame is what `trimmedJson` holds for a delta, exactly.
        if event
            .payload_type()
            .is_some_and(|kind| kind == "item.delta")
        {
            assert_eq!(
                short_delta_json(&event).as_deref(),
                Some(text(case, "trimmed").as_str())
            );
        }
    }
}

#[test]
fn events_messages_encode_to_the_typescripts_bytes() {
    let vectors = vectors();
    let encoder = WireEncoder::new();
    for case in array(&vectors, "messages") {
        let message = events_message(case);
        for group in GROUPS {
            let shape = shape_named(group);
            let expected = object(object(case, "shapes"), group);
            assert_eq!(
                encoder.encode(&message, shape),
                text(expected, "encoded"),
                "{} / {group}",
                text(case, "name")
            );
            assert_eq!(
                encoder.encoded_bytes(&message, shape) as f64,
                number(expected, "encodedBytes"),
                "{} / {group}",
                text(case, "name")
            );
            let frames: Vec<String> = encoder
                .split(&message, shape)
                .iter()
                .map(|frame| encoder.encode(frame, shape))
                .collect();
            let expected: Vec<String> = array(expected, "frames")
                .iter()
                .map(|frame| match frame {
                    Value::String(text) => text.as_str().to_owned(),
                    _ => panic!("frame is not a string"),
                })
                .collect();
            assert_eq!(frames, expected, "{} / {group}", text(case, "name"));
        }
    }
}

fn events_message(case: &Value) -> EventsMessage {
    let events: Vec<DeliveryEvent> = array(case, "events")
        .iter()
        .map(|event| match event {
            Value::String(text) => DeliveryEvent::parse(text.as_str()).expect("parse event"),
            _ => panic!("event is not a string"),
        })
        .collect();
    EventsMessage {
        subscription_id: ace_json::JsString::from(text(case, "subscriptionId")),
        after_seq: number(case, "afterSeq"),
        through_seq: number(case, "throughSeq"),
        early: matches!(case.get("early"), Some(Value::Bool(true))),
        events,
    }
}
