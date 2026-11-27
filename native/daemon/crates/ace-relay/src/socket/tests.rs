//! `relay-socket.ts` has no test file of its own; these prove the behaviour it names: the
//! relay's close code and reason survive, a local close carries `channel.close` last, the
//! unconfirmed output budget ends the session, and a paused reader stops taking frames.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use super::{
    Frame, HostChannel, MAX_CLOSE_REASON, RelaySocket, RelayedEvent, RelayedState, ended_by,
    slice_utf16,
};
use crate::error::RelayError;
use crate::nk::admission::{Cancel, NK_LIMITS, NkAdmission, NkClock, NkSession};

struct ZeroClock;
impl NkClock for ZeroClock {
    fn now(&self) -> i64 {
        0
    }
    fn schedule(&self, _milliseconds: i64, _run: Box<dyn FnOnce() + Send>) -> Cancel {
        Box::new(|| {})
    }
}

#[derive(Default)]
struct Channel {
    incoming: Vec<Frame>,
    texts: Vec<(String, bool)>,
    binaries: Vec<Vec<u8>>,
    closed: bool,
    buffered: usize,
    cause: Option<RelayError>,
}

impl HostChannel for Channel {
    fn receive(&mut self) -> Option<Frame> {
        (!self.incoming.is_empty()).then(|| self.incoming.remove(0))
    }

    fn closed_cause(&self) -> Option<RelayError> {
        self.cause.clone()
    }

    fn send_text(&mut self, text: &str, deflate: bool) -> Result<(), RelayError> {
        self.texts.push((text.to_owned(), deflate));
        Ok(())
    }

    fn send_binary(&mut self, bytes: &[u8]) -> Result<(), RelayError> {
        self.binaries.push(bytes.to_vec());
        Ok(())
    }

    fn buffered_bytes(&self) -> usize {
        self.buffered
    }

    fn close_after_flush(&mut self) {
        self.closed = true;
    }
}

fn session() -> NkSession {
    NkAdmission::new(Arc::new(ZeroClock), NK_LIMITS)
        .admit("phone", || {})
        .unwrap()
}

#[test]
fn the_hello_the_relay_read_is_the_first_message_and_order_holds() {
    let mut socket = RelaySocket::new(false);
    assert_eq!(
        socket.start(b"{\"type\":\"hello\"}"),
        RelayedEvent::Message {
            data: b"{\"type\":\"hello\"}".to_vec(),
            binary: false
        }
    );
    assert_eq!(
        socket.receive(Frame::Text("second".to_owned())),
        Ok(RelayedEvent::Message {
            data: b"second".to_vec(),
            binary: false
        })
    );
    assert_eq!(
        socket.receive(Frame::Binary(vec![1, 2])),
        Ok(RelayedEvent::Message {
            data: vec![1, 2],
            binary: true
        })
    );
}

#[test]
fn a_relayed_close_keeps_its_code_and_reason_and_any_other_failure_is_1006() {
    let mut socket = RelaySocket::new(false);
    let relayed = socket.ended(Some(&RelayError::Closed {
        code: 4003,
        reason: "Peer closed".to_owned(),
    }));
    assert_eq!(
        relayed,
        RelayedEvent::Close {
            code: 4003,
            reason: "Peer closed".to_owned()
        }
    );
    assert_eq!(socket.ready_state(), RelayedState::Closed);
    // Any other failure keeps its message, cut to 123 UTF-16 units.
    let (code, reason) = ended_by(Some(&RelayError::Noise("x")));
    assert_eq!(code, 1006);
    assert_eq!(reason, "x");
    let long = RelayError::Closed {
        code: 1006,
        reason: "y".repeat(200),
    };
    let (_, reason) = ended_by(Some(&long));
    assert_eq!(reason.len(), 123);
    let emoji = RelayError::Closed {
        code: 1006,
        reason: "😀".repeat(200),
    };
    let (_, reason) = ended_by(Some(&emoji));
    // 61 emoji fit in 123 UTF-16 units; the 62nd would need 124.
    assert_eq!(reason.encode_utf16().count(), 122);
}

#[test]
fn a_local_close_sends_channel_close_last_with_the_clamped_code_and_reason() {
    let mut socket = RelaySocket::new(false);
    let mut channel = Channel::default();
    let event = socket.close(5000, "bye", &mut channel);
    assert_eq!(
        event,
        Some(RelayedEvent::Close {
            // The handler sees the code it asked for; the frame carries the clamped one below.
            code: 5000,
            reason: "bye".to_owned()
        })
    );
    // A second close is a no-op.
    assert_eq!(socket.close(4001, "again", &mut channel), None);
    assert!(channel.closed);
    let (text, deflate) = channel.texts.last().unwrap();
    assert!(!deflate);
    let goodbye = ace_json::parse(text).unwrap();
    assert_eq!(
        goodbye.get("code").and_then(ace_json::Value::as_u64),
        Some(1000)
    );
    assert_eq!(
        goodbye.get("type").and_then(ace_json::Value::as_str),
        Some("channel.close")
    );
    assert_eq!(
        goodbye.get("code").and_then(ace_json::Value::as_u64),
        Some(1000)
    );
    // A reason is cut to 123 UTF-16 units: 61 emoji, not 123.
    let mut socket = RelaySocket::new(false);
    let mut channel = Channel::default();
    socket.close(4001, &"😀".repeat(200), &mut channel);
    let goodbye = ace_json::parse(&channel.texts.last().unwrap().0).unwrap();
    assert_eq!(
        goodbye
            .get("reason")
            .and_then(ace_json::Value::as_str)
            .unwrap()
            .encode_utf16()
            .count(),
        122
    );
    assert_eq!(slice_utf16("😀", 1), "");
    assert_eq!(MAX_CLOSE_REASON, 123);
}

#[test]
fn terminate_is_1006_with_no_reason_and_closes_the_channel() {
    let mut socket = RelaySocket::new(false);
    let mut channel = Channel::default();
    assert_eq!(
        socket.terminate(&mut channel),
        RelayedEvent::Close {
            code: 1006,
            reason: String::new()
        }
    );
    assert!(channel.closed);
    assert_eq!(socket.ready_state(), RelayedState::Closed);
}

#[test]
fn a_paused_reader_takes_no_frames_until_it_resumes() {
    let mut socket = RelaySocket::new(false);
    socket.pause();
    assert!(socket.is_paused());
    // The frame comes back rather than vanishing, so the shell can keep it.
    let held = Frame::Text("held".to_owned());
    assert_eq!(socket.receive(held.clone()), Err(held));
    socket.resume();
    assert!(socket.receive(Frame::Text("taken".to_owned())).is_ok());
}

#[test]
fn before_confirmation_output_past_256_kib_ends_the_session() {
    let mut socket = RelaySocket::new(false);
    socket.hold_session(session());
    let mut channel = Channel::default();
    socket
        .send_text(&"x".repeat(200 * 1024), true, &mut channel)
        .unwrap();
    assert_eq!(channel.texts.len(), 1);
    let error = socket
        .send_text(&"x".repeat(57 * 1024), true, &mut channel)
        .unwrap_err();
    assert!(error.to_string().contains("output budget"));
    assert!(channel.closed);
    assert_eq!(socket.ready_state(), RelayedState::Closed);
    // Nothing more goes out.
    assert!(socket.send_text("after", true, &mut channel).is_err());
}

#[test]
fn deflate_reaches_text_when_the_peer_takes_it_and_binary_never_carries_it() {
    let mut socket = RelaySocket::new(true);
    let mut channel = Channel::default();
    socket.send_text("bulk", true, &mut channel).unwrap();
    socket.send_text("plain", false, &mut channel).unwrap();
    socket
        .send_bytes(&[1, 2, 3], true, true, &mut channel)
        .unwrap();
    assert_eq!(
        channel.texts,
        vec![("bulk".to_owned(), true), ("plain".to_owned(), false)]
    );
    assert_eq!(channel.binaries, vec![vec![1, 2, 3]]);
    // Bytes a caller marks as text go as text, deflated too.
    socket
        .send_bytes(b"{\"a\":1}", false, true, &mut channel)
        .unwrap();
    assert_eq!(
        channel.texts.last().unwrap(),
        &("{\"a\":1}".to_owned(), true)
    );
}

#[test]
fn an_unconfirmed_session_s_continuations_come_first_and_a_refusal_terminates() {
    let mut socket = RelaySocket::new(false);
    socket.hold_session(session());
    let events = socket.after_confirmation(true, &[b"subscribe".to_vec()]);
    assert_eq!(
        events,
        vec![RelayedEvent::Message {
            data: b"subscribe".to_vec(),
            binary: false
        }]
    );
    let mut socket = RelaySocket::new(false);
    assert_eq!(
        socket.after_confirmation(false, &[]),
        vec![RelayedEvent::Close {
            code: 1006,
            reason: String::new()
        }]
    );
}

#[test]
fn the_buffered_amount_is_the_channel_s_own() {
    let socket = RelaySocket::new(false);
    let channel = Channel {
        buffered: 1234,
        ..Default::default()
    };
    assert_eq!(socket.buffered_amount(&channel), 1234);
}

#[test]
fn dropping_a_relay_socket_with_an_unconfirmed_session_releases_it_even_when_cloned() {
    let held_session = session();
    assert!(held_session.reserve_bytes(1024));
    let mut socket = RelaySocket::new(false);
    socket.hold_session(held_session.clone());
    drop(socket);
    assert!(held_session.closed());
}

#[test]
fn a_revoked_device_cannot_keep_a_relayed_socket_open_for_send_receive_or_confirm() {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    // Revoked before send: terminates channel, releases unconfirmed session, refuses send.
    let admitted = Arc::new(AtomicBool::new(true));
    let held_session = session();
    let mut socket = RelaySocket::new(false);
    socket.hold_session(held_session.clone());
    let flag = Arc::clone(&admitted);
    socket.set_still_admitted(move || flag.load(Ordering::SeqCst));

    let mut channel = Channel::default();
    socket.send_text("ok", false, &mut channel).unwrap();
    assert_eq!(channel.texts.len(), 1);
    admitted.store(false, Ordering::SeqCst);
    let err = socket
        .send_text("after-revoke", false, &mut channel)
        .unwrap_err();
    assert!(err.to_string().contains("no longer admitted"));
    assert!(channel.closed);
    assert_eq!(socket.ready_state(), RelayedState::Closed);
    assert!(held_session.closed());

    // Revoked before receive: refuses frame and closes socket.
    let admitted = Arc::new(AtomicBool::new(true));
    let mut socket = RelaySocket::new(false);
    let flag = Arc::clone(&admitted);
    socket.set_still_admitted(move || flag.load(Ordering::SeqCst));
    assert!(socket.receive(Frame::Text("ok".to_owned())).is_ok());
    admitted.store(false, Ordering::SeqCst);
    let frame = Frame::Text("late".to_owned());
    assert_eq!(socket.receive(frame.clone()), Err(frame));
    assert_eq!(socket.ready_state(), RelayedState::Closed);

    // Revoked before confirmation: refuses continuations and closes.
    let admitted = Arc::new(AtomicBool::new(false));
    let held = session();
    let mut socket = RelaySocket::new(false);
    socket.hold_session(held.clone());
    let flag = Arc::clone(&admitted);
    socket.set_still_admitted(move || flag.load(Ordering::SeqCst));
    assert_eq!(
        socket.after_confirmation(true, &[b"sub".to_vec()]),
        vec![RelayedEvent::Close {
            code: 1006,
            reason: String::new(),
        }]
    );
    assert!(held.closed());

    // Explicit recheck closes immediately.
    let admitted = Arc::new(AtomicBool::new(true));
    let mut socket = RelaySocket::new(false);
    let flag = Arc::clone(&admitted);
    socket.set_still_admitted(move || flag.load(Ordering::SeqCst));
    let mut channel = Channel::default();
    assert_eq!(socket.check_admitted(&mut channel), None);
    admitted.store(false, Ordering::SeqCst);
    assert_eq!(
        socket.check_admitted(&mut channel),
        Some(RelayedEvent::Close {
            code: 1006,
            reason: String::new(),
        })
    );
    assert!(channel.closed);
}
