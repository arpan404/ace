#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Byte equality with `packages/projection/src/interaction-summary.ts` and
//! `apps/daemon/src/wire-interactions.ts`. `vectors/interactions.json` is produced by
//! `vectors/make-interaction-vectors.ts` from those TypeScript modules, over requests either
//! side of `wholeRequestChars` (64 KiB), an event carrying one, and a thread view holding one.

use ace_json::Value;
use ace_projection::{
    request_chars, sent_summarized, summarize_interaction, wire_event, wire_thread_view,
};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/interactions.json");
    let text = std::fs::read_to_string(path).expect("read interactions.json");
    ace_json::parse(&text).expect("parse interactions.json")
}

fn cases(vectors: &Value) -> &[Value] {
    match vectors.get("cases") {
        Some(Value::Array(cases)) => cases,
        _ => panic!("cases"),
    }
}

fn field<'a>(value: &'a Value, key: &str) -> &'a Value {
    match value.get(key) {
        Some(found) => found,
        None => panic!("{key} is missing"),
    }
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    match value.get(key) {
        Some(Value::String(seen)) => seen.as_str(),
        _ => panic!("{key} is not a string"),
    }
}

fn number(value: &Value, key: &str) -> usize {
    match value.get(key) {
        Some(Value::Number(seen)) => seen.value() as usize,
        _ => panic!("{key} is not a number"),
    }
}

fn boolean(value: &Value, key: &str) -> bool {
    match value.get(key) {
        Some(Value::Bool(seen)) => *seen,
        _ => panic!("{key} is not a boolean"),
    }
}

#[test]
fn interaction_summaries_match_the_typescripts_bytes() {
    let vectors = vectors();
    for case in cases(&vectors) {
        let name = text(case, "name");
        let interaction = field(case, "interaction");
        assert_eq!(
            request_chars(field(interaction, "request")),
            number(case, "requestChars"),
            "{name} / requestChars"
        );
        assert_eq!(
            sent_summarized(interaction),
            boolean(case, "sentSummarized"),
            "{name} / sentSummarized"
        );
        assert_eq!(
            ace_json::to_string(&summarize_interaction(interaction)),
            ace_json::to_string(field(case, "sent")),
            "{name} / summarizeInteraction"
        );
        let event = field(case, "event");
        let wired = wire_event(event).unwrap_or_else(|| event.clone());
        assert_eq!(
            ace_json::to_string(&wired),
            ace_json::to_string(field(case, "wiredEvent")),
            "{name} / wireEvent"
        );
        assert_eq!(
            ace_json::to_string(&wire_thread_view(field(case, "view").clone())),
            ace_json::to_string(field(case, "wiredView")),
            "{name} / wireThreadView"
        );
    }
}
