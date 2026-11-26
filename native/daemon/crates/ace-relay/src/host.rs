// SPDX-License-Identifier: Apache-2.0
//! The daemon's host control session with a relay (`apps/relay/src/host.ts`, `config.ts`,
//! `admission.ts`): its registration and the generation a client waits for, the retry backoff, the
//! control messages the relay sends, the client slots that bound how many channels one host
//! admits, the forwarded-HTTP answer, and the first-message rule each client channel follows. The
//! sockets and the Noise session are the shell's; these are the decisions.

use ace_json::Value;

use crate::error::RelayError;
use crate::noise::KeyPair;

pub mod backoff;
pub mod link;

pub use backoff::Backoff;

/// The `/host` `features` value a daemon sends when it serves forwarded HTTP requests.
pub const HTTP_FEATURE: &str = "http";
/// The `/host` `features` value a daemon sends when it takes media streams (ADR 0147 §5.2).
pub const MEDIA_FEATURE: &str = "media";

/// A relay host id: 52 uppercase base32 characters.
pub fn valid_host_id(text: &str) -> bool {
    text.len() == 52
        && text
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte))
}

/// A ticket: 64 lowercase hex characters.
pub fn valid_ticket(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The host's own options (`HostOptionsSchema`), with its defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostOptions {
    pub max_client_channels: usize,
    pub hello_timeout_ms: i64,
    pub handshake_timeout_ms: i64,
    pub idle_timeout_ms: i64,
    pub ping_interval_ms: i64,
    pub retry_initial_ms: i64,
    pub retry_max_ms: i64,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self {
            max_client_channels: 64,
            hello_timeout_ms: 10_000,
            handshake_timeout_ms: 10_000,
            idle_timeout_ms: 25_000,
            ping_interval_ms: 10_000,
            retry_initial_ms: 250,
            retry_max_ms: 5_000,
        }
    }
}

impl HostOptions {
    /// The schema's refinements: a channel cap of at most 1024, and a retry floor no higher than
    /// its ceiling.
    pub fn valid(&self) -> Result<(), RelayError> {
        if self.max_client_channels == 0 || self.max_client_channels > 1_024 {
            return Err(RelayError::Protocol("Invalid client channel limit"));
        }
        if self.retry_initial_ms > self.retry_max_ms {
            return Err(RelayError::Protocol("Retry initial exceeds maximum"));
        }
        Ok(())
    }
}

/// What the relay sends over the encrypted registration session (`ControlMessage`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ControlMessage {
    Registered {
        host_id: String,
    },
    /// `media`: a media stream the host hands to ace-media rather than joining here.
    Client {
        ticket: String,
        media: bool,
    },
    Http {
        ticket: String,
    },
}

impl ControlMessage {
    /// A message this daemon doesn't know ends the session: older daemons drop it on anything
    /// they don't know, so the relay sends `http` and `media` only to hosts that registered them.
    pub fn parse(value: &Value) -> Result<Self, RelayError> {
        let object = value
            .as_object()
            .ok_or(RelayError::Protocol("Invalid control message"))?;
        let field = |key: &str| object.get(key).and_then(Value::as_str);
        match field("type") {
            Some("registered") => {
                let host_id = field("hostId")
                    .filter(|text| valid_host_id(text))
                    .ok_or(RelayError::Protocol("Invalid registration"))?;
                Ok(Self::Registered {
                    host_id: host_id.to_owned(),
                })
            }
            Some("client") => {
                let ticket = field("ticket")
                    .filter(|text| valid_ticket(text))
                    .ok_or(RelayError::Protocol("Invalid client ticket"))?;
                match object.get("purpose") {
                    None => Ok(Self::Client {
                        ticket: ticket.to_owned(),
                        media: false,
                    }),
                    Some(Value::String(purpose)) if purpose.as_str() == "media" => {
                        Ok(Self::Client {
                            ticket: ticket.to_owned(),
                            media: true,
                        })
                    }
                    Some(_) => Err(RelayError::Protocol("Invalid client ticket")),
                }
            }
            Some("http") => {
                let ticket = field("ticket")
                    .filter(|text| valid_ticket(text))
                    .ok_or(RelayError::Protocol("Invalid http ticket"))?;
                Ok(Self::Http {
                    ticket: ticket.to_owned(),
                })
            }
            _ => Err(RelayError::Protocol("Invalid control message")),
        }
    }
}

/// Why a host turns a ticket down (`HostControlMessage`): `off` for a path the person hasn't
/// turned on, `busy` at its limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectReason {
    Off,
    Busy,
}

impl RejectReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Busy => "busy",
        }
    }

    /// The message the relay reads, as a text frame's JSON.
    pub fn message(self, ticket: &str) -> String {
        let mut message = ace_json::Map::new();
        message.insert("type", Value::String("reject".into()));
        message.insert("ticket", Value::String(ticket.into()));
        message.insert("reason", Value::String(self.as_str().into()));
        ace_json::to_string(&Value::Object(message))
    }
}

/// What taking an `http` ticket did (`httpAnswer`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpAnswer {
    Open,
    Off,
    Busy,
}

/// Whether to take an `http` ticket: the path must be on, and the host under its concurrent cap.
pub fn http_answer(enabled: bool, active: usize, max_concurrent: Option<usize>) -> HttpAnswer {
    if !enabled {
        return HttpAnswer::Off;
    }
    if active >= max_concurrent.unwrap_or(32) {
        return HttpAnswer::Busy;
    }
    HttpAnswer::Open
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SlotState {
    Pending,
    Authorized,
}

/// Pending Noise and device-authentication slots may be evicted; authorized devices may not
/// (`ClientSlots`).
#[derive(Debug, Clone)]
pub struct ClientSlots {
    slots: Vec<(String, SlotState)>,
    limit: usize,
}

/// What reserving a ticket did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reservation {
    pub accepted: bool,
    /// The pending channel this reservation evicted (its ticket), if any.
    pub evicted: Option<String>,
}

impl ClientSlots {
    pub fn new(limit: usize) -> Self {
        Self {
            slots: Vec::new(),
            limit,
        }
    }

    pub fn len(&self) -> usize {
        self.slots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.slots.is_empty()
    }

    /// Takes a slot for `id`, evicting the oldest pending channel when full. A host whose slots
    /// are all authorized refuses the ticket.
    pub fn reserve(&mut self, id: &str) -> Reservation {
        let mut evicted = None;
        if self.slots.len() >= self.limit {
            let pending = self
                .slots
                .iter()
                .position(|(_, state)| *state == SlotState::Pending);
            let Some(index) = pending else {
                return Reservation {
                    accepted: false,
                    evicted: None,
                };
            };
            evicted = Some(self.slots.remove(index).0);
        }
        self.slots.push((id.to_owned(), SlotState::Pending));
        Reservation {
            accepted: true,
            evicted,
        }
    }

    /// The device hello arrived: the channel may no longer be evicted.
    pub fn authorize(&mut self, id: &str) -> Result<(), RelayError> {
        let Some((_, state)) = self.slots.iter_mut().find(|(each, _)| each == id) else {
            return Err(RelayError::Protocol("Channel expired"));
        };
        *state = SlotState::Authorized;
        Ok(())
    }

    pub fn release(&mut self, id: &str) {
        self.slots.retain(|(each, _)| each != id);
    }
}

/// A client's first message on its channel, as the host checks it before the daemon's handlers
/// see it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstMessage {
    /// After an NK answer: the client's first message is its confirmation.
    Confirmation,
    /// The channel's hello.
    Hello,
    /// A pairing redemption, answered and closed by the daemon; it never authorizes.
    PairRedeem,
}

/// Check a first message's `type`. `redemption_seen` is whether a `pair.redeem` was already let
/// through on this channel.
pub fn first_message(
    nk: bool,
    redemption_seen: bool,
    message_type: Option<&str>,
) -> Result<FirstMessage, RelayError> {
    if nk {
        return if message_type == Some("hello.confirm") {
            Ok(FirstMessage::Confirmation)
        } else {
            Err(RelayError::Protocol("First message must be hello.confirm"))
        };
    }
    match message_type {
        Some("pair.redeem") if !redemption_seen => Ok(FirstMessage::PairRedeem),
        Some("hello") if !redemption_seen => Ok(FirstMessage::Hello),
        _ => Err(RelayError::Protocol("First message must be hello")),
    }
}

/// Authorization, once the device hello has been read.
pub fn authorize_first(seen_hello: bool, aborted: bool) -> Result<(), RelayError> {
    if !seen_hello {
        return Err(RelayError::Protocol("Device hello has not been received"));
    }
    if aborted {
        return Err(RelayError::Protocol("Channel expired"));
    }
    Ok(())
}

/// The registration generation and the clients waiting for the next one (`whenRegistered`).
#[derive(Debug, Clone, Default)]
pub struct Registration {
    generation: u64,
    waiters: Vec<u64>,
    closed: bool,
}

/// What `when_registered` answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistrationWait {
    /// Already at or past the wanted generation.
    Ready(u64),
    /// Queued; the index is the waiter's place.
    Waiting(usize),
    /// The host connection closed.
    Closed,
    /// Too many waiters: the caller must ask again later.
    TooMany,
}

impl Registration {
    /// The relay confirmed this host: a new generation, and every waiter it satisfies resolves.
    pub fn registered(&mut self, host_id: &str, expected: &str) -> Result<Vec<u64>, RelayError> {
        if host_id != expected {
            return Err(RelayError::Protocol("Invalid registration"));
        }
        self.generation += 1;
        let generation = self.generation;
        let ready: Vec<u64> = self
            .waiters
            .iter()
            .filter(|after| generation > **after)
            .copied()
            .collect();
        self.waiters.retain(|after| generation <= *after);
        Ok(ready)
    }

    /// A confirmed registration was lost: the next one is a new generation.
    pub fn lost(&mut self) -> u64 {
        self.generation
    }

    pub fn when_registered(&mut self, after: u64) -> RegistrationWait {
        if self.closed {
            return RegistrationWait::Closed;
        }
        if self.generation > after {
            return RegistrationWait::Ready(self.generation);
        }
        if self.waiters.len() >= 1_024 {
            return RegistrationWait::TooMany;
        }
        self.waiters.push(after);
        RegistrationWait::Waiting(self.waiters.len() - 1)
    }

    pub fn close(&mut self) {
        self.closed = true;
        self.waiters.clear();
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn waiting(&self) -> usize {
        self.waiters.len()
    }
}

/// This host's id, derived from the key pair it registers with.
pub fn host_id(keys: &KeyPair) -> String {
    keys.host_id()
}

#[cfg(test)]
mod tests;
