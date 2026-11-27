#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Byte equality with `apps/daemon/src/subscription.ts`. `vectors/subscription.json` is
//! produced by `vectors/make-subscription-vectors.ts` from the TypeScript `subscribe` over a
//! real `Store`: every store read it asked for (in order, with its result), every message it
//! sent, every live batch it heard, and the progress frame its 250 ms timer sent.
//!
//! The Rust subscription answers the same reads through a scripted [`SubscriptionStore`], in
//! the same order, hears the same batches and fires the same timer. A different read order,
//! cursor, framing, snapshot choice or progress frame fails here.

use std::cell::Cell;

use ace_fanout::encode::EventsMessage;
use ace_fanout::{
    DeliveryEvent, EventRead, Scope, SnapshotTail, SubscribeOptions, Subscription,
    SubscriptionFrame, SubscriptionStore, WHOLE_EVENTS, WireEncoder,
};
use ace_json::{JsString, Value};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/subscription.json");
    let text = std::fs::read_to_string(path).expect("read subscription.json");
    ace_json::parse(&text).expect("parse subscription.json")
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

fn entry_text(entry: &Value, key: &str) -> Option<String> {
    match entry.get(key) {
        Some(Value::String(seen)) => Some(seen.as_str().to_owned()),
        _ => None,
    }
}

fn entry_arg(entry: &Value, index: usize) -> Option<&Value> {
    array(entry, "args").get(index)
}

/// The fixture's reads, served in order. A read the core does not ask for, or asks for in a
/// different order, fails.
struct Scripted {
    reads: Vec<Value>,
    at: Cell<usize>,
}

impl Scripted {
    fn new(case: &Value) -> Scripted {
        let mut reads = array(case, "reads").to_vec();
        // The shell registers for live events before it reads anything.
        let first = reads.first().cloned().expect("at least one read");
        assert_eq!(entry_text(&first, "call").as_deref(), Some("subscribe"));
        reads.remove(0);
        Scripted {
            reads,
            at: Cell::new(0),
        }
    }

    fn take(&self, call: &str) -> Value {
        let at = self.at.get();
        let entry = self.reads.get(at).unwrap_or_else(|| {
            panic!(
                "read {call} was not in the script (all {} reads consumed)",
                self.reads.len()
            )
        });
        assert_eq!(
            entry_text(entry, "call").as_deref(),
            Some(call),
            "read {at} should be {call}"
        );
        self.at.set(at + 1);
        entry.clone()
    }

    fn result(entry: &Value) -> Value {
        entry.get("result").cloned().unwrap_or(Value::Null)
    }

    fn consumed(&self) -> bool {
        self.at.get() == self.reads.len()
    }
}

impl SubscriptionStore for Scripted {
    fn head_seq(&self) -> u64 {
        let entry = self.take("headSeq");
        match Self::result(&entry) {
            Value::Number(seen) => seen.value() as u64,
            _ => panic!("headSeq result"),
        }
    }

    fn replay_safe(&self, after_seq: u64) -> bool {
        let entry = self.take("replaySafe");
        assert_eq!(
            entry_arg(&entry, 0).and_then(|arg| match arg {
                Value::Number(seen) => Some(seen.value() as u64),
                _ => None,
            }),
            Some(after_seq)
        );
        matches!(Self::result(&entry), Value::Bool(true))
    }

    fn get_thread(&self, thread: &str) -> bool {
        let entry = self.take("getThread");
        assert_eq!(
            entry_arg(&entry, 0).and_then(entry_text_value),
            Some(thread.to_owned())
        );
        matches!(Self::result(&entry), Value::Bool(true))
    }

    fn acquire_thread(&self, thread: &str) {
        let entry = self.take("acquireThread");
        assert_eq!(
            entry_arg(&entry, 0).and_then(entry_text_value),
            Some(thread.to_owned())
        );
    }

    fn release_thread(&self, thread: &str) {
        let entry = self.take("releaseThread");
        assert_eq!(
            entry_arg(&entry, 0).and_then(entry_text_value),
            Some(thread.to_owned())
        );
    }

    fn snapshot_thread(&self, thread: &str, tail: Option<SnapshotTail>) -> Value {
        let entry = self.take("snapshotThread");
        assert_eq!(
            entry_arg(&entry, 0).and_then(entry_text_value),
            Some(thread.to_owned())
        );
        match (entry_arg(&entry, 1), tail) {
            (None, None) | (Some(Value::Null), None) => {}
            (Some(Value::String(seen)), Some(tail)) => {
                let recorded = ace_json::parse(seen.as_str()).expect("tail JSON");
                assert_eq!(number(&recorded, "items") as usize, tail.items);
                assert_eq!(number(&recorded, "bytes") as usize, tail.bytes);
            }
            _ => panic!(
                "snapshotThread tail: {:?} vs {tail:?}",
                entry_arg(&entry, 1)
            ),
        }
        match Self::result(&entry) {
            Value::String(seen) => ace_json::parse(seen.as_str()).expect("snapshot view"),
            _ => panic!("snapshotThread result"),
        }
    }

    fn list_threads(&self) -> Value {
        let entry = self.take("listThreads");
        match Self::result(&entry) {
            Value::String(seen) => ace_json::parse(seen.as_str()).expect("thread list view"),
            _ => panic!("listThreads result"),
        }
    }

    fn count_thread_events(
        &self,
        thread: &str,
        after: u64,
        through: u64,
        limit: usize,
    ) -> Option<usize> {
        let entry = self.take("countThreadEvents");
        assert_eq!(
            entry_arg(&entry, 0).and_then(entry_text_value),
            Some(thread.to_owned())
        );
        assert_eq!(entry_arg(&entry, 1).and_then(as_u64), Some(after));
        assert_eq!(entry_arg(&entry, 2).and_then(as_u64), Some(through));
        assert_eq!(entry_arg(&entry, 3).and_then(as_u64), Some(limit as u64));
        match Self::result(&entry) {
            Value::Number(seen) => Some(seen.value() as usize),
            Value::Null => None,
            _ => panic!("countThreadEvents result"),
        }
    }

    fn read_events(
        &self,
        after: u64,
        limit: usize,
        byte_limit: usize,
        _head: u64,
        thread: Option<&str>,
    ) -> EventRead {
        let entry = self.take("readEvents");
        assert_eq!(entry_arg(&entry, 0).and_then(as_u64), Some(after));
        assert_eq!(entry_arg(&entry, 1).and_then(as_u64), Some(limit as u64));
        assert_eq!(
            entry_arg(&entry, 2).and_then(as_u64),
            Some(byte_limit as u64)
        );
        assert_eq!(
            entry_arg(&entry, 3).and_then(entry_text_value),
            thread.map(str::to_owned)
        );
        let events: Vec<DeliveryEvent> = match Self::result(&entry) {
            Value::Array(items) => items
                .iter()
                .map(|event| match event {
                    Value::String(seen) => {
                        DeliveryEvent::parse(seen.as_str()).expect("parse recorded event")
                    }
                    _ => panic!("recorded event is not a string"),
                })
                .collect(),
            _ => panic!("readEvents result is not an array"),
        };
        // The recorded reads stop below both budgets; the fixture never models a byte overflow.
        let encoder = WireEncoder::new();
        let bytes: usize = events
            .iter()
            .map(|event| encoder.event_bytes(event, WHOLE_EVENTS))
            .sum();
        EventRead {
            complete: events.len() < limit && bytes <= byte_limit,
            events,
        }
    }
}

fn entry_text_value(value: &Value) -> Option<String> {
    match value {
        Value::String(seen) => Some(seen.as_str().to_owned()),
        _ => None,
    }
}

fn as_u64(value: &Value) -> Option<u64> {
    match value {
        Value::Number(seen) => Some(seen.value() as u64),
        _ => None,
    }
}

fn scope_of(case: &Value) -> Scope {
    let scope = case.get("scope").expect("scope");
    if text(scope, "kind") == "thread" {
        Scope::Thread(text(scope, "threadId"))
    } else {
        Scope::Threads
    }
}

fn tail_of(case: &Value) -> Option<SnapshotTail> {
    match case.get("tail") {
        None | Some(Value::Null) => None,
        Some(tail) => Some(SnapshotTail {
            items: number(tail, "items") as usize,
            bytes: number(tail, "bytes") as usize,
        }),
    }
}

/// The bytes a subscription frame is sent as: events through the encoder, others as their
/// object's JSON.
fn bytes_of(frame: &SubscriptionFrame) -> String {
    match frame {
        SubscriptionFrame::Events(message) => WireEncoder::new().encode(message, WHOLE_EVENTS),
        other => ace_json::to_string(&other.to_value()),
    }
}

fn expected(list: &[Value]) -> Vec<String> {
    list.iter()
        .map(|frame| match frame {
            Value::String(text) => text.as_str().to_owned(),
            _ => panic!("frame is not a string"),
        })
        .collect()
}

fn events_of(entry: &Value) -> Vec<DeliveryEvent> {
    array(entry, "events")
        .iter()
        .map(|event| match event {
            Value::String(seen) => DeliveryEvent::parse(seen.as_str()).expect("parse event"),
            _ => panic!("live event is not a string"),
        })
        .collect()
}

#[test]
fn the_subscription_sends_the_typescripts_bytes() {
    let vectors = vectors();
    for case in array(&vectors, "cases") {
        let name = text(case, "name");
        let scripted = Scripted::new(case);
        let after = match case.get("afterSeq") {
            None | Some(Value::Null) => None,
            Some(seen) => as_u64(seen),
        };
        let options = SubscribeOptions {
            replay_limit: number(case, "replayLimit") as usize,
            progress_interval_ms: 250,
            paced: matches!(case.get("paced"), Some(Value::Bool(true))),
            tail: tail_of(case),
        };
        let mut subscription =
            Subscription::new(JsString::from("s"), scope_of(case), after, options);
        let mut now = 1_000_000_u64;
        if matches!(case.get("stopBefore"), Some(Value::Bool(true))) {
            subscription.stop(&scripted);
        }
        let frames = subscription
            .start(&scripted, now)
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert_eq!(
            frames.iter().map(bytes_of).collect::<Vec<_>>(),
            expected(array(case, "frames")),
            "{name} / start"
        );
        for live in array(case, "live") {
            now += 1;
            let events = events_of(live);
            let head = number(live, "head") as u64;
            let sent = subscription.hear(events, head, now);
            assert_eq!(
                sent.iter().map(bytes_of).collect::<Vec<_>>(),
                expected(array(live, "frames")),
                "{name} / a live batch"
            );
        }
        if let Some(Value::Array(frames)) = case.get("progress") {
            let sent = subscription.flush_progress();
            let sent: Vec<String> = sent.iter().map(bytes_of).collect();
            assert_eq!(sent, expected(frames), "{name} / progress");
        }
        if matches!(case.get("stopAfter"), Some(Value::Bool(true))) {
            subscription.stop(&scripted);
        }
        assert!(
            scripted.consumed(),
            "{name}: {} reads were not asked for",
            scripted.reads.len() - scripted.at.get()
        );
    }
}

/// A `SubscriptionFrame::Events` message is an `EventsMessage`; the helper exists so the
/// import is meaningful to a reader of this test.
#[allow(dead_code)]
fn _events(message: &EventsMessage) -> usize {
    message.events.len()
}
