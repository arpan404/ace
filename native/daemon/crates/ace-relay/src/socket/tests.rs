//! `relay-socket.ts` has no test file of its own; these prove the behaviour it names: the
//! relay's close code and reason survive, a local close carries `channel.close` last, the
//! unconfirmed output budget ends the session, a revoked credential ends the channel through
//! every read and write, and a paused reader stops taking frames.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use super::{
    CredentialGuard, Frame, HostChannel, MAX_CLOSE_REASON, RelaySocket, RelayedEvent, RelayedState,
    ended_by, slice_utf16,
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

/// A channel the test keeps a handle on after the socket takes ownership of it.
#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Channel>>);

impl Shared {
    fn get(&self) -> std::sync::MutexGuard<'_, Channel> {
        self.0.lock().unwrap()
    }
}

impl HostChannel for Shared {
    fn receive(&mut self) -> Option<Frame> {
        let mut channel = self.get();
        (!channel.incoming.is_empty()).then(|| channel.incoming.remove(0))
    }

    fn closed_cause(&self) -> Option<RelayError> {
        self.get().cause.clone()
    }

    fn send_text(&mut self, text: &str, deflate: bool) -> Result<(), RelayError> {
        self.get().texts.push((text.to_owned(), deflate));
        Ok(())
    }

    fn send_binary(&mut self, bytes: &[u8]) -> Result<(), RelayError> {
        self.get().binaries.push(bytes.to_vec());
        Ok(())
    }

    fn buffered_bytes(&self) -> usize {
        self.get().buffered
    }

    fn close_after_flush(&mut self) {
        self.get().closed = true;
    }
}

fn session() -> NkSession {
    NkAdmission::new(Arc::new(ZeroClock), NK_LIMITS)
        .admit("phone", || {})
        .unwrap()
}

/// A paired credential whose generation a test can replace or revoke.
#[derive(Clone, Default)]
struct PairedRegistry(Arc<Mutex<Option<(String, String)>>>);

impl PairedRegistry {
    fn new(device: &str, generation: &str) -> Self {
        Self(Arc::new(Mutex::new(Some((
            device.to_owned(),
            generation.to_owned(),
        )))))
    }

    fn guard(&self) -> CredentialGuard {
        let registry = Arc::clone(&self.0);
        CredentialGuard::paired("phone", "gen-1", move |device, generation| {
            registry
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|(current, current_generation)| {
                    current == device && current_generation == generation
                })
        })
    }

    fn revoke(&self) {
        *self.0.lock().unwrap() = None;
    }
}

fn relay_socket(deflate: bool, channel: &Shared, guard: CredentialGuard) -> RelaySocket {
    RelaySocket::new(deflate, Box::new(channel.clone()), guard)
}

#[test]
fn the_hello_the_relay_read_is_the_first_message_and_order_holds() {
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
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
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
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
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
    let event = socket.close(5000, "bye");
    assert_eq!(
        event,
        Some(RelayedEvent::Close {
            // The handler sees the code it asked for; the frame carries the clamped one below.
            code: 5000,
            reason: "bye".to_owned()
        })
    );
    // A second close is a no-op.
    assert_eq!(socket.close(4001, "again"), None);
    assert!(channel.get().closed);
    let (text, deflate) = channel.get().texts.last().unwrap().clone();
    assert!(!deflate);
    let goodbye = ace_json::parse(&text).unwrap();
    assert_eq!(
        goodbye.get("code").and_then(ace_json::Value::as_u64),
        Some(1000)
    );
    assert_eq!(
        goodbye.get("type").and_then(ace_json::Value::as_str),
        Some("channel.close")
    );
    // A reason is cut to 123 UTF-16 units: 61 emoji, not 123.
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
    socket.close(4001, &"😀".repeat(200));
    let goodbye = ace_json::parse(&channel.get().texts.last().unwrap().0).unwrap();
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
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
    assert_eq!(
        socket.terminate(),
        RelayedEvent::Close {
            code: 1006,
            reason: String::new()
        }
    );
    assert!(channel.get().closed);
    assert_eq!(socket.ready_state(), RelayedState::Closed);
}

#[test]
fn a_paused_reader_takes_no_frames_until_it_resumes() {
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
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
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
    socket.hold_session(session());
    socket.send_text(&"x".repeat(200 * 1024), true).unwrap();
    assert_eq!(channel.get().texts.len(), 1);
    let error = socket.send_text(&"x".repeat(57 * 1024), true).unwrap_err();
    assert!(error.to_string().contains("output budget"));
    assert!(channel.get().closed);
    assert_eq!(socket.ready_state(), RelayedState::Closed);
    // Nothing more goes out.
    assert!(socket.send_text("after", true).is_err());
}

#[test]
fn deflate_reaches_text_when_the_peer_takes_it_and_binary_never_carries_it() {
    let channel = Shared::default();
    let mut socket = relay_socket(
        true,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
    socket.send_text("bulk", true).unwrap();
    socket.send_text("plain", false).unwrap();
    socket.send_bytes(&[1, 2, 3], true, true).unwrap();
    assert_eq!(
        channel.get().texts,
        vec![("bulk".to_owned(), true), ("plain".to_owned(), false)]
    );
    assert_eq!(channel.get().binaries, vec![vec![1, 2, 3]]);
    // Bytes a caller marks as text go as text, deflated too.
    socket.send_bytes(b"{\"a\":1}", false, true).unwrap();
    assert_eq!(
        channel.get().texts.last().unwrap(),
        &("{\"a\":1}".to_owned(), true)
    );
}

#[test]
fn an_unconfirmed_session_s_continuations_come_first_and_a_refusal_terminates() {
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
    socket.hold_session(session());
    let events = socket.after_confirmation(true, &[b"subscribe".to_vec()]);
    assert_eq!(
        events,
        vec![RelayedEvent::Message {
            data: b"subscribe".to_vec(),
            binary: false
        }]
    );
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
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
    let channel = Shared::default();
    channel.get().buffered = 1234;
    let socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
    assert_eq!(socket.buffered_amount(), 1234);
}

#[test]
fn dropping_a_relay_socket_with_an_unconfirmed_session_releases_it_even_when_cloned() {
    let held_session = session();
    assert!(held_session.reserve_bytes(1024));
    let channel = Shared::default();
    let mut socket = relay_socket(
        false,
        &channel,
        PairedRegistry::new("phone", "gen-1").guard(),
    );
    socket.hold_session(held_session.clone());
    drop(socket);
    assert!(held_session.closed());
}

#[test]
fn a_revoked_paired_generation_cannot_send_receive_or_confirm() {
    // Revoked before send: closes the channel, releases the unconfirmed session, refuses send.
    let registry = PairedRegistry::new("phone", "gen-1");
    let channel = Shared::default();
    let held = session();
    let mut socket = relay_socket(false, &channel, registry.guard());
    socket.hold_session(held.clone());
    socket.send_text("ok", false).unwrap();
    assert_eq!(channel.get().texts.len(), 1);
    registry.revoke();
    let error = socket.send_text("after-revoke", false).unwrap_err();
    assert!(error.to_string().contains("no longer admitted"));
    assert!(channel.get().closed);
    assert_eq!(socket.ready_state(), RelayedState::Closed);
    assert!(held.closed());

    // Revoked before receive: refuses the frame and closes the channel.
    let registry = PairedRegistry::new("phone", "gen-1");
    let channel = Shared::default();
    let mut socket = relay_socket(false, &channel, registry.guard());
    assert!(socket.receive(Frame::Text("ok".to_owned())).is_ok());
    registry.revoke();
    let frame = Frame::Text("late".to_owned());
    assert_eq!(socket.receive(frame.clone()), Err(frame));
    assert!(channel.get().closed);
    assert_eq!(socket.ready_state(), RelayedState::Closed);

    // Revoked before confirmation: refuses continuations, closes the channel, releases the hold.
    let registry = PairedRegistry::new("phone", "gen-1");
    let channel = Shared::default();
    let held = session();
    let mut socket = relay_socket(false, &channel, registry.guard());
    socket.hold_session(held.clone());
    registry.revoke();
    assert_eq!(
        socket.after_confirmation(true, &[b"sub".to_vec()]),
        vec![RelayedEvent::Close {
            code: 1006,
            reason: String::new(),
        }]
    );
    assert!(channel.get().closed);
    assert!(held.closed());

    // A generation replaced under the same device id is a refusal too.
    let registry = PairedRegistry::new("phone", "gen-2");
    let channel = Shared::default();
    let mut socket = relay_socket(false, &channel, registry.guard());
    let frame = Frame::Text("replaced".to_owned());
    assert_eq!(socket.receive(frame.clone()), Err(frame));
    assert!(channel.get().closed);
}

#[test]
fn an_account_grant_deadline_ends_the_channel_even_while_the_account_stays_admitted() {
    let admitted = Arc::new(AtomicBool::new(true));
    let now = Arc::new(AtomicI64::new(1_000));
    let guard = {
        let admitted = Arc::clone(&admitted);
        let now = Arc::clone(&now);
        CredentialGuard::account(
            move || admitted.load(Ordering::SeqCst),
            Some(2_000),
            move || now.load(Ordering::SeqCst),
        )
    };
    let channel = Shared::default();
    let mut socket = relay_socket(false, &channel, guard);
    assert!(socket.receive(Frame::Text("ok".to_owned())).is_ok());
    now.store(2_000, Ordering::SeqCst);
    let frame = Frame::Text("expired".to_owned());
    assert_eq!(socket.receive(frame.clone()), Err(frame));
    assert!(channel.get().closed);
    assert_eq!(socket.ready_state(), RelayedState::Closed);

    // An account device whose access was revoked is refused the same way.
    let admitted = Arc::new(AtomicBool::new(true));
    let guard = {
        let admitted = Arc::clone(&admitted);
        CredentialGuard::account(move || admitted.load(Ordering::SeqCst), None, || 0)
    };
    let channel = Shared::default();
    let mut socket = relay_socket(false, &channel, guard);
    admitted.store(false, Ordering::SeqCst);
    assert_eq!(
        socket.check_admitted(),
        Some(RelayedEvent::Close {
            code: 1006,
            reason: String::new(),
        })
    );
    assert!(channel.get().closed);
}
