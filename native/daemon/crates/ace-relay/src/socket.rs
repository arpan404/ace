// SPDX-License-Identifier: Apache-2.0
//! A relayed main channel seen as a socket (`apps/daemon/src/relay-socket.ts`), so the daemon's
//! one main-socket handler serves it exactly as it serves a direct one: same hello, scopes,
//! admission, outbox backpressure, replay and close codes. The relay has no close frame, so a
//! close sends `channel.close` with its code and reason as the channel's last message; the
//! relay's own close keeps its code and reason ("Peer closed" when the far end went away), and
//! any other failure is an abnormal 1006 with what broke.
//!
//! An admitted socket carries its credential from construction: a paired device's generation and
//! an account grant's deadline are part of the socket, not an optional recheck a caller may
//! forget to install. Every read, write and confirmation rechecks it, and a refusal closes the
//! channel the socket owns.

use std::sync::Arc;

use crate::error::RelayError;
use crate::nk::admission::NkSession;

/// The 1-based ready states a `ws` socket reports (`relay-socket.ts:50`). The transport's own
/// `OPEN`/`CLOSING`/`CLOSED` are the shell's; this names the same states for a relayed channel so
/// the main-socket adapter can map one to the other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RelayedState {
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
    /// Ends the channel once the text already queued has been sent (a shell flushes, then
    /// closes). A close that terminates before flushing turns a daemon's goodbye into "Peer
    /// closed" at the client.
    fn close_after_flush(&mut self);
}

/// What the daemon's socket handler sees. Distinct from the transport's `RelayedEvent` (which
/// carries its own close reasons as bytes): the main-socket adapter maps this one onto that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayedEvent {
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

/// What an admitted relay channel's credential must still satisfy. It is fixed at construction:
/// a paired device must still hold the generation it was admitted with, and an account grant
/// must be before its deadline and still admitted by the account backend. A socket built without
/// one cannot exist.
pub struct CredentialGuard {
    paired: Option<PairedCredential>,
    grant: Option<GrantCredential>,
}

type GenerationCheck = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;
type AdmissionCheck = Arc<dyn Fn() -> bool + Send + Sync>;
type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

struct PairedCredential {
    device_id: String,
    generation: String,
    current: GenerationCheck,
}

struct GrantCredential {
    still_admitted: AdmissionCheck,
    expires_at: Option<i64>,
    now: Clock,
}

impl CredentialGuard {
    /// A paired device's credential: `current(device_id, generation)` reports whether that
    /// generation is still the device's current, unrevoked one.
    pub fn paired(
        device_id: impl Into<String>,
        generation: impl Into<String>,
        current: impl Fn(&str, &str) -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            paired: Some(PairedCredential {
                device_id: device_id.into(),
                generation: generation.into(),
                current: Arc::new(current),
            }),
            grant: None,
        }
    }

    /// An account device's grant: `still_admitted` is the account backend's cached verdict, and
    /// `expires_at` (Unix milliseconds) is the grant's deadline, if it has one.
    pub fn account(
        still_admitted: impl Fn() -> bool + Send + Sync + 'static,
        expires_at: Option<i64>,
        now: impl Fn() -> i64 + Send + Sync + 'static,
    ) -> Self {
        Self {
            paired: None,
            grant: Some(GrantCredential {
                still_admitted: Arc::new(still_admitted),
                expires_at,
                now: Arc::new(now),
            }),
        }
    }

    /// Whether the credential is admitted right now.
    pub fn admitted(&self) -> bool {
        if let Some(paired) = &self.paired {
            return (paired.current)(&paired.device_id, &paired.generation);
        }
        let Some(grant) = &self.grant else {
            return false;
        };
        if !(grant.still_admitted)() {
            return false;
        }
        grant
            .expires_at
            .is_none_or(|expires_at| expires_at > (grant.now)())
    }
}

impl std::fmt::Debug for CredentialGuard {
    /// The device id and whether a deadline exists; never a bearer or a grant.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CredentialGuard")
            .field("paired", &self.paired.is_some())
            .field(
                "grant",
                &self.grant.as_ref().map(|grant| grant.expires_at.is_some()),
            )
            .finish_non_exhaustive()
    }
}

/// A relayed main channel a socket handler can read, write and close.
pub struct RelaySocket {
    deflate: bool,
    channel: Box<dyn HostChannel>,
    credential: CredentialGuard,
    state: RelayedState,
    paused: bool,
    /// Before confirmation: the session whose output budget applies.
    session: Option<NkSession>,
}

impl Drop for RelaySocket {
    fn drop(&mut self) {
        self.release_unconfirmed();
    }
}

impl RelaySocket {
    /// `channel` is the byte stream the socket owns and closes; `credential` is the admission it
    /// was constructed with. There is no way to open one without a live credential check.
    pub fn new(deflate: bool, channel: Box<dyn HostChannel>, credential: CredentialGuard) -> Self {
        Self {
            deflate,
            channel,
            credential,
            state: RelayedState::Open,
            paused: false,
            session: None,
        }
    }

    fn release_unconfirmed(&mut self) {
        if let Some(session) = self.session.take()
            && !session.confirmed()
        {
            session.close();
        }
    }

    /// Whether the session's credential is still admitted right now.
    pub fn is_still_admitted(&self) -> bool {
        self.credential.admitted()
    }

    /// Recheck live admission and close the channel at once if the device has been revoked or
    /// expired. Returns `Some(Close)` when this call closed the socket.
    pub fn check_admitted(&mut self) -> Option<RelayedEvent> {
        if self.state != RelayedState::Open || self.is_still_admitted() {
            return None;
        }
        Some(self.terminate())
    }

    pub fn ready_state(&self) -> RelayedState {
        self.state
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    /// The channel's own queued bytes.
    pub fn buffered_amount(&self) -> usize {
        self.channel.buffered_bytes()
    }

    /// Deliver `first` (the hello the relay host already read) as the channel's first message.
    pub fn start(&mut self, first: &[u8]) -> RelayedEvent {
        RelayedEvent::Message {
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
    ) -> Vec<RelayedEvent> {
        if !confirmed || !self.is_still_admitted() {
            return vec![self.terminate()];
        }
        self.session = None;
        continuations
            .iter()
            .map(|message| RelayedEvent::Message {
                data: message.clone(),
                binary: false,
            })
            .collect()
    }

    /// The session whose output budget applies before confirmation.
    pub fn hold_session(&mut self, session: NkSession) {
        self.release_unconfirmed();
        self.session = Some(session);
    }

    /// A frame the channel received, in order. While paused or no longer open the frame is handed
    /// back, so a shell that already took it from the channel can keep it instead of losing it.
    /// A refused credential closes the channel and hands the frame back too.
    pub fn receive(&mut self, frame: Frame) -> Result<RelayedEvent, Frame> {
        if self.state != RelayedState::Open || self.paused {
            return Err(frame);
        }
        if !self.is_still_admitted() {
            self.terminate();
            return Err(frame);
        }
        Ok(match frame {
            Frame::Text(text) => RelayedEvent::Message {
                data: text.into_bytes(),
                binary: false,
            },
            Frame::Binary(bytes) => RelayedEvent::Message {
                data: bytes,
                binary: true,
            },
        })
    }

    /// The channel closed: the relay's own code and reason, or 1006 with what broke.
    pub fn ended(&mut self, cause: Option<&RelayError>) -> RelayedEvent {
        self.release_unconfirmed();
        self.state = RelayedState::Closed;
        let (code, reason) = ended_by(cause);
        RelayedEvent::Close { code, reason }
    }

    /// Text, deflated when the peer takes it and the caller hasn't opted out.
    pub fn send_text(&mut self, text: &str, compress: bool) -> Result<(), RelayError> {
        self.budget(text.len())?;
        let deflate = self.deflate && compress;
        self.channel.send_text(text, deflate)
    }

    /// Bytes: binary as a `ws` socket sends them, unless the caller says they are text.
    pub fn send_bytes(
        &mut self,
        bytes: &[u8],
        binary: bool,
        compress: bool,
    ) -> Result<(), RelayError> {
        self.budget(bytes.len())?;
        if binary {
            return self.channel.send_binary(bytes);
        }
        let deflate = self.deflate && compress;
        self.channel
            .send_text(&String::from_utf8_lossy(bytes), deflate)
    }

    /// Before confirmation at most 256 KiB goes out (ADR 0155). Anything past it ends the
    /// session, so nothing waits anywhere for a client that hasn't confirmed.
    fn budget(&mut self, size: usize) -> Result<(), RelayError> {
        if self.state != RelayedState::Open {
            return Err(RelayError::Protocol("Relay channel closed"));
        }
        if !self.is_still_admitted() {
            self.terminate();
            return Err(RelayError::Protocol("Device no longer admitted"));
        }
        if let Some(session) = &self.session
            && !session.output(size)
        {
            self.terminate();
            return Err(RelayError::Protocol("Unconfirmed output budget spent"));
        }
        Ok(())
    }

    /// A local close: the goodbye is queued behind earlier messages, so it arrives last; then the
    /// channel ends. The relay has no close frame, so `channel.close` carries the code.
    /// Idempotent per socket: a socket already closing keeps its own code, and returns `None`.
    pub fn close(&mut self, code: u16, reason: &str) -> Option<RelayedEvent> {
        if self.state != RelayedState::Open {
            return None;
        }
        self.state = RelayedState::Closing;
        // The frame clamps a code outside the protocol's range; the handler still sees the one
        // it asked for, as the TypeScript reports the caller's (`relay-socket.ts:187`, `:201`).
        let frame_code = if (1000..=4999).contains(&code) {
            code
        } else {
            1000
        };
        let reason = slice_utf16(reason, MAX_CLOSE_REASON);
        let mut goodbye = ace_json::Map::new();
        goodbye.insert("type", ace_json::Value::String("channel.close".into()));
        goodbye.insert("code", ace_json::Value::from(frame_code));
        goodbye.insert("reason", ace_json::Value::String(reason.clone().into()));
        let text = ace_json::to_string(&ace_json::Value::Object(goodbye));
        let _ = self.channel.send_text(&text, false);
        self.channel.close_after_flush();
        self.state = RelayedState::Closed;
        self.release_unconfirmed();
        Some(RelayedEvent::Close { code, reason })
    }

    /// Ends the channel with an abnormal 1006 and no reason.
    pub fn terminate(&mut self) -> RelayedEvent {
        self.channel.close_after_flush();
        self.state = RelayedState::Closed;
        self.release_unconfirmed();
        RelayedEvent::Close {
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
