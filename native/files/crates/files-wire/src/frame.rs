// SPDX-License-Identifier: Apache-2.0

//! Frame encoding and the incremental decoder.

use serde::Deserialize;
use serde::de::Error as _;
use serde_json::Value;

use crate::error::{Error, UNKNOWN_OP};
use crate::message::Message;
use crate::op;

/// The largest length a frame may declare: the kind byte plus the payload. A bigger declaration is
/// an error, so a corrupt stream cannot make either side allocate without bound.
pub const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;

/// The largest body a kind-2 frame can carry: [`MAX_FRAME_LEN`] less the kind byte and the id.
pub const MAX_BODY_LEN: u32 = MAX_FRAME_LEN - 9;

/// Kind byte of a UTF-8 JSON [`Message`].
const JSON_KIND: u8 = 1;
/// Kind byte of a binary body: `u64` little-endian id, then bytes.
const BODY_KIND: u8 = 2;
/// Bytes of the frame's length prefix.
const HEADER_LEN: usize = 4;
/// Bytes of the kind byte, counted in the declared length but not in the payload.
const KIND_LEN: usize = 1;
/// Bytes of a body frame's id.
const ID_LEN: usize = 8;
/// The decoder hands its buffer back down once it has consumed more than it still holds, so a
/// long stream costs memory proportional to the frames in flight, not to the stream.
const COMPACT_DIVISOR: usize = 2;

/// One decoded frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// A JSON message.
    Message(Message),
    /// A binary body belonging to the JSON response with this id.
    Body {
        /// The id of the request whose bytes these are.
        id: u64,
        /// The bytes themselves.
        bytes: Vec<u8>,
    },
}

/// Encode a JSON message as one frame.
///
/// # Errors
///
/// `TOO_LARGE` when the message does not fit in [`MAX_FRAME_LEN`], and `INVALID_ARGUMENT` when it
/// cannot be serialized.
pub fn encode(message: &Message) -> Result<Vec<u8>, Error> {
    // The JSON is written straight after a placeholder header, which is filled in once its
    // length is known, so a frame costs one buffer rather than a payload and a copy of it.
    let mut bytes = Vec::with_capacity(256);
    bytes.extend_from_slice(&[0; HEADER_LEN]);
    bytes.push(JSON_KIND);
    serde_json::to_writer(&mut bytes, message)
        .map_err(|source| Error::Message { id: None, source })?;
    let length = (bytes.len() - HEADER_LEN) as u64;
    if length > u64::from(MAX_FRAME_LEN) {
        return Err(Error::FrameTooLarge { length });
    }
    let length = u32::try_from(length).map_err(|_| Error::FrameTooLarge { length })?;
    bytes[..HEADER_LEN].copy_from_slice(&length.to_le_bytes());
    Ok(bytes)
}

/// Encode a binary body as one frame, tagged with the request id it belongs to.
///
/// # Errors
///
/// `TOO_LARGE` when the bytes do not fit in [`MAX_BODY_LEN`].
pub fn encode_body(id: u64, bytes: &[u8]) -> Result<Vec<u8>, Error> {
    if bytes.len() as u64 > u64::from(MAX_BODY_LEN) {
        let length = ID_LEN as u64 + KIND_LEN as u64 + bytes.len() as u64;
        return Err(Error::FrameTooLarge { length });
    }
    let mut payload = Vec::with_capacity(ID_LEN + bytes.len());
    payload.extend_from_slice(&id.to_le_bytes());
    payload.extend_from_slice(bytes);
    frame(BODY_KIND, &payload)
}

/// Prefix `payload` with its length and kind byte, refusing frames over the limit.
fn frame(kind: u8, payload: &[u8]) -> Result<Vec<u8>, Error> {
    let length = payload.len() as u64 + KIND_LEN as u64;
    if length > u64::from(MAX_FRAME_LEN) {
        return Err(Error::FrameTooLarge { length });
    }
    let length = u32::try_from(length).map_err(|_| Error::FrameTooLarge { length })?;
    let mut bytes = Vec::with_capacity(HEADER_LEN + length as usize);
    bytes.extend_from_slice(&length.to_le_bytes());
    bytes.push(kind);
    bytes.extend_from_slice(payload);
    Ok(bytes)
}

/// Reads frames out of the byte chunks stdio hands over: a chunk may hold half a frame, several
/// frames, or one and a half.
///
/// A message that fails to parse does not lose the stream: the frame boundary was known, so the
/// next call reads the next frame. A frame that declares more than [`MAX_FRAME_LEN`] is the one
/// case that ends the stream, because nothing after it can be trusted to start where it says.
#[derive(Debug, Default)]
pub struct Decoder {
    buffer: Vec<u8>,
    /// Bytes before this have already been decoded.
    offset: usize,
    /// The length of the declaration that ended the stream, once one did.
    dead: Option<u64>,
}

impl Decoder {
    /// A decoder with no bytes buffered.
    pub fn new() -> Decoder {
        Decoder::default()
    }

    /// Hand the next chunk in. Chunks may split or join frames at any byte. A dead decoder drops
    /// the chunk instead of holding it, so a broken stream costs no memory while it is being shut
    /// down.
    pub fn push(&mut self, chunk: &[u8]) {
        if self.dead.is_some() {
            return;
        }
        self.buffer.extend_from_slice(chunk);
    }

    /// How many bytes are held for frames not yet decoded.
    pub fn buffered_bytes(&self) -> usize {
        self.buffer.len() - self.offset
    }

    /// Take the next complete frame out of the buffer.
    ///
    /// Returns `Ok(None)` when the buffered bytes do not hold a whole frame yet. A frame whose
    /// JSON does not parse is reported once and the decoder carries on with the next frame, since
    /// the frame boundary was known. Only a declaration over [`MAX_FRAME_LEN`] ends the stream: it
    /// is reported on this call and on every later one, while `push` discards what still arrives.
    ///
    /// # Errors
    ///
    /// `TOO_LARGE` for an oversize declaration, `INVALID_ARGUMENT` for a zero-length frame, a
    /// truncated body or an unreadable message, and `UNSUPPORTED` for an unknown kind or an op
    /// this build does not know.
    pub fn poll(&mut self) -> Result<Option<Frame>, Error> {
        if let Some(length) = self.dead {
            return Err(Error::FrameTooLarge { length });
        }
        let buffered = &self.buffer[self.offset..];
        if buffered.len() < HEADER_LEN {
            return Ok(None);
        }
        let length = u32::from_le_bytes([buffered[0], buffered[1], buffered[2], buffered[3]]);
        if length > MAX_FRAME_LEN {
            let length = u64::from(length);
            self.dead = Some(length);
            self.buffer = Vec::new();
            self.offset = 0;
            return Err(Error::FrameTooLarge { length });
        }
        if length == 0 {
            self.offset += HEADER_LEN;
            self.compact();
            return Err(Error::EmptyFrame);
        }
        let end = self.offset + HEADER_LEN + length as usize;
        if self.buffer.len() < end {
            return Ok(None);
        }
        let kind = self.buffer[self.offset + HEADER_LEN];
        let payload = &self.buffer[self.offset + HEADER_LEN + KIND_LEN..end];
        let decoded = match kind {
            JSON_KIND => message(payload),
            BODY_KIND => body(payload),
            other => Err(Error::UnknownKind(other)),
        };
        self.offset = end;
        self.compact();
        decoded.map(Some)
    }

    /// Drop the bytes already decoded.
    fn compact(&mut self) {
        if self.offset == self.buffer.len() {
            self.buffer.clear();
            self.offset = 0;
        } else if self.offset > self.buffer.len() / COMPACT_DIVISOR {
            self.buffer.drain(..self.offset);
            self.offset = 0;
        }
    }
}

/// Parse one JSON message, keeping the request id the payload carried even when it is broken.
fn message(payload: &[u8]) -> Result<Frame, Error> {
    match serde_json::from_slice::<Message>(payload) {
        Ok(message) => Ok(Frame::Message(message)),
        Err(source) => Err(Error::Message {
            id: request_id(payload),
            source: classify(payload, source),
        }),
    }
}

/// The little a broken payload must still carry for its request to be answered.
#[derive(Deserialize)]
struct RequestId {
    #[serde(default)]
    id: Option<u64>,
}

/// The id a payload still exposes, when it has one at all.
fn request_id(payload: &[u8]) -> Option<u64> {
    serde_json::from_slice::<RequestId>(payload)
        .ok()
        .and_then(|probe| probe.id)
}

/// Mark an op this build does not know, so [`Error::code`] reports it as a version difference
/// rather than a broken message.
fn classify(payload: &[u8], source: serde_json::Error) -> serde_json::Error {
    if unknown_op(payload) {
        serde_json::Error::custom(format!("{UNKNOWN_OP}: {source}"))
    } else {
        source
    }
}

/// True when the payload is a request whose op tag this build does not know. Any other failure is
/// a message that does not add up, which is not a newer op.
fn unknown_op(payload: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(payload) else {
        return false;
    };
    value.get("type").and_then(Value::as_str) == Some("request")
        && value
            .get("op")
            .and_then(Value::as_object)
            .and_then(|op| op.get("op"))
            .and_then(Value::as_str)
            .is_some_and(|tag| !op::knows(tag))
}

/// Split a body payload into its request id and its bytes.
fn body(payload: &[u8]) -> Result<Frame, Error> {
    if payload.len() < ID_LEN {
        return Err(Error::TruncatedBody {
            length: payload.len() as u64,
        });
    }
    let (id, bytes) = payload.split_at(ID_LEN);
    let mut id_bytes = [0u8; ID_LEN];
    id_bytes.copy_from_slice(id);
    Ok(Frame::Body {
        id: u64::from_le_bytes(id_bytes),
        bytes: bytes.to_vec(),
    })
}
