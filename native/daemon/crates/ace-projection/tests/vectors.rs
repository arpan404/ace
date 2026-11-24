#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! The fold vectors: `fold.json` holds exactly what crosses and what the TypeScript gives.

use ace_json::{Map, Value};
use ace_projection::{FoldEvent, is_sidebar_event, update_thread};

fn field<'a>(case: &'a Map, name: &str) -> &'a Value {
    case.get(name).expect("vector case names a field")
}

#[test]
fn fold_vectors_match_typescript() {
    let root = env!("CARGO_MANIFEST_DIR").to_owned() + "/../../vectors/fold.json";
    let text = std::fs::read_to_string(&root).expect("read fold.json");
    let parsed = ace_json::parse(&text).expect("parse fold.json");
    let Value::Object(root) = &parsed else {
        panic!("fold.json holds an object");
    };
    let cases = match root.get("fold") {
        Some(Value::Array(items)) => items,
        _ => panic!("fold.json holds fold cases"),
    };
    let mut reaching = 0;
    for case in cases.iter() {
        let map = match case {
            Value::Object(map) => map,
            _ => panic!("fold.json holds objects"),
        };
        let kind = field(map, "kind")
            .as_str()
            .expect("kind is a string")
            .to_owned();
        let sidebar = field(map, "sidebar").as_bool().expect("sidebar is a bool");
        assert_eq!(is_sidebar_event(&kind), sidebar, "sidebar for {}", kind);
        let reaches = field(map, "reaches").as_bool().expect("reaches is a bool");
        let folded = field(map, "folded")
            .as_str()
            .expect("folded is text")
            .to_owned();
        let thread_text = field(map, "thread")
            .as_str()
            .expect("thread is text")
            .to_owned();
        if !reaches {
            continue;
        }
        reaching += 1;
        let seq = field(map, "seq").as_f64().expect("seq is a number");
        let at = field(map, "at").as_f64().expect("at is a number");
        let thread_value = ace_json::parse(&thread_text).expect("parse thread text");
        let mut thread_map = match thread_value {
            Value::Object(map) => map,
            _ => panic!("thread text is an object"),
        };
        let payload_text = match field(map, "payload") {
            Value::Null => None,
            Value::String(text) => Some(text.as_str().to_owned()),
            _ => panic!("payload is text or null"),
        };
        let payload_value =
            payload_text.map(|text| ace_json::parse(&text).expect("parse payload text"));
        let event = FoldEvent::from_wire(&kind, payload_value.as_ref(), seq).expect("from_wire");
        update_thread(&mut thread_map, event, at).expect("update_thread");
        assert_eq!(
            ace_json::to_string(&Value::Object(thread_map)),
            folded,
            "folded for {}",
            field(map, "name").as_str().unwrap_or("case")
        );
    }
    assert!(reaching > 0, "vectors hold reaching cases");
}
