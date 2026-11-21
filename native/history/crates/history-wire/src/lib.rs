// SPDX-License-Identifier: Apache-2.0

//! The protocol between the daemon and `ace-history` (ADR 0207).
//!
//! Framing is files-wire's: a `u32` little-endian length covering a kind byte and the payload,
//! then kind 1 (UTF-8 JSON) or kind 2 (`u64` little-endian message id, then raw bytes). The JSON
//! messages are the ones the TypeScript reader worker already exchanged with the daemon; a byte
//! array inside one travels as a body frame sent just before it with the same id, and appears in
//! the JSON as `{"$body": n}`, the n-th body of that message.

mod depth;
mod frame;
mod message;

pub use depth::{WIRE_DEPTH, nesting, parse_within};
pub use frame::{Decoder, Frame, MAX_FRAME_LEN, encode_body, encode_json};
pub use message::{
    ArchiveCommand, BlobRequest, ImportInit, Inbound, ListBefore, ListRequest, PageRequest,
    Request, body_ref, take_body_index,
};

/// Why a frame or message could not be read.
#[derive(Debug, thiserror::Error)]
pub enum WireError {
    #[error("frame of {0} bytes exceeds the 16 MiB limit")]
    TooLarge(u64),
    #[error("empty frame")]
    Empty,
    #[error("unknown frame kind {0}")]
    UnknownKind(u8),
    #[error("truncated body frame")]
    Truncated,
    #[error("unreadable message: {0}")]
    Json(#[from] serde_json::Error),
}
