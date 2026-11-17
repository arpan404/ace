// SPDX-License-Identifier: Apache-2.0

//! Framing and decoding failures.

/// The opening of the message an unknown op produces. It is how [`Error::code`] tells a newer
/// op apart from a message that is simply broken.
pub(crate) const UNKNOWN_OP: &str = "unknown op";

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
    /// A message that could not be read, or one that could not be written.
    ///
    /// The id is recovered from the bytes even when the rest of the message makes no sense, so the
    /// daemon can fail the request it asked about instead of leaving it hanging.
    #[error("invalid message: {source}")]
    Message {
        /// The request id the payload still carried, when it carried a readable one.
        id: Option<u64>,
        /// What serde said about the payload.
        source: serde_json::Error,
    },
}

impl Error {
    /// The stable error code the daemon reports to its clients.
    pub fn code(&self) -> &'static str {
        match self {
            Error::FrameTooLarge { .. } => "TOO_LARGE",
            Error::UnknownKind(_) => "UNSUPPORTED",
            Error::Message { source, .. } if source.to_string().starts_with(UNKNOWN_OP) => {
                "UNSUPPORTED"
            }
            Error::EmptyFrame | Error::TruncatedBody { .. } | Error::Message { .. } => {
                "INVALID_ARGUMENT"
            }
        }
    }

    /// The request id a failed message still carried, so the daemon can answer that request.
    pub fn id(&self) -> Option<u64> {
        match self {
            Error::Message { id, .. } => *id,
            Error::FrameTooLarge { .. }
            | Error::EmptyFrame
            | Error::UnknownKind(_)
            | Error::TruncatedBody { .. } => None,
        }
    }
}
