// SPDX-License-Identifier: Apache-2.0

//! Frame encoding and the incremental decoder.

use crate::WireError;

/// The largest length a frame may declare: the kind byte plus the payload.
pub const MAX_FRAME_LEN: u32 = 16 * 1024 * 1024;
const JSON_KIND: u8 = 1;
const BODY_KIND: u8 = 2;
const HEADER_LEN: usize = 4;
const ID_LEN: usize = 8;

/// One decoded frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// A UTF-8 JSON message, still as text.
    Json(Vec<u8>),
    /// Bytes belonging to the next JSON message with this id.
    Body { id: u64, bytes: Vec<u8> },
}

/// A JSON message as one frame.
///
/// # Errors
///
/// When the value cannot be serialized or is over the frame limit.
pub fn encode_json(value: &serde_json::Value) -> Result<Vec<u8>, WireError> {
    let mut bytes = Vec::with_capacity(256);
    bytes.extend_from_slice(&[0; HEADER_LEN]);
    bytes.push(JSON_KIND);
    serde_json::to_writer(&mut bytes, value)?;
    seal(bytes)
}

/// Bytes as one body frame for message `id`.
///
/// # Errors
///
/// When the bytes are over the frame limit.
pub fn encode_body(id: u64, payload: &[u8]) -> Result<Vec<u8>, WireError> {
    let mut bytes = Vec::with_capacity(HEADER_LEN + 1 + ID_LEN + payload.len());
    bytes.extend_from_slice(&[0; HEADER_LEN]);
    bytes.push(BODY_KIND);
    bytes.extend_from_slice(&id.to_le_bytes());
    bytes.extend_from_slice(payload);
    seal(bytes)
}

fn seal(mut bytes: Vec<u8>) -> Result<Vec<u8>, WireError> {
    let length = (bytes.len() - HEADER_LEN) as u64;
    if length > u64::from(MAX_FRAME_LEN) {
        return Err(WireError::TooLarge(length));
    }
    let length = u32::try_from(length).map_err(|_| WireError::TooLarge(length))?;
    bytes[..HEADER_LEN].copy_from_slice(&length.to_le_bytes());
    Ok(bytes)
}

/// Reads frames out of the chunks a pipe hands over, which may split or join frames anywhere.
/// A declaration over the limit ends the stream: nothing after it can be trusted.
#[derive(Debug, Default)]
pub struct Decoder {
    buffer: Vec<u8>,
    offset: usize,
    dead: Option<u64>,
}

impl Decoder {
    pub fn new() -> Decoder {
        Decoder::default()
    }

    pub fn push(&mut self, chunk: &[u8]) {
        if self.dead.is_none() {
            self.buffer.extend_from_slice(chunk);
        }
    }

    /// The next whole frame, or `None` until more bytes arrive.
    ///
    /// # Errors
    ///
    /// An oversize declaration (on this and every later call), an empty frame, an unknown kind or
    /// a truncated body. Only the first ends the stream.
    pub fn poll(&mut self) -> Result<Option<Frame>, WireError> {
        if let Some(length) = self.dead {
            return Err(WireError::TooLarge(length));
        }
        let held = &self.buffer[self.offset..];
        if held.len() < HEADER_LEN {
            return Ok(None);
        }
        let length = u32::from_le_bytes([held[0], held[1], held[2], held[3]]);
        if length > MAX_FRAME_LEN {
            self.dead = Some(u64::from(length));
            self.buffer = Vec::new();
            self.offset = 0;
            return Err(WireError::TooLarge(u64::from(length)));
        }
        if length == 0 {
            self.offset += HEADER_LEN;
            self.compact();
            return Err(WireError::Empty);
        }
        let end = self.offset + HEADER_LEN + length as usize;
        if self.buffer.len() < end {
            return Ok(None);
        }
        let kind = self.buffer[self.offset + HEADER_LEN];
        let payload = &self.buffer[self.offset + HEADER_LEN + 1..end];
        let frame = match kind {
            JSON_KIND => Ok(Frame::Json(payload.to_vec())),
            BODY_KIND if payload.len() >= ID_LEN => {
                let mut id = [0u8; ID_LEN];
                id.copy_from_slice(&payload[..ID_LEN]);
                Ok(Frame::Body {
                    id: u64::from_le_bytes(id),
                    bytes: payload[ID_LEN..].to_vec(),
                })
            }
            BODY_KIND => Err(WireError::Truncated),
            other => Err(WireError::UnknownKind(other)),
        };
        self.offset = end;
        self.compact();
        frame.map(Some)
    }

    fn compact(&mut self) {
        if self.offset == self.buffer.len() {
            self.buffer.clear();
            self.offset = 0;
        } else if self.offset > self.buffer.len() / 2 {
            self.buffer.drain(..self.offset);
            self.offset = 0;
        }
    }
}
