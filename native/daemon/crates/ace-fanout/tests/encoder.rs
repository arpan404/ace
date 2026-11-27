#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Ports `apps/daemon/src/wire-encoder.test.ts` by case name. The TypeScript cases:
//!
//! - "fan-out preserves per-subscription cursors and escaped Unicode payloads"
//! - "an events frame's measured size is its encoded size"
//! - "an event whose payload is replaced after it was sent is sent with the new payload"
//!
//! and the short-delta cases of `packages/projection/src/raw-on-demand.test.ts`:
//!
//! - "a short-deltas client rebuilds the same deltas, text and order as a whole one"
//! - "a short delta is far smaller than the whole event"

use ace_fanout::encode::{EventShape, EventsMessage, WHOLE_EVENTS, WireEncoder};
use ace_fanout::{DeliveryEvent, short_delta_json};
use ace_json::{JsString, Value};

fn delta(seq: u64, append: &str, first: Option<u64>) -> DeliveryEvent {
    let mut event = String::from("{");
    event.push_str(&format!("\"id\":\"stored-{seq}\",\"seq\":{seq},"));
    if let Some(first) = first {
        event.push_str(&format!("\"firstSeq\":{first},"));
    }
    event.push_str(&format!(
        "\"at\":{},\"threadId\":\"thread-1\",\"payload\":{{\"type\":\"item.delta\",\"itemId\":\"reply\",\"agentId\":\"a\",\"field\":\"text\",\"append\":",
        1_731_600_000_000_u64 + seq
    ));
    let mut quoted = String::new();
    ace_json::write_js_string(&mut quoted, &JsString::from(append));
    event.push_str(&quoted);
    event.push_str("}}");
    DeliveryEvent::parse(&event).expect("parse delta")
}

fn titled(seq: u64, title: &str) -> DeliveryEvent {
    let mut quoted = String::new();
    ace_json::write_js_string(&mut quoted, &JsString::from(title));
    DeliveryEvent::parse(&format!(
        "{{\"id\":\"e{seq}\",\"seq\":{seq},\"at\":1,\"threadId\":\"t\",\"payload\":{{\"type\":\"thread.updated\",\"title\":{quoted}}}}}"
    ))
    .expect("parse event")
}

fn message(subscription: &str, after: f64, events: Vec<DeliveryEvent>) -> EventsMessage {
    let through = events.last().and_then(DeliveryEvent::seq).unwrap_or(0.0);
    EventsMessage {
        subscription_id: JsString::from(subscription),
        after_seq: after,
        through_seq: through,
        early: false,
        events,
    }
}

/// "fan-out preserves per-subscription cursors and escaped Unicode payloads".
#[test]
fn each_subscription_id_keeps_its_cursors_and_unicode_payloads_round_trip() {
    let encoder = WireEncoder::new();
    let event = titled(4, "quotes \" \\ \n 😀");
    for subscription in ["a", "quoted\"\n", "b"] {
        let sent = message(subscription, 2.0, vec![event.clone()]);
        let encoded = encoder.encode(&sent, WHOLE_EVENTS);
        let parsed = ace_json::parse(&encoded).expect("parse encoded frame");
        assert_eq!(
            parsed.get("type"),
            Some(&Value::String(JsString::from("events")))
        );
        assert_eq!(
            parsed.get("subscriptionId"),
            Some(&Value::String(JsString::from(subscription)))
        );
        let Some(Value::Number(after)) = parsed.get("afterSeq") else {
            panic!("afterSeq");
        };
        assert_eq!(after.value(), 2.0);
        let Some(Value::Array(events)) = parsed.get("events") else {
            panic!("events");
        };
        assert_eq!(events.len(), 1);
        assert_eq!(events.first(), Some(event.value()));
    }
}

/// "an events frame's measured size is its encoded size".
#[test]
fn an_events_frames_measured_size_is_its_encoded_size() {
    let encoder = WireEncoder::new();
    for events in [
        Vec::new(),
        vec![titled(1, "plain")],
        vec![
            titled(1, "é \" 😀 \n"),
            titled(2, "\u{fffd}"),
            titled(3, "z"),
        ],
    ] {
        let sent = message("sub \"é\"", 0.0, events);
        assert_eq!(
            encoder.encoded_bytes(&sent, WHOLE_EVENTS),
            encoder.encode(&sent, WHOLE_EVENTS).len()
        );
    }
}

/// "an event whose payload is replaced after it was sent is sent with the new payload".
///
/// The TypeScript mutates the event object; here a replaced payload is a new event, so the
/// second one's encoding cannot reuse the first's.
#[test]
fn a_replaced_payload_is_sent_with_the_new_payload() {
    let encoder = WireEncoder::new();
    let before = titled(1, "inline");
    let sent = message("s", 0.0, vec![before.clone()]);
    encoder.encode(&sent, WHOLE_EVENTS);

    let after = titled(1, "capped");
    let encoded = encoder.encode(&message("s", 0.0, vec![after.clone()]), WHOLE_EVENTS);
    let parsed = ace_json::parse(&encoded).expect("parse encoded frame");
    let Some(Value::Array(events)) = parsed.get("events") else {
        panic!("events");
    };
    assert_eq!(events.first().and_then(|event| event.get("payload")), {
        after.value().get("payload")
    });
    assert_eq!(
        encoder.event_bytes(&after, WHOLE_EVENTS),
        ace_json::to_string(after.value()).len()
    );
}

/// "a short-deltas client rebuilds the same deltas, text and order as a whole one".
#[test]
fn short_deltas_keep_the_same_text_and_order() {
    let encoder = WireEncoder::new();
    let events = vec![
        delta(5, "quote \" and \n 😀", None),
        delta(8, "tail", Some(6)),
    ];
    let encoded = encoder.encode(
        &message("s", 4.0, events.clone()),
        EventShape {
            raw_on_demand: false,
            short_deltas: true,
        },
    );
    // The thread is named once, beside `subscriptionId`, not on each event.
    assert_eq!(encoded.matches("\"threadId\":").count(), 1);
    assert!(encoded.contains("\"threadId\":\"thread-1\",\"events\":["));
    let parsed = ace_json::parse(&encoded).expect("parse encoded frame");
    let Some(Value::Array(short)) = parsed.get("events") else {
        panic!("events");
    };
    assert_eq!(short.len(), 2);
    assert_eq!(
        short.first(),
        short_delta_json(&events[0])
            .map(|text| ace_json::parse(&text).expect("short delta"))
            .as_ref()
    );
    let appends: String = short
        .iter()
        .map(|event| {
            let Some(Value::Array(parts)) = event.get("d") else {
                panic!("d");
            };
            let Some(Value::String(append)) = parts.get(3) else {
                panic!("append");
            };
            append.as_str().to_owned()
        })
        .collect();
    assert_eq!(appends, "quote \" and \n 😀tail");
}

/// "a short delta is far smaller than the whole event".
#[test]
fn a_short_delta_is_far_smaller_than_the_whole_event() {
    let event = delta(5, &"x".repeat(150), None);
    let short = short_delta_json(&event).expect("short delta");
    assert!(short.len() < ace_json::to_string(event.value()).len() - 40);
}

/// A message of deltas from two threads names no thread, so every delta goes whole and a
/// frame `split` cuts is never larger than it was weighed.
#[test]
fn deltas_of_two_threads_all_go_whole() {
    let encoder = WireEncoder::new();
    let mut other = String::new();
    ace_json::write_js_string(&mut other, &JsString::from("thread-2"));
    let second = DeliveryEvent::parse(&format!(
        "{{\"id\":\"stored-9\",\"seq\":9,\"at\":1731600000009,\"threadId\":{other},\"payload\":{{\"type\":\"item.delta\",\"itemId\":\"reply\",\"agentId\":\"a\",\"field\":\"text\",\"append\":\"other\"}}}}"
    ))
    .expect("parse delta");
    let shape = EventShape {
        raw_on_demand: false,
        short_deltas: true,
    };
    let sent = message("s", 4.0, vec![delta(5, "one", None), second]);
    let encoded = encoder.encode(&sent, shape);
    assert!(!encoded.contains("\"d\":"));
    assert!(encoded.starts_with(
        "{\"type\":\"events\",\"subscriptionId\":\"s\",\"afterSeq\":4,\"throughSeq\":9,\"events\":[{\"seq\":"
    ));
    // Each event travels whole, so the frame holds both payloads in full.
    assert!(encoded.contains("\"payload\":{\"type\":\"item.delta\""));
    assert_eq!(
        encoder.encoded_bytes(&sent, shape),
        encoder.encode(&sent, shape).len()
    );
}
