// SPDX-License-Identifier: Apache-2.0
//! The relay's typed failures. A relayed stream's close carries its own code and reason, which
//! `RelayStreamClosed` holds; anything else that breaks is `Failed`.

use thiserror::Error;

#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum RelayError {
    /// The stream ended with the relay's own code and reason (`RelayStreamClosed`).
    #[error("{reason}")]
    Closed { code: u16, reason: String },
    /// A frame that isn't the protocol's.
    #[error("{0}")]
    Protocol(&'static str),
    /// A Noise handshake or transport message that doesn't hold.
    #[error("{0}")]
    Noise(&'static str),
    /// A pair of digits that isn't a relay address.
    #[error("invalid relay address: {0}")]
    Address(String),
}

impl RelayError {
    /// The close a reader sees: the relay's own, or an abnormal 1006 with what broke
    /// (`relay-socket.ts:59`).
    pub fn ended_by(&self) -> (u16, String) {
        match self {
            Self::Closed { code, reason } => (*code, reason.clone()),
            other => (1006, other.to_string().chars().take(123).collect()),
        }
    }
}
