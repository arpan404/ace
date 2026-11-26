// SPDX-License-Identifier: Apache-2.0

//! The crate's one error type. A frame that cannot be read ends its capture; a malformed
//! header, an oversized one and a truncated one carry the words the TypeScript throws.

/// Why a frame could not be read (`frames.ts:29`, `:96`, `:119`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScreenError {
    /// `framePacket`'s size check and a header past `HEADER_LIMIT`.
    #[error("Invalid frame size")]
    InvalidFrameSize,
    /// A header length of zero, or past the 4 KiB limit.
    #[error("Frame header exceeds limit")]
    HeaderExceedsLimit,
    /// A header that is not the JSON `ScreenFrameHeader` names.
    #[error("Invalid frame header")]
    InvalidHeader,
    /// A stream that ended mid-frame.
    #[error("Truncated frame")]
    Truncated,
    /// A payload that ran out before the header's `bytes` did.
    #[error("Missing frame header")]
    MissingHeader,
}
