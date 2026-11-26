// SPDX-License-Identifier: Apache-2.0
//! What one peer input returns (`jsonrpc.ts`): the frame, the write and the settlement,
//! in the order the state changed, and the config the peer starts from.
use std::fmt;

use crate::budget::StreamError;
use crate::jsonrpc::RpcId;
use ace_json::{JsString, Value};

use super::{DEFAULT_MAX_INCOMING, DEFAULT_TIMEOUT_MS};

/// Which side of the pipe a frame came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Send,
    Recv,
}

/// A refusal or a rejection, by the message the shell shows. A response's
/// `error` is its `JSON.stringify` text, so `error_code` reads it unchanged.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PeerError {
    message: String,
}

impl PeerError {
    pub fn new(message: impl Into<String>) -> PeerError {
        PeerError {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl From<StreamError> for PeerError {
    fn from(error: StreamError) -> PeerError {
        PeerError::new(error.to_string())
    }
}

/// The effects of one input, in the order the state changed. A `recv` frame
/// precedes the effect it causes, as `onFrame` precedes dispatch today.
pub enum PeerEffect {
    /// The whole parsed frame, unredacted: the session redacts it.
    Frame {
        dir: Direction,
        value: Value,
        /// The frame's JSON line as it went on or came off the pipe, when
        /// `PeerConfig::frame_text` asks for it: what a consumer publishes verbatim.
        text: Option<String>,
    },
    /// One line for stdin, and the ticket `written` names when the pipe took it.
    Write {
        wire: Vec<u8>,
        ticket: u64,
    },
    /// Settles the facade's promise `id`, once.
    Settle {
        id: u64,
        result: Result<Value, PeerError>,
    },
    ServerRequest {
        id: RpcId,
        method: JsString,
        /// Absent when the line had no `params`, as `undefined` is today.
        params: Option<Value>,
    },
    Notification {
        /// The frame's `params` are not copied here: the `Frame` effect of the same line
        /// carries them once (`peer.rs:line`).
        method: JsString,
    },
    /// The line was not a JSON-RPC envelope, or not JSON at all.
    Malformed {
        line: String,
    },
    ArmTimer {
        key: String,
        ms: f64,
    },
    CancelTimer {
        key: String,
    },
    /// `onError`: reported, never a settlement.
    Failed {
        message: String,
    },
}

impl fmt::Debug for PeerEffect {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PeerEffect::Frame { dir, value, text } => formatter
                .debug_struct("Frame")
                .field("dir", dir)
                .field("value", &value.to_json())
                .field("text", text)
                .finish(),
            PeerEffect::Write { wire, ticket } => formatter
                .debug_struct("Write")
                .field("ticket", ticket)
                .field("wire", &String::from_utf8_lossy(wire))
                .finish(),
            PeerEffect::Settle { id, result } => formatter
                .debug_struct("Settle")
                .field("id", id)
                .field("result", result)
                .finish(),
            PeerEffect::ServerRequest { id, method, params } => formatter
                .debug_struct("ServerRequest")
                .field("id", id)
                .field("method", method)
                .field("params", &params.as_ref().map(Value::to_json))
                .finish(),
            PeerEffect::Notification { method } => formatter
                .debug_struct("Notification")
                .field("method", method)
                .finish(),
            PeerEffect::Malformed { line } => formatter
                .debug_struct("Malformed")
                .field("line", line)
                .finish(),
            PeerEffect::ArmTimer { key, ms } => formatter
                .debug_struct("ArmTimer")
                .field("key", key)
                .field("ms", ms)
                .finish(),
            PeerEffect::CancelTimer { key } => formatter
                .debug_struct("CancelTimer")
                .field("key", key)
                .finish(),
            PeerEffect::Failed { message } => formatter
                .debug_struct("Failed")
                .field("message", message)
                .finish(),
        }
    }
}

/// What `RpcPeer::new` needs. `timeout_ms: None` leaves requests without a
/// default deadline (`jsonrpc.ts`'s `null`); the default is 30 s.
pub struct PeerConfig {
    pub timeout_ms: Option<f64>,
    pub max_pending: usize,
    pub max_queued_bytes: usize,
    /// `maxIncomingRequests`: 128 for a dedicated pipe, 512 for a shared host.
    pub max_incoming: usize,
    /// Carry each frame's own line on `PeerEffect::Frame`, for a consumer that publishes
    /// the frame as text: ACP shows every line, and the line already is that JSON, so it
    /// needs neither the text re-serialized from the tree nor the copy. A consumer that
    /// reads the tree only (codex) leaves this off and copies nothing.
    pub frame_text: bool,
}

impl Default for PeerConfig {
    fn default() -> PeerConfig {
        PeerConfig {
            timeout_ms: Some(DEFAULT_TIMEOUT_MS),
            max_pending: 256,
            max_queued_bytes: 32 * 1024 * 1024,
            max_incoming: DEFAULT_MAX_INCOMING,
            frame_text: false,
        }
    }
}

/// `RequestOptions.timeoutMs`: absent, an explicit `null`, or a value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Timeout {
    Default,
    Disabled,
    After(f64),
}
