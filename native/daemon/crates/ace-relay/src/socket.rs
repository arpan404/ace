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
mod tests;
