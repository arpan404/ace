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

/// One activity note, as the tenant's log records it.
fn notes(count: usize) -> Vec<String> {
    vec!["note:transport.activity".to_owned(); count]
}

fn receive(json: &str) -> Vec<String> {
    vec![format!("receive:{json}")]
}

/// Runs the chunks through a tracing tenant and returns its interleaved log.
fn trace_of(chunks: &[&[u8]]) -> Vec<String> {
    let mut server = core(&[]);
    let tenant = Arc::new(Fake::tracing());
    server.subscribe(tenant.clone()).expect("tenant");
    for chunk in chunks {
        let outcome = server.chunk(chunk);
        assert_eq!(outcome.failed, None);
    }
    tenant.trace()
}

/// An envelope with five strings (`id`, `e`, `type`, `t`, `data`) and no
/// session, so no tenant has to own it.
const SMALL: &[u8] = b"data: {\"id\":\"e\",\"type\":\"t\",\"data\":{}}\n\n";

/// A delta envelope: nine strings, so nineteen pieces.
fn delta_text(session: &str, text: &str) -> String {
    format!(
        "data: {{\"id\":\"e1\",\"type\":\"session.text.delta\",\"data\":{{\"sessionID\":\"{session}\",\"text\":\"{text}\"}}}}\n\n"
    )
}

/// (the rule, its chunks, the expected trace as segments).
type Row<'a> = (&'a str, Vec<&'a [u8]>, Vec<Vec<String>>);

#[test]
fn activity_is_one_note_per_elided_piece_in_read_order() {
    // The elider emits at every quote boundary, so the SDK's reads are finer
    // than the body chunks: each string is an opening piece (the outside text
    // plus the quote) and a content piece, and a tail piece closes the block.
    // Every read is one activity note, before that piece's events.
    let small = String::from_utf8(SMALL.to_vec()).expect("ASCII");
    let small_json = r#"{"id":"e","type":"t","data":{}}"#;
    let one = delta_text("a", "one");
    let two = delta_text("a", "two");
    let both_small = small.clone() + &small;
    let both = one.clone() + &two;
    let first_json =
        r#"{"id":"e1","type":"session.text.delta","data":{"sessionID":"a","text":"one"}}"#;
    let second_json =
        r#"{"id":"e1","type":"session.text.delta","data":{"sessionID":"a","text":"two"}}"#;

    let table: &[Row<'_>] = &[
        (
            "five strings are eleven pieces",
            vec![SMALL],
            vec![notes(11), receive(small_json)],
        ),
        (
            "two events in one chunk: the second starts after the first's tail",
            vec![both_small.as_bytes()],
            // The first event's tail and the second's first string are one
            // outside piece, so the second run has ten notes.
            vec![
                notes(11),
                receive(small_json),
                notes(10),
                receive(small_json),
            ],
        ),
        (
            "a chunk that ends inside a string makes no activity of its own",
            vec![
                b"data: {\"i",
                b"d",
                b"\":\"e\",\"type\":\"t\",\"data\":{}}\n\n",
            ],
            vec![notes(11), receive(small_json)],
        ),
        (
            "each delta is nineteen pieces",
            vec![one.as_bytes()],
            vec![notes(19), receive(first_json)],
        ),
        (
            "two deltas in one chunk",
            vec![both.as_bytes()],
            vec![
                notes(19),
                receive(first_json),
                // The first delta's tail and the second's first string are one
                // outside piece.
                notes(18),
                receive(second_json),
            ],
        ),
    ];
    for (rule, chunks, expected) in table {
        assert_eq!(trace_of(chunks), expected.concat(), "{rule}");
    }
}

#[test]
fn the_connections_start_and_the_end_flush_count_as_activity() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::tracing());
    server.subscribe(a.clone()).expect("tenant");
    // `activity()` before the first read (`server.ts:407`).
    server.activity();
    assert_eq!(a.trace(), notes(1));

    // The elider's flush is a read like any other, so it counts as activity,
    // even when the block it completes is malformed.
    let mut server = core(&[]);
    let b = Arc::new(Fake::tracing());
    server.subscribe(b.clone()).expect("tenant");
    server.chunk(b"data: \"ab");
    assert_eq!(server.end().failed, Some(StreamError::MalformedResponse));
    assert_eq!(b.trace(), notes(2));
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

    assert!(server.replay());
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
    assert!(server.replay());
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
    assert!(!server.replay(), "a stale pass must restart");
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
    assert!(server.replay());
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
    assert_eq!(outcome.failed, Some(StreamError::MalformedResponse));
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
    assert_eq!(outcome.failed, Some(StreamError::MalformedResponse));
}
