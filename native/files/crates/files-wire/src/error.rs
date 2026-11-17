// SPDX-License-Identifier: Apache-2.0

//! Framing and decoding failures.

/// Something the wire cannot carry or cannot read.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A frame declares more bytes than [`MAX_FRAME_LEN`](crate::MAX_FRAME_LEN).
    #[error("frame of {length} bytes exceeds the 16 MiB limit")]
    FrameTooLarge {
        /// The declared length: kind byte plus payload.
        length: u64,
    },
    /// A frame declared a length of zero, leaving no room for its kind byte.
    #[error("frame declares no kind byte")]
    EmptyFrame,
    /// The kind byte is neither JSON (`1`) nor a body (`2`).
    #[error("unknown frame kind {0}")]
    UnknownKind(u8),
    /// A body frame's payload is shorter than the `u64` id it must start with.
    #[error("body frame of {length} payload bytes has no room for a request id")]
    TruncatedBody {
        /// Payload bytes after the kind byte.
        length: u64,
    },
    /// The JSON message is malformed, has an unknown message type or an unknown op.
    #[error("invalid message: {0}")]
    Json(#[from] serde_json::Error),
}

impl Error {
    /// The stable error code the daemon reports to its clients.
    pub fn code(&self) -> &'static str {
        match self {
            Error::FrameTooLarge { .. } => "TOO_LARGE",
            Error::UnknownKind(_) => "UNSUPPORTED",
            Error::EmptyFrame | Error::TruncatedBody { .. } | Error::Json(_) => "INVALID_ARGUMENT",
        }
    }
}
