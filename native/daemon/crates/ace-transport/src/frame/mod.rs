// SPDX-License-Identifier: Apache-2.0
//! The WebSocket wire (RFC 6455 §5), written here rather than borrowed so the
//! same framing can carry an extension T1b.3b adds. `read` turns bytes into one
//! frame at a time, `assemble` joins a message's fragments as they arrive, and
//! `write` puts one unmasked FIN frame on the wire per message. Nothing here
//! knows an ace message; a payload is bytes.

use std::fmt;
use std::io;

pub mod assemble;
pub mod header;
pub mod read;
pub mod write;

#[cfg(test)]
mod tests;

pub use assemble::{Assembler, MessageBody, Plain};
pub use read::FrameReader;
pub use write::FrameWriter;

/// `maxPayload` (`server.ts:252`): one inbound message, after any inflation.
pub const MAX_MESSAGE_BYTES: usize = 1 << 20;

/// A frame's kind. Reserved opcodes are refused while the header is parsed, so
/// every frame that reaches this type has one of these.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opcode {
    Continuation,
    Text,
    Binary,
    Close,
    Ping,
    Pong,
}

impl Opcode {
    pub fn from_code(code: u8) -> Option<Self> {
        match code {
            0x0 => Some(Self::Continuation),
            0x1 => Some(Self::Text),
            0x2 => Some(Self::Binary),
            0x8 => Some(Self::Close),
            0x9 => Some(Self::Ping),
            0xa => Some(Self::Pong),
            _ => None,
        }
    }

    pub fn code(self) -> u8 {
        match self {
            Self::Continuation => 0x0,
            Self::Text => 0x1,
            Self::Binary => 0x2,
            Self::Close => 0x8,
            Self::Ping => 0x9,
            Self::Pong => 0xa,
        }
    }

    pub fn is_control(self) -> bool {
        matches!(self, Self::Close | Self::Ping | Self::Pong)
    }

    pub fn is_data(self) -> bool {
        !self.is_control()
    }
}

/// One frame, unmasked, as the server reads it or writes it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub fin: bool,
    pub rsv1: bool,
    pub opcode: Opcode,
    /// The fragment's bytes, taken from the reader's buffer without a copy.
    pub payload: bytes::Bytes,
}

/// One frame for the wire. No client mask: the daemon is always the server.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outbound {
    pub opcode: Opcode,
    pub rsv1: bool,
    pub payload: bytes::Bytes,
}

/// The close code a rule fails with, as RFC 6455 §7.4.1 defines it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseCode {
    /// 1002: a protocol violation.
    Protocol,
    /// 1009: a message over [`MAX_MESSAGE_BYTES`].
    TooBig,
    /// 1007: text or a close reason that is not UTF-8.
    InvalidUtf8,
    /// 1007: a compressed message whose deflate stream does not decode
    /// (`permessage-deflate.js:528`).
    BadDeflate,
    /// 1008: a message with more than 16,384 fragments.
    TooManyFragments,
}

impl CloseCode {
    /// The number the close frame carries.
    pub fn wire(self) -> u16 {
        match self {
            Self::Protocol => 1002,
            Self::TooBig => 1009,
            Self::InvalidUtf8 | Self::BadDeflate => 1007,
            Self::TooManyFragments => 1008,
        }
    }

    /// `ws`'s `error.code` word for the event the shell sees.
    pub fn error_code(self) -> &'static str {
        match self {
            Self::Protocol | Self::InvalidUtf8 | Self::BadDeflate | Self::TooManyFragments => {
                "protocol"
            }
            Self::TooBig => "too_big",
        }
    }

    /// `ws`'s words for the rule that failed.
    pub fn message(self) -> &'static str {
        match self {
            Self::Protocol => "Invalid WebSocket frame: protocol violation",
            Self::TooBig => "Max payload size exceeded",
            Self::InvalidUtf8 => "Invalid WebSocket frame: invalid UTF-8 sequence",
            Self::BadDeflate => "Invalid WebSocket frame: invalid compressed payload",
            Self::TooManyFragments => "Too many message fragments",
        }
    }
}

/// Why a frame could not be read.
#[derive(Debug)]
pub enum FrameError {
    /// A violation of RFC 6455's framing rules: `ws` closes with 1002.
    Protocol(String),
    /// A message or a declared length over the limit: `ws` closes with 1009.
    TooBig(String),
    /// Text, or a close reason, that is not UTF-8: `ws` closes with 1007.
    InvalidUtf8(String),
    /// A compressed message whose deflate stream does not decode: `ws` closes
    /// with 1007 (`permessage-deflate.js:528`).
    Compression(String),
    /// More than 16,384 fragments in one message: `ws` closes with 1008.
    TooManyFragments(String),
    /// The connection failed; nothing more can be written to it.
    Io(io::Error),
}

impl FrameError {
    pub fn protocol(message: impl Into<String>) -> Self {
        Self::Protocol(message.into())
    }

    pub fn too_big(message: impl Into<String>) -> Self {
        Self::TooBig(message.into())
    }

    /// The word the shell reports on the socket's `error` event.
    pub fn error_code(&self) -> &'static str {
        match self {
            Self::Protocol(_)
            | Self::InvalidUtf8(_)
            | Self::Compression(_)
            | Self::TooManyFragments(_) => "protocol",
            Self::TooBig(_) => "too_big",
            Self::Io(_) => "io",
        }
    }

    /// The code of the close frame `ws` sends for this failure, if it sends one.
    pub fn close_code(&self) -> Option<u16> {
        match self {
            Self::Protocol(_) => Some(1002),
            Self::TooBig(_) => Some(1009),
            Self::InvalidUtf8(_) | Self::Compression(_) => Some(1007),
            Self::TooManyFragments(_) => Some(1008),
            Self::Io(_) => None,
        }
    }
}

impl From<CloseCode> for FrameError {
    fn from(code: CloseCode) -> Self {
        match code {
            CloseCode::Protocol => Self::protocol(code.message()),
            CloseCode::TooBig => Self::too_big(code.message()),
            CloseCode::InvalidUtf8 => Self::InvalidUtf8(code.message().to_owned()),
            CloseCode::BadDeflate => Self::Compression(code.message().to_owned()),
            CloseCode::TooManyFragments => Self::TooManyFragments(code.message().to_owned()),
        }
    }
}

impl From<io::Error> for FrameError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl fmt::Display for FrameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(message)
            | Self::TooBig(message)
            | Self::InvalidUtf8(message)
            | Self::Compression(message)
            | Self::TooManyFragments(message) => formatter.write_str(message),
            Self::Io(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for FrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            _ => None,
        }
    }
}
