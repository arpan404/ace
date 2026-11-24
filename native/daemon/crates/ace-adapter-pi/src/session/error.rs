// SPDX-License-Identifier: Apache-2.0
//! The two kinds of Pi command failure, ported from `rpc.ts` and the facade's
//! error mapping. A builder must never mix them up: a refused prompt can be
//! retried, an uncertain one may already have run.

/// The command was not taken: nothing reached Pi, or Pi answered `success: false`.
/// Maps to `ACE_PI_COMMAND_REFUSED` (the facade's `PiCommandRefused`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// "Pi RPC closed"
    Closed,
    /// "Pi command capacity exceeded"
    Capacity,
    /// "Pi command exceeds frame limit"
    FrameLimit,
    /// The string Pi sent with `success: false`, or "Pi command rejected".
    Rejected(String),
}

impl std::fmt::Display for Refused {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Closed => formatter.write_str("Pi RPC closed"),
            Refused::Capacity => formatter.write_str("Pi command capacity exceeded"),
            Refused::FrameLimit => formatter.write_str("Pi command exceeds frame limit"),
            Refused::Rejected(message) => formatter.write_str(message),
        }
    }
}

/// The command may have run. Maps to `ACE_PI_UNCERTAIN` (a plain Error in the
/// facade, so `send` treats it as possibly taken).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Uncertain {
    /// "Pi command timed out; execution uncertain"
    TimedOut,
    /// "Pi response command mismatch"
    Mismatch,
    /// The stdin error's node message, such as "write EPIPE".
    StdinFailed(String),
    /// "Pi RPC closed": the bytes were already handed to stdin when the wire closed.
    Closed,
    /// "JSON-RPC write queue exceeded limit"
    WriteQueueFull,
    /// "JSON-RPC stdin closed"
    StdinClosed,
}

impl std::fmt::Display for Uncertain {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Uncertain::TimedOut => formatter.write_str("Pi command timed out; execution uncertain"),
            Uncertain::Mismatch => formatter.write_str("Pi response command mismatch"),
            Uncertain::StdinFailed(message) => formatter.write_str(message),
            Uncertain::Closed => formatter.write_str("Pi RPC closed"),
            Uncertain::WriteQueueFull => formatter.write_str("JSON-RPC write queue exceeded limit"),
            Uncertain::StdinClosed => formatter.write_str("JSON-RPC stdin closed"),
        }
    }
}

/// A failed command, in the one of the two kinds the wire decided it is.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PiError {
    #[error("{0}")]
    Refused(Refused),
    #[error("{0}")]
    Uncertain(Uncertain),
}

impl PiError {
    /// A failure whose bytes never reached Pi.
    pub fn refused(kind: Refused) -> PiError {
        PiError::Refused(kind)
    }

    /// A failure whose command may have run.
    pub fn uncertain(kind: Uncertain) -> PiError {
        PiError::Uncertain(kind)
    }
}
