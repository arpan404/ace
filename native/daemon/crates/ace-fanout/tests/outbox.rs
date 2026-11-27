#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Behavioral tests for Outbox backpressure, delta coalescing, large-frame streaming,
//! FrameHolder packing, compression allowlist, SocketInput backpressure, liveness and SocketCloser.

use ace_fanout::{
    COALESCE_MAX_UTF16_UNITS, ClientAgent, CloseAction, ClosePeer, DAEMON_CLOSE_GRACE_MS,
    DeliveryEvent, EVENT_FRAME_BYTES, EventShape, EventsMessage, FRAME_HOLD_MS, HELD_FRAME_BYTES,
    INPUT_BACKPRESSURE_CLOSE_CODE, InputDecision, Outbox, OutboxSocket, PressureOptions,
    RESYNC_CLOSE_CODE, ReadyState, SLOW_BACKLOG_BYTES, SocketCloser, SocketInput,
    SocketInputLimits, VERY_SLOW_BACKLOG_BYTES, WireEncoder, client_agent, close_record,
    coalesce_events, frame_hold_for, is_ping, may_compress,
};
use ace_json::{JsString, Value};

#[derive(Default)]
struct FakeSocket {
    state: Option<ReadyState>,
    buffered: usize,
    /// If true, every `send` adds `text.len()` to `buffered`.
    accumulate_buffered: bool,
    sent: Vec<(String, bool)>,
    closed: Option<(u16, String)>,
}

impl FakeSocket {
    fn open() -> Self {
        Self {
            state: Some(ReadyState::Open),
            ..Default::default()
        }
    }
}

impl OutboxSocket for FakeSocket {
    fn ready_state(&self) -> ReadyState {
        self.state.unwrap_or(ReadyState::Open)
    }

    fn buffered_amount(&self) -> usize {
        self.buffered
    }

    fn send(&mut self, text: String, compress: bool) {
        if self.accumulate_buffered {
            self.buffered += text.len();
        }
        self.sent.push((text, compress));
    }

    fn close(&mut self, code: u16, reason: &str) {
        self.state = Some(ReadyState::Closed);
        self.closed = Some((code, reason.to_owned()));
    }
}

fn delta_event(seq: u64, thread: &str, item: &str, append: &str) -> DeliveryEvent {
    let payload = format!(
        r#"{{"seq":{seq},"id":"e{seq}","at":1,"threadId":"{thread}","payload":{{"type":"item.delta","itemId":"{item}","agentId":"a1","field":"text","append":{}}}}}"#,
        ace_json::to_string(&Value::String(JsString::from(append)))
    );
    DeliveryEvent::parse(&payload).unwrap()
}

fn non_delta_event(seq: u64, thread: &str) -> DeliveryEvent {
    DeliveryEvent::parse(&format!(
        r#"{{"seq":{seq},"id":"e{seq}","at":1,"threadId":"{thread}","payload":{{"type":"thread.updated","title":"t"}}}}"#
    ))
    .unwrap()
}

#[test]
fn contiguous_item_deltas_coalesce_within_the_utf16_limit_and_preserve_first_seq() {
    let e1 = delta_event(10, "t1", "i1", "hello ");
    let e2 = delta_event(11, "t1", "i1", "world");
    let e3 = delta_event(12, "t1", "i1", "!");
    let coalesced = coalesce_events(&[e1, e2, e3]);
    assert_eq!(coalesced.len(), 1);
    assert_eq!(coalesced[0].first_seq(), Some(10.0));
    assert_eq!(coalesced[0].seq(), Some(12.0));
    let append = coalesced[0]
        .value()
        .get("payload")
        .and_then(|p| p.get("append"))
        .and_then(Value::as_str)
        .unwrap();
    assert_eq!(append, "hello world!");

    // Surrogate pair (2 UTF-16 units) at the 65,536-unit boundary prevents over-limit merge.
    let big = "a".repeat(COALESCE_MAX_UTF16_UNITS - 1);
    let d1 = delta_event(20, "t1", "i1", &big);
    let d2 = delta_event(21, "t1", "i1", "😀");
    let split = coalesce_events(&[d1, d2]);
    assert_eq!(split.len(), 2);

    // Non-contiguous seq or different item does not coalesce.
    let g1 = delta_event(30, "t1", "i1", "x");
    let g2 = delta_event(32, "t1", "i1", "y");
    let g3 = delta_event(33, "t1", "i2", "z");
    assert_eq!(coalesce_events(&[g1, g2, g3]).len(), 3);
}

#[test]
fn congested_outbox_coalesces_queued_deltas_and_flushes_in_order_once_drained() {
    let mut socket = FakeSocket::open();
    socket.buffered = 512; // above soft_limit
    let opts = PressureOptions {
        soft_limit: 256,
        hard_limit: 4096,
        max_queued_bytes: 64 * 1024,
        hard_timeout_ms: 5_000,
    };
    let mut outbox = Outbox::new(opts, WireEncoder::new());
    let msg1 = EventsMessage {
        subscription_id: JsString::from("sub"),
        after_seq: 0.0,
        through_seq: 1.0,
        early: false,
        events: vec![delta_event(1, "t1", "i1", "foo")],
    };
    let msg2 = EventsMessage {
        subscription_id: JsString::from("sub"),
        after_seq: 1.0,
        through_seq: 2.0,
        early: false,
        events: vec![delta_event(2, "t1", "i1", "bar")],
    };
    outbox.send_events(&msg1, 100, &mut socket);
    outbox.send_events(&msg2, 101, &mut socket);
    assert!(socket.sent.is_empty(), "paused above soft_limit");
    assert_eq!(
        outbox.pending_len(),
        1,
        "contiguous batches coalesced into one"
    );

    // Drain transport below soft_limit and flush.
    socket.buffered = 0;
    outbox.tick(110, &mut socket);
    assert_eq!(socket.sent.len(), 1);
    let (wire, compress) = &socket.sent[0];
    assert!(*compress);
    let parsed = ace_json::parse(wire).unwrap();
    assert_eq!(parsed.get("afterSeq").and_then(Value::as_f64), Some(0.0));
    assert_eq!(parsed.get("throughSeq").and_then(Value::as_f64), Some(2.0));
    let events = parsed.get("events").unwrap();
    let Value::Array(items) = events else {
        panic!("events array");
    };
    assert_eq!(items.len(), 1);
    assert_eq!(
        items[0]
            .get("payload")
            .and_then(|p| p.get("append"))
            .and_then(Value::as_str),
        Some("foobar")
    );
}

#[test]
fn slow_consumer_above_hard_limit_or_over_max_queued_bytes_resyncs_with_4009() {
    let opts = PressureOptions {
        soft_limit: 128,
        hard_limit: 512,
        max_queued_bytes: 2048,
        hard_timeout_ms: 5_000,
    };
    let mut socket = FakeSocket::open();
    socket.buffered = 600;
    let mut outbox = Outbox::new(opts, WireEncoder::new());
    outbox.tick(1_000, &mut socket);
    assert!(socket.closed.is_none());
    // Dropping below hard_limit resets the sustained pressure timer.
    socket.buffered = 400;
    outbox.tick(5_500, &mut socket);
    assert!(socket.closed.is_none());
    // Going back above hard_limit starts a fresh 5_000ms window.
    socket.buffered = 600;
    outbox.tick(6_000, &mut socket);
    outbox.tick(10_999, &mut socket);
    assert!(socket.closed.is_none());
    outbox.tick(11_000, &mut socket);
    assert_eq!(
        socket.closed,
        Some((RESYNC_CLOSE_CODE, "Reconnect with afterSeq".to_owned()))
    );

    // Exceeding max_queued_bytes resyncs immediately.
    let mut socket = FakeSocket::open();
    socket.buffered = 1_900;
    let mut outbox = Outbox::new(opts, WireEncoder::new());
    let big =
        ace_json::parse(&format!(r#"{{"type":"pong","pad":"{}"}}"#, "x".repeat(300))).unwrap();
    outbox.send_value(&big, 1_000, &mut socket);
    assert_eq!(
        socket.closed,
        Some((RESYNC_CLOSE_CODE, "Reconnect with afterSeq".to_owned()))
    );
}

#[test]
fn oversized_snapshot_streams_in_ordered_parts_without_filling_socket_past_soft_limit() {
    let mut socket = FakeSocket::open();
    socket.accumulate_buffered = true;
    let opts = PressureOptions {
        soft_limit: 256 * 1024,
        hard_limit: 4 * 1024 * 1024,
        max_queued_bytes: 4 * 1024 * 1024,
        hard_timeout_ms: 5_000,
    };
    let mut outbox = Outbox::new(opts, WireEncoder::new());
    let big_body = "x".repeat(EVENT_FRAME_BYTES + 10_000);
    let snapshot = ace_json::parse(&format!(
        r#"{{"type":"snapshot","subscriptionId":"s1","seq":42,"view":{{"body":"{big_body}"}}}}"#
    ))
    .unwrap();
    let expected_full = ace_json::to_string(&snapshot);

    outbox.send_value(&snapshot, 0, &mut socket);
    // Socket hit soft_limit after a couple of 128 KiB chunks and paused before emitting all parts.
    assert!(socket.sent.len() < 8);
    assert!(outbox.pending_len() == 1);

    // Drain incrementally until stream finishes.
    while outbox.pending_len() > 0 {
        socket.buffered = 0;
        outbox.flush(10, &mut socket);
    }
    assert!(socket.closed.is_none());

    let mut reassembled = String::new();
    for (idx, (raw, compress)) in socket.sent.iter().enumerate() {
        assert!(*compress);
        let part = ace_json::parse(raw).unwrap();
        assert_eq!(
            part.get("type").and_then(Value::as_str),
            Some("snapshot.part")
        );
        assert_eq!(
            part.get("subscriptionId").and_then(Value::as_str),
            Some("s1")
        );
        assert_eq!(part.get("seq").and_then(Value::as_f64), Some(42.0));
        assert_eq!(part.get("index").and_then(Value::as_f64), Some(idx as f64));
        let done = part.get("done").and_then(Value::as_bool).unwrap();
        assert_eq!(done, idx + 1 == socket.sent.len());
        reassembled.push_str(part.get("data").and_then(Value::as_str).unwrap());
    }
    assert_eq!(reassembled, expected_full);
}

#[test]
fn frame_packing_holds_deltas_adaptively_and_never_mixes_with_uncompressed_replies() {
    assert_eq!(
        frame_hold_for(false, VERY_SLOW_BACKLOG_BYTES),
        FRAME_HOLD_MS
    );
    assert_eq!(frame_hold_for(true, 0), FRAME_HOLD_MS);
    assert_eq!(frame_hold_for(true, SLOW_BACKLOG_BYTES), 100);
    assert_eq!(frame_hold_for(true, VERY_SLOW_BACKLOG_BYTES), 250);

    // Compression allowlist keeps credential/control messages uncompressed.
    assert!(may_compress("events"));
    assert!(may_compress("snapshot"));
    assert!(!may_compress("welcome"));
    assert!(!may_compress("devices.result"));
    assert!(!may_compress("browser.state"));

    let mut socket = FakeSocket::open();
    socket.buffered = SLOW_BACKLOG_BYTES;
    let mut outbox = Outbox::new(PressureOptions::default(), WireEncoder::new());
    outbox.pack_frames(true);
    outbox.shape_events(EventShape {
        raw_on_demand: false,
        short_deltas: true,
    });

    // Two delta batches wait together in one packed frame (100 ms remote slow hold).
    let d1 = EventsMessage {
        subscription_id: JsString::from("s"),
        after_seq: 0.0,
        through_seq: 1.0,
        early: false,
        events: vec![delta_event(1, "t", "i", "a")],
    };
    let d2 = EventsMessage {
        subscription_id: JsString::from("s"),
        after_seq: 1.0,
        through_seq: 2.0,
        early: false,
        events: vec![delta_event(2, "t", "i", "b")],
    };
    outbox.send_events(&d1, 1000, &mut socket);
    outbox.send_events(&d2, 1010, &mut socket);
    assert!(socket.sent.is_empty());
    assert_eq!(outbox.hold_due_ms(), Some(1100));

    // Sending an uncompressed message flushes the held packed frame FIRST, then sends uncompressed alone.
    let welcome = ace_json::parse(r#"{"type":"welcome","protocolVersion":1}"#).unwrap();
    outbox.send_value(&welcome, 1020, &mut socket);
    assert_eq!(socket.sent.len(), 2);
    assert!(socket.sent[0].1, "packed deltas frame is compressed");
    assert_eq!(
        socket.sent[0].0.lines().count(),
        2,
        "both delta messages packed"
    );
    assert!(!socket.sent[1].1, "welcome sent uncompressed alone");
    assert_eq!(
        socket.sent[1].0,
        r#"{"type":"welcome","protocolVersion":1}"#
    );

    // A non-delta event flushes immediately together with any held delta ahead of it.
    let d3 = EventsMessage {
        subscription_id: JsString::from("s"),
        after_seq: 2.0,
        through_seq: 3.0,
        early: false,
        events: vec![delta_event(3, "t", "i", "c")],
    };
    let nd = EventsMessage {
        subscription_id: JsString::from("s"),
        after_seq: 3.0,
        through_seq: 4.0,
        early: false,
        events: vec![non_delta_event(4, "t")],
    };
    outbox.send_events(&d3, 2000, &mut socket);
    assert_eq!(socket.sent.len(), 2);
    outbox.send_events(&nd, 2001, &mut socket);
    assert_eq!(socket.sent.len(), 3);
    assert_eq!(socket.sent[2].0.lines().count(), 2);

    // Reaching HELD_FRAME_BYTES flushes immediately regardless of hold timer.
    let huge_delta = EventsMessage {
        subscription_id: JsString::from("s"),
        after_seq: 4.0,
        through_seq: 5.0,
        early: false,
        events: vec![delta_event(5, "t", "i", &"z".repeat(HELD_FRAME_BYTES))],
    };
    outbox.send_events(&huge_delta, 3000, &mut socket);
    assert_eq!(socket.sent.len(), 4);
}

#[test]
fn socket_input_pauses_at_threshold_resumes_at_half_bypasses_ping_and_closes_on_cap() {
    let limits = SocketInputLimits {
        pause_messages: 4,
        pause_bytes: 2_000,
        socket_bytes: 3_000,
        global_bytes: 4_000,
        message_overhead: 100,
    };
    let mut input = SocketInput::new(limits);

    // Immediate ping bypasses queue even when busy.
    assert!(is_ping(br#"{"type":"ping"}"#));
    assert!(!is_ping(br#"{"type":"ping","extra":1}"#));
    assert!(!is_ping(&[b' '; 65]));
    assert_eq!(input.admit(1_u32, 15, true), InputDecision::Immediate);
    assert_eq!(input.depth(), 0);

    // Four small frames trigger pause on the 4th.
    let mut charges = Vec::new();
    for i in 0..4 {
        let decision = input.admit(1_u32, 10, false);
        match decision {
            InputDecision::Queue { charge, pause } => {
                assert_eq!(pause, i == 3);
                charges.push(charge);
            }
            other => panic!("unexpected {other:?}"),
        }
    }
    assert!(input.is_paused(&1));
    // Finishing one (depth 3 > 4/2) stays paused; finishing a second (depth 2 <= 4/2) resumes.
    assert!(!input.finish(&1, charges[0]));
    assert!(input.finish(&1, charges[1]));
    assert!(!input.is_paused(&1));

    // Oversized frame past per-socket cap closes with 4009.
    assert_eq!(
        input.admit(1_u32, 2_900, false),
        InputDecision::Close {
            code: INPUT_BACKPRESSURE_CLOSE_CODE,
            reason: "Message backpressure",
        }
    );
}

#[test]
fn liveness_agent_classification_close_records_and_bounded_socket_closer() {
    assert_eq!(client_agent(None), ClientAgent::Node);
    assert_eq!(
        client_agent(Some("Mozilla/5.0 Electron/33.0")),
        ClientAgent::Desktop
    );
    assert_eq!(
        client_agent(Some("ace/1.0 CFNetwork/1498")),
        ClientAgent::Ios
    );
    assert_eq!(
        client_agent(Some("Mozilla/5.0 CFNetwork/1498")),
        ClientAgent::Browser
    );
    assert_eq!(client_agent(Some("okhttp/4.12.0")), ClientAgent::Android);

    let direct_peer = ClosePeer {
        client: ClientAgent::Browser,
        access: Some("paired"),
        channel: None,
        remote: true,
        route: None,
    };
    assert!(close_record(1000, b"done", 500, true, direct_peer.clone()).is_none());
    assert!(close_record(1006, b"drop", 500, false, direct_peer.clone()).is_none());
    let rec = close_record(4009, b"backpressure", -5, false, direct_peer).unwrap();
    assert_eq!(rec.duration_ms, 0);

    // Relayed ordinary close is kept.
    let relay_peer = ClosePeer {
        client: ClientAgent::Unknown,
        access: Some("paired"),
        channel: None,
        remote: true,
        route: Some("relay"),
    };
    assert!(close_record(1000, b"Peer closed", 120, true, relay_peer).is_some());

    // SocketCloser idempotency, late open restart, and grace deadline.
    let mut closer = SocketCloser::new(DAEMON_CLOSE_GRACE_MS);
    assert_eq!(
        closer.graceful_close(1_u32, ReadyState::Connecting, 4001, "bye", 100),
        CloseAction::None
    );
    // Socket opens at t=500 -> close frame sent and grace restarts to 1500.
    assert_eq!(
        closer.graceful_close(1_u32, ReadyState::Open, 4001, "bye", 500),
        CloseAction::SendClose {
            code: 4001,
            reason: "bye".to_owned(),
        }
    );
    // Second graceful close is idempotent.
    assert_eq!(
        closer.graceful_close(1_u32, ReadyState::Open, 4002, "again", 600),
        CloseAction::None
    );
    assert!(closer.drain_expired(1_499).is_empty());
    assert_eq!(closer.drain_expired(1_500), vec![1_u32]);
    assert_eq!(closer.pending_len(), 0);
}
