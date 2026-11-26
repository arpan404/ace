// SPDX-License-Identifier: Apache-2.0
//! A relayed main channel seen as a socket (`apps/daemon/src/relay-socket.ts`), so the daemon's
//! one main-socket handler serves it exactly as it serves a direct one: same hello, scopes,
//! admission, outbox backpressure, replay and close codes. The relay has no close frame, so a
//! close sends `channel.close` with its code and reason as the channel's last message; the
//! relay's own close keeps its code and reason ("Peer closed" when the far end went away), and
//! any other failure is an abnormal 1006 with what broke.

use crate::error::RelayError;
use crate::nk::admission::NkSession;

/// The 1-based ready states a `ws` socket reports (`relay-socket.ts:50`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadyState {
    Open = 1,
    Closing = 2,
    Closed = 3,
}

/// One frame the relay delivered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Text(String),
    Binary(Vec<u8>),
}

/// What a relay channel offers the daemon (`HostChannel` in `@ace/relay`). The bytes are the
/// shell's; this trait is where a test's channel and the relay's meet.
pub trait HostChannel {
    /// The next frame, or `None` when nothing is queued.
    fn receive(&mut self) -> Option<Frame>;
    /// The cause of the channel's close, once it has closed (`closed`'s value).
    fn closed_cause(&self) -> Option<RelayError>;
    fn send_text(&mut self, text: &str, deflate: bool) -> Result<(), RelayError>;
    fn send_binary(&mut self, bytes: &[u8]) -> Result<(), RelayError>;
    fn buffered_bytes(&self) -> usize;
    fn close(&mut self);
}

/// What the daemon's socket handler sees.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocketEvent {
    Message { data: Vec<u8>, binary: bool },
    Close { code: u16, reason: String },
}

/// The longest close reason a channel carries, in UTF-16 units as `String.slice(0, 123)` counts.
pub const MAX_CLOSE_REASON: usize = 123;

/// `text.slice(0, units)` over UTF-16 units, keeping whole characters (the TypeScript can keep a
/// lone surrogate; a Rust string cannot, so the half is dropped).
pub fn slice_utf16(text: &str, units: usize) -> String {
    let mut kept = String::new();
    let mut used = 0;
    for character in text.chars() {
        let width = character.len_utf16();
        if used + width > units {
            break;
        }
        used += width;
        kept.push(character);
    }
    kept
}

/// The close a channel's end reads as (`endedBy`, `relay-socket.ts:59`).
pub fn ended_by(cause: Option<&RelayError>) -> (u16, String) {
    match cause {
        Some(error) => {
            let (code, reason) = error.ended_by();
            (code, slice_utf16(&reason, MAX_CLOSE_REASON))
        }
        None => (1006, String::new()),
    }
}

/// A relayed main channel a socket handler can read, write and close.
pub struct RelaySocket {
    deflate: bool,
    state: ReadyState,
    paused: bool,
    /// Before confirmation: the session whose output budget applies.
    session: Option<NkSession>,
}

impl RelaySocket {
    /// `deflate`: the peer said it inflates (`hello.compression`), so bulk text may go deflated.
    pub fn new(deflate: bool) -> Self {
        Self {
            deflate,
            state: ReadyState::Open,
            paused: false,
            session: None,
        }
    }

    pub fn ready_state(&self) -> ReadyState {
        self.state
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    pub fn buffered_amount(&self, channel: &dyn HostChannel) -> usize {
        channel.buffered_bytes()
    }

    /// Deliver `first` (the hello the relay host already read) as the channel's first message.
    pub fn start(&mut self, first: &[u8]) -> SocketEvent {
        SocketEvent::Message {
            data: first.to_vec(),
            binary: false,
        }
    }

    /// An unconfirmed NK stream's next message is its confirmation, which isn't ours to read:
    /// nothing the client sends is taken until it has confirmed. The subscribes that waited for
    /// the confirmation come first, then the client's own.
    pub fn after_confirmation(
        &mut self,
        confirmed: bool,
        continuations: &[Vec<u8>],
    ) -> Vec<SocketEvent> {
        self.session = None;
        if !confirmed {
            self.state = ReadyState::Closed;
            return vec![SocketEvent::Close {
                code: 1006,
                reason: String::new(),
            }];
        }
        continuations
            .iter()
            .map(|message| SocketEvent::Message {
                data: message.clone(),
                binary: false,
            })
            .collect()
    }

    /// The session whose output budget applies before confirmation.
    pub fn hold_session(&mut self, session: NkSession) {
        self.session = Some(session);
    }

    /// A frame the channel received, in order; `None` while paused or no longer open.
    pub fn receive(&mut self, frame: Frame) -> Option<SocketEvent> {
        if self.state != ReadyState::Open || self.paused {
            return None;
        }
        Some(match frame {
            Frame::Text(text) => SocketEvent::Message {
                data: text.into_bytes(),
                binary: false,
            },
            Frame::Binary(bytes) => SocketEvent::Message {
                data: bytes,
                binary: true,
            },
        })
    }

    /// The channel closed: the relay's own code and reason, or 1006 with what broke.
    pub fn ended(&mut self, cause: Option<&RelayError>) -> SocketEvent {
        self.state = ReadyState::Closed;
        let (code, reason) = ended_by(cause);
        SocketEvent::Close { code, reason }
    }

    /// Text, deflated when the peer takes it and the caller hasn't opted out.
    pub fn send_text(
        &mut self,
        text: &str,
        compress: bool,
        channel: &mut dyn HostChannel,
    ) -> Result<(), RelayError> {
        self.budget(text.len(), channel)?;
        channel.send_text(text, self.deflate && compress)
    }

    /// Bytes: binary as a `ws` socket sends them, unless the caller says they are text.
    pub fn send_bytes(
        &mut self,
        bytes: &[u8],
        binary: bool,
        compress: bool,
        channel: &mut dyn HostChannel,
    ) -> Result<(), RelayError> {
        self.budget(bytes.len(), channel)?;
        if binary {
            return channel.send_binary(bytes);
        }
        channel.send_text(&String::from_utf8_lossy(bytes), self.deflate && compress)
    }

    /// Before confirmation at most 256 KiB goes out (ADR 0155). Anything past it ends the
    /// session, so nothing waits anywhere for a client that hasn't confirmed.
    fn budget(&mut self, size: usize, channel: &mut dyn HostChannel) -> Result<(), RelayError> {
        if self.state != ReadyState::Open {
            return Err(RelayError::Protocol("Relay channel closed"));
        }
        if let Some(session) = &self.session
            && !session.output(size)
        {
            self.terminate(channel);
            return Err(RelayError::Protocol("Unconfirmed output budget spent"));
        }
        Ok(())
    }

    /// A local close: the goodbye is queued behind earlier messages, so it arrives last; then the
    /// channel ends. The relay has no close frame, so `channel.close` carries the code.
    /// Idempotent per socket: a socket already closing keeps its own code, and returns `None`.
    pub fn close(
        &mut self,
        code: u16,
        reason: &str,
        channel: &mut dyn HostChannel,
    ) -> Option<SocketEvent> {
        if self.state != ReadyState::Open {
            return None;
        }
        self.state = ReadyState::Closing;
        let code = if (1000..=4999).contains(&code) {
            code
        } else {
            1000
        };
        let reason = slice_utf16(reason, MAX_CLOSE_REASON);
        let mut goodbye = ace_json::Map::new();
        goodbye.insert("type", ace_json::Value::String("channel.close".into()));
        goodbye.insert("code", ace_json::Value::from(code));
        goodbye.insert("reason", ace_json::Value::String(reason.clone().into()));
        let text = ace_json::to_string(&ace_json::Value::Object(goodbye));
        let _ = channel.send_text(&text, false);
        channel.close();
        self.state = ReadyState::Closed;
        self.session = None;
        Some(SocketEvent::Close { code, reason })
    }

    /// Ends the channel with an abnormal 1006 and no reason.
    pub fn terminate(&mut self, channel: &mut dyn HostChannel) -> SocketEvent {
        channel.close();
        self.state = ReadyState::Closed;
        self.session = None;
        SocketEvent::Close {
            code: 1006,
            reason: String::new(),
        }
    }

    pub fn pause(&mut self) {
        self.paused = true;
    }

    pub fn resume(&mut self) {
        self.paused = false;
    }
}

#[cfg(test)]
mod tests {
    //! `relay-socket.ts` has no test file of its own; these prove the behaviour it names: the
    //! relay's close code and reason survive, a local close carries `channel.close` last, the
    //! unconfirmed output budget ends the session, and a paused reader stops taking frames.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use std::sync::Arc;

    use super::{
        Frame, HostChannel, MAX_CLOSE_REASON, ReadyState, RelaySocket, SocketEvent, ended_by,
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

        fn close(&mut self) {
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
            SocketEvent::Message {
                data: b"{\"type\":\"hello\"}".to_vec(),
                binary: false
            }
        );
        assert_eq!(
            socket.receive(Frame::Text("second".to_owned())),
            Some(SocketEvent::Message {
                data: b"second".to_vec(),
                binary: false
            })
        );
        assert_eq!(
            socket.receive(Frame::Binary(vec![1, 2])),
            Some(SocketEvent::Message {
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
            SocketEvent::Close {
                code: 4003,
                reason: "Peer closed".to_owned()
            }
        );
        assert_eq!(socket.ready_state(), ReadyState::Closed);
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
            Some(SocketEvent::Close {
                code: 1000,
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
            SocketEvent::Close {
                code: 1006,
                reason: String::new()
            }
        );
        assert!(channel.closed);
        assert_eq!(socket.ready_state(), ReadyState::Closed);
    }

    #[test]
    fn a_paused_reader_takes_no_frames_until_it_resumes() {
        let mut socket = RelaySocket::new(false);
        socket.pause();
        assert!(socket.is_paused());
        assert_eq!(socket.receive(Frame::Text("held".to_owned())), None);
        socket.resume();
        assert!(socket.receive(Frame::Text("taken".to_owned())).is_some());
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
        assert_eq!(socket.ready_state(), ReadyState::Closed);
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
            vec![SocketEvent::Message {
                data: b"subscribe".to_vec(),
                binary: false
            }]
        );
        let mut socket = RelaySocket::new(false);
        assert_eq!(
            socket.after_confirmation(false, &[]),
            vec![SocketEvent::Close {
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
}
