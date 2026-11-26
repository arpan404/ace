#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Ports `packages/projection/src/raw-on-demand.test.ts` by case name. The TypeScript cases:
//!
//! - "a client that asks gets shown-only raw payloads left out and marked"
//! - "raw a client reads for what a step says stays: notices and ace's own calls"
//! - "a legacy provider notice keeps the raw that says what it reports"
//! - "a client that doesn't ask gets every item exactly as stored"
//!
//! The message and call shapes are the ones that test builds with `Item.parse`; only the
//! fields `rawShownOnly` reads are present, as in the stored rows it guards.

use ace_fanout::encode::{EventsMessage, WHOLE_EVENTS, WireEncoder};
use ace_fanout::{DeliveryEvent, ProviderNotice, omit_raw, provider_notice};
use ace_json::{JsString, Value};

fn parse(text: &str) -> Value {
    ace_json::parse(text).expect("parse JSON")
}

fn item(text: &str) -> Value {
    parse(text)
}

fn boolean(value: &Value, key: &str) -> bool {
    matches!(value.get(key), Some(Value::Bool(true)))
}

fn strings(value: &Value, key: &str) -> usize {
    match value.get(key) {
        Some(Value::Array(items)) => items.len(),
        _ => 0,
    }
}

const FRAME: &str = r#"{"type":"message_stop","data":{"blob":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}}"#;

fn reply() -> Value {
    item(&format!(
        r#"{{"agentId":"a","createdAt":1,"id":"reply","type":"message","role":"assistant","parts":[{{"type":"text","text":"hi"}}],"raw":[{FRAME}]}}"#
    ))
}

fn shell() -> Value {
    item(&format!(
        r#"{{"agentId":"a","createdAt":1,"id":"shell","type":"tool_call","call":{{"id":"shell","agentId":"a","kind":"shell","title":"ls","status":"succeeded","detail":{{"kind":"shell","command":"ls"}},"startedAt":1,"raw":[{FRAME}]}},"raw":[]}}"#
    ))
}

fn ace_call() -> Value {
    item(&format!(
        r#"{{"agentId":"a","createdAt":1,"id":"ace","type":"tool_call","call":{{"id":"ace","agentId":"a","kind":"mcp","title":"thread_start","status":"succeeded","detail":{{"kind":"mcp","server":"ace","tool":"thread_start"}},"startedAt":1,"raw":[{FRAME}]}},"raw":[]}}"#
    ))
}

fn refusal() -> Value {
    item(
        r#"{"agentId":"a","createdAt":1,"id":"refusal","type":"notice","level":"error","text":"refused","raw":[{"type":"ace.agent_control.failed","data":{}}]}"#,
    )
}

/// "a client that asks gets shown-only raw payloads left out and marked".
#[test]
fn shown_only_raw_payloads_are_left_out_and_marked() {
    let omitted = omit_raw(&reply()).expect("reply changes");
    assert_eq!(strings(&omitted, "raw"), 0);
    assert!(boolean(&omitted, "rawOmitted"));

    let omitted = omit_raw(&shell()).expect("shell changes");
    assert!(boolean(&omitted, "rawOmitted"));
    let Some(Value::Object(call)) = omitted.get("call") else {
        panic!("call");
    };
    assert_eq!(strings(&Value::Object(call.clone()), "raw"), 0);
}

/// "raw a client reads for what a step says stays: notices and ace's own calls".
#[test]
fn raw_a_client_reads_stays() {
    assert!(omit_raw(&ace_call()).is_none());
    assert!(omit_raw(&refusal()).is_none());
}

/// "a legacy provider notice keeps the raw that says what it reports".
#[test]
fn a_legacy_provider_notice_keeps_the_raw_that_says_what_it_reports() {
    let notice = item(
        r#"{"agentId":"a","createdAt":1,"id":"notice","type":"message","role":"user","synthetic":true,"parts":[{"type":"text","text":"Command finished."}],"raw":[{"type":"projected.message","data":{"metadata":{"source":"shell"}}}]}"#,
    );
    assert_eq!(
        provider_notice(&notice),
        Some(ProviderNotice::BackgroundCompletion)
    );
    // Its raw is what says it is a background completion, so it is not omitted.
    assert!(omit_raw(&notice).is_none());
    assert_eq!(
        provider_notice(&notice),
        Some(ProviderNotice::BackgroundCompletion)
    );
}

/// "a client that doesn't ask gets every item exactly as stored".
#[test]
fn a_client_that_does_not_ask_gets_every_item_exactly_as_stored() {
    let encoder = WireEncoder::new();
    for stored in [reply(), shell(), ace_call(), refusal()] {
        let event = DeliveryEvent::from_value(parse(&format!(
            r#"{{"id":"e","seq":1,"at":1,"threadId":"t","payload":{{"type":"item.created","item":{}}}}}"#,
            ace_json::to_string(&stored)
        )));
        let sent = EventsMessage {
            subscription_id: JsString::from("s"),
            after_seq: 0.0,
            through_seq: 1.0,
            early: false,
            events: vec![event.clone()],
        };
        assert_eq!(
            encoder.encode(&sent, WHOLE_EVENTS),
            format!(
                "{{\"type\":\"events\",\"subscriptionId\":\"s\",\"afterSeq\":0,\"throughSeq\":1,\"events\":[{}]}}",
                ace_json::to_string(event.value())
            )
        );
    }
}
