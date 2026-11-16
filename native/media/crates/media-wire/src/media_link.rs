// SPDX-License-Identifier: Apache-2.0
//! What crosses a client's media connection (ADR 0147 §4, docs/media/plan.md "Clients"), direct
//! or relayed. The client-facing copy is `packages/protocol/src/media-stream.ts`; the shared
//! vectors in `vectors/media-link/` keep the two the same.
//!
//! - **Hello.** The client's first message is binary, [`HELLO_BYTES`] long: `"ACEC"`, a version
//!   byte (1) and the 32-byte ticket. On a relay stream the relay channel's own hello carries the
//!   ticket instead.
//! - **Server to client.** Binary `ACES` stream pieces, and text [`ServerMessage`]s.
//! - **Client to server.** Text [`ClientMessage`]s: acks and pings. A client's message is
//!   outside data, so fields this build doesn't know are ignored; a type it doesn't know, or one
//!   a media connection doesn't take, closes the connection with [`close::PROTOCOL`].
use crate::control::{Id, Sequence, present};
use serde::{Deserialize, Serialize};

pub const HELLO_MAGIC: [u8; 4] = *b"ACEC";
pub const HELLO_VERSION: u8 = 1;
pub const TICKET_BYTES: usize = 32;
pub const HELLO_BYTES: usize = 4 + 1 + TICKET_BYTES;

/// WebSocket close codes a media connection ends with.
pub mod close {
    /// ace-media is stopping: the client reopens with a new `media.connect`.
    pub const GOING_AWAY: u16 = 1001;
    /// The client sent something a media connection doesn't take.
    pub const PROTOCOL: u16 = 4400;
    /// The hello wasn't a valid, unused, unexpired ticket.
    pub const REFUSED: u16 = 4401;
    /// The device's credential or admission was revoked.
    pub const REVOKED: u16 = 4403;
    /// No hello within the deadline.
    pub const HELLO_TIMEOUT: u16 = 4408;
    /// The owning main session closed, or the daemon closed the connection.
    pub const CLOSED: u16 = 4410;
}

#[derive(Debug, PartialEq, Eq)]
pub struct BadHello;

/// The ticket a hello carries. Anything but exactly a version-1 hello is refused.
pub fn hello_ticket(bytes: &[u8]) -> Result<&[u8], BadHello> {
    if bytes.len() != HELLO_BYTES || bytes[..4] != HELLO_MAGIC || bytes[4] != HELLO_VERSION {
        return Err(BadHello);
    }
    Ok(&bytes[5..])
}

/// A hello for `ticket`; for clients and tests.
pub fn hello(ticket: &[u8; TICKET_BYTES]) -> [u8; HELLO_BYTES] {
    let mut out = [0; HELLO_BYTES];
    out[..4].copy_from_slice(&HELLO_MAGIC);
    out[4] = HELLO_VERSION;
    out[5..].copy_from_slice(ticket);
    out
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    /// The browser's ack: video chunks shown up to `sequence`, cumulatively.
    #[serde(rename = "browser.ack")]
    BrowserAck {
        #[serde(rename = "threadId")]
        thread_id: Id,
        #[serde(rename = "sequence")]
        sequence: Sequence,
        #[serde(
            rename = "video",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        video: Option<bool>,
        /// The decoder lost its place: send a keyframe.
        #[serde(
            rename = "keyframe",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        keyframe: Option<bool>,
    },
    #[serde(rename = "screen.ack")]
    ScreenAck {
        #[serde(rename = "sessionId")]
        session_id: Id,
        #[serde(rename = "streamId")]
        stream_id: Id,
        #[serde(rename = "sequence")]
        sequence: Sequence,
        #[serde(
            rename = "keyframe",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        keyframe: Option<bool>,
    },
    #[serde(rename = "devices.ack")]
    DevicesAck {
        #[serde(rename = "deviceId")]
        device_id: Id,
        #[serde(rename = "streamId")]
        stream_id: Id,
        #[serde(rename = "sequence")]
        sequence: Sequence,
        #[serde(
            rename = "keyframe",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        keyframe: Option<bool>,
    },
    /// With the round trip the client measured on this connection, when it has one.
    #[serde(rename = "ping")]
    Ping {
        #[serde(
            rename = "rttMs",
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        rtt_ms: Option<u32>,
    },
}

impl ClientMessage {
    /// A text message from a client; `None` closes the connection.
    pub fn parse(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum ServerMessage {
    /// The hello was accepted.
    #[serde(rename = "media.welcome")]
    Welcome {
        #[serde(rename = "connection")]
        connection: Id,
    },
    #[serde(rename = "pong")]
    Pong,
}
