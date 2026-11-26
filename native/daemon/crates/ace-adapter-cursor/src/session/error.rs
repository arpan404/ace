// SPDX-License-Identifier: Apache-2.0
//! The Cursor session's typed errors, mapped to JS in the binding. The messages that reach the
//! host are `host.ts`'s or the bound walk's, string for string; the envelope's zod issue text is
//! not reproduced, so its message names the first field that did not fit.

use ace_supervisor::peer::PeerError;

use super::bounded::BoundedError;

/// The one code a peer failure crosses to the caller with: its message is the reply's error
/// JSON, which `refusedByHost` and `discoveryFailureCode` read (`host-refusal.ts:9`-`:15`).
pub const ACE_CURSOR_RPC: &str = "ACE_CURSOR_RPC";

/// A failure as it crosses with a settlement: the code the caller registers and the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostErrorWire {
    pub code: &'static str,
    pub message: String,
}

/// Why one input could not be taken.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SessionError {
    /// `boundedJson`'s own messages (`provider-kit/src/ipc.ts`).
    #[error("{0}")]
    Bound(#[from] BoundedError),
    /// `Envelope.safeParse` failed; the field named is the first one that did not fit.
    #[error("Invalid Cursor SDK frame: {0}")]
    Envelope(&'static str),
    /// `unbatch`'s message (`frame-batch.ts:147`).
    #[error("Malformed SDK frame batch")]
    MalformedBatch,
    /// `Limits.parse` failed (`contracts.ts:17`-`:30`).
    #[error("Invalid Cursor SDK limits: {0}")]
    Limits(String),
    /// `host.ts:150`: a frame from another generation never enters this session.
    #[error("SDK generation mismatch")]
    GenerationMismatch,
    /// `host.ts:174`: a login URL must be https and bounded.
    #[error("Unsafe login URL")]
    UnsafeLoginUrl,
    /// `host.ts:159`: the host may only ask for `frame`.
    #[error("Unknown SDK host request")]
    UnknownRequest,
    /// `host.ts:177`: the host may only notify `login-url` or `frame`.
    #[error("Unknown host notification")]
    UnknownNotification,
    /// The peer's refusal or settlement failure, by its message.
    #[error("{0}")]
    Peer(String),
}

impl SessionError {
    /// The message the host receives in a reply or in its own logs.
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl From<PeerError> for SessionError {
    fn from(error: PeerError) -> SessionError {
        SessionError::Peer(error.message().to_owned())
    }
}
