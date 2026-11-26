// SPDX-License-Identifier: Apache-2.0
//! The server core's statements, one case each: `consumeEvents`' loop body
//! (`server.ts:409`-`:463`), the recovery state (`:385`-`:390`, `:537`-`:560`)
//! and the tenant bound (`:148`-`:156`).

use ace_json::{Value, json};
use std::sync::Arc;

use super::{MAX_TENANTS, ServerCore, SubscribeError};
use crate::session::error::{SecretError, StreamError};
use crate::session::testing::{Call, Fake};

/// One event of the shape `boundaries.ts` admits.
fn event(id: &str, kind: &str, data: Value) -> String {
    format!(
        "data: {}\n\n",
        serialized(json!({ "id": id, "type": kind, "data": data }))
    )
}

fn delta(session: &str, text: &str) -> String {
    event(
        "e1",
        "session.text.delta",
        json!({ "sessionID": session, "text": text }),
    )
}

fn durable(seq: u64) -> String {
    format!(
        "data: {}\n\n",
        serialized(json!({
            "id": "e1",
            "type": "session.text.delta",
            "data": { "sessionID": "a", "text": "x" },
            "durable": { "aggregateID": "agg", "seq": seq },
        }))
    )
}

fn serialized(value: Value) -> String {
    ace_json::to_string(&value)
}

/// What one routed delta looks like as the tenant received it.
fn received(text: &str) -> Call {
    Call::Receive(serialized(json!({
        "id": "e1",
        "type": "session.text.delta",
        "data": { "sessionID": "a", "text": text },
    })))
}

fn core(secrets: &[&str]) -> ServerCore {
    ServerCore::new(secrets.iter().map(|secret| (*secret).to_owned()).collect())
        .expect("valid secrets")
}

#[test]
fn a_chunk_routes_its_events_in_order_and_numbers_them() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    let b = Arc::new(Fake::session("b"));
    server.subscribe(a.clone()).expect("first tenant");
    server.subscribe(b.clone()).expect("second tenant");

    let chunk = format!("{}{}", delta("a", "one"), delta("a", "two"));
    let outcome = server.chunk(chunk.as_bytes());
    assert_eq!(outcome.failed, None);
    assert!(!outcome.established);
    assert!(!outcome.recover);
    assert_eq!(server.watermark(), 2);
    assert_eq!(a.calls(), vec![received("one"), received("two")]);
    assert!(b.calls().is_empty());
}

#[test]
fn server_connected_establishes_the_stream_without_routing() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    let outcome = server.chunk(event("c", "server.connected", json!({})).as_bytes());
    assert!(outcome.established);
    assert_eq!(outcome.failed, None);
    assert_eq!(server.watermark(), 1, "connected still takes a watermark");
    assert!(a.calls().is_empty());
}

#[test]
fn a_durable_gap_begins_recovery_and_buffers_what_follows() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");

    let first = server.chunk(durable(5).as_bytes());
    assert!(!first.recover);
    assert!(!server.recovering());

    let second = server.chunk(durable(7).as_bytes());
    assert!(second.recover, "the gap asks for a recovery run");
    assert!(server.recovering());
    assert_eq!(server.watermark(), 2);
    let gap_event = serialized(json!({
        "id": "e1",
        "type": "session.text.delta",
        "data": { "sessionID": "a", "text": "x" },
        "durable": { "aggregateID": "agg", "seq": 7 },
    }));
    assert_eq!(
        a.calls(),
        vec![
            Call::Receive(serialized(json!({
                "id": "e1",
                "type": "session.text.delta",
                "data": { "sessionID": "a", "text": "x" },
                "durable": { "aggregateID": "agg", "seq": 5 },
            }))),
            Call::Disconnected(1),
            Call::Buffered(gap_event, 2),
        ]
    );
    let notes = a.notes();
    let (channel, text) = notes.last().expect("the buffered note");
    assert_eq!(channel, "recovery.buffered");
    let buffered: Value = ace_json::parse(text).expect("note is JSON");
    assert_eq!(
        buffered,
        json!({ "id": "e1", "type": "session.text.delta", "watermark": 2 })
    );
}

#[test]
fn replay_replays_the_buffer_finalizes_and_recovers() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    server.begin_recovery(0);
    server.chunk(delta("a", "one").as_bytes());
    server.chunk(delta("a", "two").as_bytes());
    assert_eq!(server.watermark(), 2);

    assert!(server.replay().expect("replay"));
    assert!(!server.recovering());
    assert_eq!(
        a.calls(),
        vec![
            Call::Disconnected(0),
            Call::Buffered(
                serialized(json!({
                    "id": "e1",
                    "type": "session.text.delta",
                    "data": { "sessionID": "a", "text": "one" },
                })),
                1
            ),
            Call::Buffered(
                serialized(json!({
                    "id": "e1",
                    "type": "session.text.delta",
                    "data": { "sessionID": "a", "text": "two" },
                })),
                2
            ),
            Call::Reconcile(
                serialized(json!({
                    "id": "e1",
                    "type": "session.text.delta",
                    "data": { "sessionID": "a", "text": "one" },
                })),
                1
            ),
            Call::Reconcile(
                serialized(json!({
                    "id": "e1",
                    "type": "session.text.delta",
                    "data": { "sessionID": "a", "text": "two" },
                })),
                2
            ),
            Call::Finalize,
            Call::Recovered,
        ]
    );
    // The buffer is empty, so a second pass replays nothing.
    assert!(server.replay().expect("replay"));
    assert_eq!(a.calls().last(), Some(&Call::Recovered));
}

#[test]
fn a_buffer_overflow_drops_it_marks_it_stale_and_restarts() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    server.begin_recovery(0);
    let mut chunk = String::new();
    for index in 0..=4096 {
        chunk.push_str(&delta("a", &index.to_string()));
    }
    let outcome = server.chunk(chunk.as_bytes());
    assert!(!outcome.recover);
    assert!(server.stale());
    assert!(
        !server.replay().expect("replay"),
        "a stale pass must restart"
    );
    let notes = a.notes();
    let restarted = notes
        .iter()
        .find(|(channel, _)| channel == "recovery.restarted")
        .expect("the overflow is noted");
    assert_eq!(
        ace_json::parse(&restarted.1).expect("note is JSON"),
        json!({ "watermark": 4097 })
    );
}

#[test]
fn a_restart_replays_from_the_current_watermark_with_an_empty_buffer() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    server.begin_recovery(0);
    server.chunk(delta("a", "one").as_bytes());
    server.restart_recovery();
    assert_eq!(
        server.watermark(),
        1,
        "a restart takes the current watermark"
    );
    assert_eq!(
        a.calls(),
        vec![
            Call::Disconnected(0),
            Call::Buffered(
                serialized(json!({
                    "id": "e1",
                    "type": "session.text.delta",
                    "data": { "sessionID": "a", "text": "one" },
                })),
                1,
            ),
            Call::Disconnected(1),
        ]
    );
    assert!(server.replay().expect("replay"));
    assert_eq!(
        a.calls().last(),
        Some(&Call::Recovered),
        "nothing was buffered to replay"
    );
}

#[test]
fn the_tenant_bound_refuses_the_129th_session() {
    let mut server = core(&[]);
    for _ in 0..MAX_TENANTS {
        server
            .subscribe(Arc::new(Fake::all()))
            .expect("under the bound");
    }
    assert_eq!(server.subscribe(Arc::new(Fake::all())), Err(SubscribeError));
    assert_eq!(SubscribeError.to_string(), "OpenCode session limit reached");
    server.unsubscribe(0);
    server.subscribe(Arc::new(Fake::all())).expect("room again");
}

#[test]
fn an_unsubscribed_tenant_receives_nothing_more() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::all());
    let id = server.subscribe(a.clone()).expect("tenant");
    server.chunk(delta("a", "one").as_bytes());
    server.unsubscribe(id);
    server.chunk(delta("a", "two").as_bytes());
    assert_eq!(a.calls().len(), 1);
}

#[test]
fn the_declared_secret_bound_counts_duplicates_and_excludes_the_authorization() {
    let declared: Vec<String> = (0..32).map(|index| format!("sk-{index}")).collect();
    let mut server = ServerCore::new(declared.clone()).expect("32 declared secrets");
    server.add_authorization("auth-proof-1".to_owned());
    assert_eq!(
        server.secrets().len(),
        33,
        "the authorization is redacted too"
    );

    // A 33rd entry is refused even when it duplicates one already declared.
    assert_eq!(
        server.add_secret("sk-0".to_owned()),
        Err(SecretError::TooMany)
    );
    assert_eq!(server.secrets().len(), 33);
    assert!(ServerCore::new(vec!["s".to_owned(); 33]).is_err());
    // The rule bounds count code points: 4096 emoji pass, 4097 do not.
    assert!(ServerCore::new(vec!["😀".repeat(4096)]).is_ok());
    assert_eq!(
        ServerCore::new(vec!["😀".repeat(4097)]).err(),
        Some(SecretError::Length)
    );
    assert_eq!(
        ServerCore::new(vec![String::new()]).err(),
        Some(SecretError::Length)
    );

    // The authorization is redacted from an event although it was never
    // declared, and the declared list keeps its 32 entries.
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    server.chunk(
        event(
            "e1",
            "session.text.delta",
            json!({ "sessionID": "a", "text": "auth-proof-1" }),
        )
        .as_bytes(),
    );
    let Some(Call::Receive(text)) = a.calls().first().cloned() else {
        panic!("the tenant received one event");
    };
    assert!(!text.contains("auth-proof-1"), "{text}");
}

#[test]
fn events_are_sanitized_before_routing_and_the_tenant_never_sees_a_secret() {
    let mut server = core(&["sk-live-1"]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    server.chunk(
        event(
            "e1",
            "session.text.delta",
            json!({ "sessionID": "a", "text": "Bearer sk-live-1 and sk-live-1" }),
        )
        .as_bytes(),
    );
    let Some(Call::Receive(text)) = a.calls().first().cloned() else {
        panic!("the tenant received one event");
    };
    assert!(!text.contains("sk-live-1"), "{text}");
    assert!(text.contains("[redacted]"), "{text}");
}

#[test]
fn an_envelope_the_check_refuses_stops_the_chunk_after_earlier_events() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    let bad = "data: {\"type\":\"t\",\"data\":{}}\n\n";
    let outcome = server.chunk(format!("{}{bad}", delta("a", "one")).as_bytes());
    assert_eq!(outcome.failed, Some(StreamError::Envelope("id")));
    assert!(!outcome.established);
    assert_eq!(a.calls().len(), 1);
    // The stream is dead until the next connection starts it fresh.
    let next = server.chunk(delta("a", "two").as_bytes());
    assert_eq!(next.failed, None);
    assert_eq!(a.calls().len(), 2);
}

#[test]
fn a_malformed_block_fails_the_stream_after_earlier_events() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    let outcome = server.chunk(format!("{}data: nope\n\n", delta("a", "one")).as_bytes());
    assert_eq!(
        outcome.failed.map(|error| error.code()),
        Some(Some("MalformedResponse"))
    );
    assert_eq!(a.calls().len(), 1);
}

#[test]
fn end_flushes_the_last_block_and_starts_a_fresh_stream() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    let last = delta("a", "one");
    server.chunk(last.trim_end_matches('\n').as_bytes());
    let outcome = server.end();
    assert_eq!(outcome.failed, None);
    assert_eq!(a.calls().len(), 1);
}

#[test]
fn a_connected_stream_that_fails_is_marked_established() {
    let mut server = core(&[]);
    server.subscribe(Arc::new(Fake::all())).expect("tenant");
    server.chunk(event("c", "server.connected", json!({})).as_bytes());
    let outcome = server.chunk(b"data: nope\n\n");
    assert!(outcome.established, "the facade reconnects, never fails");
    assert_eq!(
        outcome.failed.map(|error| error.code()),
        Some(Some("MalformedResponse"))
    );
}

mod activity;
mod recovery;
