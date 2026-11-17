// SPDX-License-Identifier: Apache-2.0

//! The framed JSON protocol between the daemon and `ace-files`.
//!
//! A frame starts with a `u32` little-endian length: the byte count of everything after it, that
//! is the kind byte plus the payload. Kind `1` is a UTF-8 JSON [`Message`]. Kind `2` is a binary
//! body: a `u64` little-endian id followed by raw bytes, belonging to the JSON message with that
//! id whose result says `"body": true` (a `read` response) and holding at most [`MAX_BODY_LEN`]
//! bytes. No frame may declare more than [`MAX_FRAME_LEN`] bytes; a longer one is an error, never a
//! truncated frame.
//!
//! ```
//! use files_wire::{Decoder, Frame, Message, Op, encode};
//!
//! let message = Message::Request {
//!     id: 1,
//!     op: Op::Stat { root: 1, path: "src/lib.rs".to_owned() },
//! };
//! let bytes = encode(&message).expect("a stat request fits a frame");
//! let mut decoder = Decoder::new();
//! decoder.push(&bytes);
//! assert_eq!(decoder.poll().expect("valid frame"), Some(Frame::Message(message)));
//! ```
//!
//! Ids, subscriptions and roots are `u64`. Ids and subscriptions are handed out sequentially and
//! stay below 2^53, so `JSON.parse` in the daemon and the clients reads them exactly. Sizes,
//! offsets, line numbers and byte counts are `u64` for the same reason.
//!
//! Optional fields are left out of the JSON when they are absent. Unknown fields in incoming JSON
//! are ignored, so either side can add one without a protocol bump. Every nested value is tagged
//! too: a response's `result.type` says which op it answers, an event payload's `type` says which
//! event it is, and a listed entry's `kind.type` is `file`, `directory`, `symlink` or `other`.
//!
//! A kind-1 payload that does not parse still yields its request `id` through [`Error::id`], and
//! an op tag this build does not know comes back as `UNSUPPORTED`, so an older binary answers the
//! request instead of hanging on it.

mod error;
mod event;
mod files;
mod frame;
mod message;
mod op;
mod reply;

pub use error::Error;
pub use event::{Change, ChangeKind, EventPayload};
pub use files::{
    Case, Entry, FileMatches, Hit, IndexResult, Kind, LineMatch, Page, ReadMeta, SearchQuery,
    Summary,
};
pub use frame::{Decoder, Frame, MAX_BODY_LEN, MAX_FRAME_LEN, encode, encode_body};
pub use message::{Message, PROTOCOL};
pub use op::Op;
pub use reply::Reply;
