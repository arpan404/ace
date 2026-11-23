// SPDX-License-Identifier: Apache-2.0
//! LF-only record framing for `readJsonLines` (`jsonl.ts`), on
//! `tokio_util::codec::LinesCodec::new_with_max_length`: records end at LF, one
//! trailing CR is dropped, an unterminated final record is an error, and the
//! current record's byte count is bounded. Chunks are scanned once and fragments
//! are joined only at a record boundary.

use tokio_util::bytes::BytesMut;
use tokio_util::codec::{Decoder, LinesCodec, LinesCodecError};

/// What one chunk produced: complete records, in order, and the refusal that
/// stopped the stream (the records before it are still delivered).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct JsonlPush {
    pub lines: Vec<String>,
    pub error: Option<String>,
}

/// A bounded JSONL reader. The shell owns the stream, the flow pause and the
/// error callback; this owns framing and counting.
#[derive(Debug)]
pub struct JsonLines {
    codec: LinesCodec,
    buffer: BytesMut,
    failed: bool,
}

impl JsonLines {
    pub fn new(max_bytes: usize) -> JsonLines {
        JsonLines {
            codec: LinesCodec::new_with_max_length(max_bytes),
            buffer: BytesMut::new(),
            failed: false,
        }
    }

    /// Feed one chunk of bytes.
    pub fn push(&mut self, chunk: &[u8]) -> JsonlPush {
        if self.failed {
            return JsonlPush::default();
        }
        self.buffer.extend_from_slice(chunk);
        let mut out = JsonlPush::default();
        loop {
            match self.codec.decode(&mut self.buffer) {
                Ok(Some(line)) => {
                    if !line.is_empty() {
                        out.lines.push(line);
                    }
                }
                Ok(None) => return out,
                Err(LinesCodecError::MaxLineLengthExceeded) => {
                    self.fail();
                    out.error = Some("JSONL line exceeded limit".to_owned());
                    return out;
                }
                Err(LinesCodecError::Io(_)) => {
                    // A record that is not UTF-8 cannot be JSON; the caller's
                    // malformed-frame path handles it as it handled today's
                    // replacement text failing `JSON.parse`.
                    self.fail();
                    out.error = Some("JSONL line is not valid UTF-8".to_owned());
                    return out;
                }
            }
        }
    }

    /// The stream ended. `paused` is the owner's flow state when it did: a record
    /// still arriving while the reader is paused was never counted, so only what
    /// arrived before the pause can be refused for length.
    pub fn finish(&mut self, paused: bool) -> Option<String> {
        if self.failed {
            return None;
        }
        if self.buffer.is_empty() {
            return None;
        }
        let decoded = String::from_utf8_lossy(&self.buffer);
        let message = if !paused && decoded.len() > self.codec.max_length() {
            "JSONL line exceeded limit".to_owned()
        } else {
            "Incomplete JSONL record".to_owned()
        };
        self.buffer.clear();
        Some(message)
    }

    fn fail(&mut self) {
        self.failed = true;
        self.buffer.clear();
    }
}
