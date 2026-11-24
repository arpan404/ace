#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! The live buffer's compaction vectors (task 5.4a): `fold.json` holds, for each event list,
//! the text that crossed and the rows the TypeScript `compactDeltas` gives.

use ace_json::{Map, Value};

#[test]
fn compact_vectors_match_typescript() {
    let path = env!("CARGO_MANIFEST_DIR").to_owned() + "/../../vectors/fold.json";
    let text = std::fs::read_to_string(&path).expect("read fold.json");
    let parsed = ace_json::parse(&text).expect("parse fold.json");
    let Value::Object(root) = &parsed else {
        panic!("fold.json holds an object");
    };
    let cases = match root.get("compact") {
        Some(Value::Array(items)) => items,
        _ => panic!("fold.json holds compact cases"),
    };
    for case in cases.iter() {
        let Value::Object(case) = case else {
            panic!("compact cases are objects");
        };
        let name = case
            .get("name")
            .and_then(Value::as_str)
            .expect("case names a field")
            .to_owned();
        let events_text = case
            .get("events")
            .and_then(Value::as_str)
            .expect("events is text");
        let compacted = case
            .get("compacted")
            .and_then(Value::as_str)
            .expect("compacted is text");
        let events_value = ace_json::parse(events_text).expect("parse events text");
        let items = match &events_value {
            Value::Array(items) => items,
            _ => panic!("events text is an array"),
        };
        let mut events: Vec<Map> = Vec::with_capacity(items.len());
        for item in items.iter() {
            let Value::Object(map) = item else {
                panic!("events text holds objects");
            };
            events.push(map.clone());
        }
        let rows = ace_store::writer::live::compact::compact_deltas(&events);
        let unchanged: Vec<Value> = events.into_iter().map(Value::Object).collect();
        assert_eq!(
            ace_json::to_string(&Value::Array(unchanged.into())),
            events_text,
            "inputs changed for {name}"
        );
        let rows: Vec<Value> = rows.into_iter().map(Value::Object).collect();
        assert_eq!(
            ace_json::to_string(&Value::Array(rows.into())),
            compacted,
            "rows for {name}"
        );
    }
}
