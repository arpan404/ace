// SPDX-License-Identifier: Apache-2.0
//! The OpenCode event stream, sans-IO: `boundedSse` (`observation.ts:54`-`:80`)
//! feeding the OpenCode SDK's own SSE framing (2.0.22,
//! `dist/chunks/service-contender-50fct660.js`, its `sse` function), never
//! `ace_supervisor::sse`, whose field rules differ.
//!
//! Two stages, in the pipe order the TypeScript runs them:
//!
//! 1. [`Bounded`] elides heavy strings in the raw bytes with `openCodeElision`
//!    (`observation.ts:11`) and bounds each event: the bytes emitted since the
//!    last blank line, over `maxProviderPayloadBytes`, fail with
//!    "OpenCode event exceeds byte limit". A CR counts as a byte, as the
//!    TypeScript's `++bytes` runs before its CR check; it only never closes a
//!    line.
//! 2. [`Framer`] is the SDK's framing exactly: streaming UTF-8 decode, the
//!    16 Mi UTF-16-unit buffer bound, CR normalization with a trailing CR held
//!    back, blocks split on a blank line, `data:` lines joined by `\n`, and one
//!    `JSON.parse` per event. Every chunk that is not the end counts as
//!    activity, which the server core notes to its tenants.
//!
//! No TypeScript test covers the SDK's parser or its 16 Mi-unit bound, so the
//! tables in `stream/tests.rs` are the port's own proof (E3-opencode.1). The
//! rules table names each SDK statement with its line in that chunk.

use ace_adapter_api::util::{ElisionLimits, JsonElider};
use ace_json::Value;

use super::error::StreamError;

/// `openCodeElision` (`observation.ts:11`): base64 under 16 KiB passes
/// untouched; readable text keeps 256 KiB.
const ELISION: ElisionLimits = ElisionLimits {
    hold_bytes: 16 * 1024,
    text_bytes: 256 * 1024,
};
/// `maxEventBytes`, which is `maxProviderPayloadBytes` (`observation.ts:19`).
const MAX_EVENT_BYTES: usize = 1024 * 1024;
/// The SDK's `maxSseEventBytes = 16 * 1024 * 1024`, counted in UTF-16 units
/// (`buffer.length`, rule 17).
const MAX_SSE_EVENT_UNITS: usize = 16 * 1024 * 1024;

/// `boundedSse`: elide heavy strings, then bound each event's bytes.
struct Bounded {
    elider: JsonElider,
    /// Bytes emitted since the last blank line.
    bytes: usize,
    /// The previous emitted byte was a line feed.
    newline: bool,
}

impl Bounded {
    /// The limits are compile-time constants that satisfy `JsonElider::new`, so
    /// the only way it fails is a corrected constant.
    #[allow(clippy::expect_used)]
    fn new() -> Self {
        Self {
            elider: JsonElider::new(ELISION).expect("the OpenCode elision limits are valid"),
            bytes: 0,
            newline: false,
        }
    }

    /// One raw body chunk: its elided bytes accumulate in `out`.
    fn push(&mut self, raw: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let from = out.len();
        self.elider.push(raw, out);
        self.count(&out[from..])
    }

    /// The end of the body: the elider flushes an open string for the parser to
    /// refuse, and its bytes are bounded like any other.
    fn end(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let from = out.len();
        self.elider.end(out);
        self.count(&out[from..])
    }

    /// `observation.ts:63`-`:70`. A blank line resets the count; a CR takes a
    /// byte but neither opens nor closes one.
    fn count(&mut self, emitted: &[u8]) -> Result<(), StreamError> {
        for &byte in emitted {
            self.bytes += 1;
            if self.bytes > MAX_EVENT_BYTES {
                return Err(StreamError::EventBytes);
            }
            if byte == b'\r' {
                continue;
            }
            if byte == b'\n' {
                if self.newline {
                    self.bytes = 0;
                }
                self.newline = true;
            } else {
                self.newline = false;
            }
        }
        Ok(())
    }
}

/// `new TextDecoder`, streaming: complete sequences decode, an incomplete tail
/// waits for the next chunk, and an invalid sequence becomes U+FFFD (one per
/// maximal subpart, as the WHATWG decoder does).
#[derive(Default)]
struct Decoder {
    /// At most three bytes of an incomplete sequence.
    pending: Vec<u8>,
}

impl Decoder {
    /// `decoder.decode(bytes, { stream: !end })`. `end` flushes a truncated
    /// sequence as U+FFFD and clears the pending bytes.
    fn decode(&mut self, bytes: &[u8], end: bool) -> String {
        let mut joined;
        let mut input = bytes;
        if !self.pending.is_empty() {
            joined = std::mem::take(&mut self.pending);
            joined.extend_from_slice(bytes);
            input = &joined;
        }
        let mut out = String::with_capacity(input.len());
        let mut rest = input;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(error) => {
                    let at = error.valid_up_to();
                    // The prefix before `valid_up_to` is valid by definition.
                    out.push_str(&String::from_utf8_lossy(&rest[..at]));
                    match error.error_len() {
                        Some(length) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &rest[at + length..];
                        }
                        None if end => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            break;
                        }
                        None => {
                            self.pending = rest[at..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

/// The SDK's SSE framing (`sse`, the generator body). One connection's buffer
/// and decoder; `reset` starts the next connection fresh, as a new async
/// iterator does.
#[derive(Default)]
struct Framer {
    decoder: Decoder,
    /// The normalized text not yet split into blocks, without a held CR.
    buffer: String,
    /// `buffer`'s UTF-16 length, kept as it changes.
    units: usize,
    /// The chunk ended in `\r`, held back until the next text says what it is.
    held_cr: bool,
}

impl Framer {
    /// One decoded chunk: `bytes` are the elided body bytes, `end` the SDK's
    /// `next.done`. Parsed events append to `events` in order.
    fn push(
        &mut self,
        bytes: &[u8],
        end: bool,
        events: &mut Vec<Value>,
    ) -> Result<(), StreamError> {
        let decoded = self.decoder.decode(bytes, end);
        let decoded_units = decoded.encode_utf16().count();
        // The SDK checks the whole buffer's UTF-16 length after every chunk,
        // the final one included (`if (buffer.length > maxSseEventBytes)`).
        if self.units + usize::from(self.held_cr) + decoded_units > MAX_SSE_EVENT_UNITS {
            return Err(StreamError::SseEventTooLarge);
        }
        self.append(&decoded, end);
        if end && !self.buffer.is_empty() {
            self.push_text("\n\n");
        }
        self.split(events)
    }

    /// Normalizes CR the way the SDK does: CRLF becomes one LF, a lone CR an LF,
    /// and a CR at the end of a non-final chunk waits for the next chunk (the
    /// SDK re-appends it after the replacements).
    fn append(&mut self, text: &str, end: bool) {
        for character in text.chars() {
            if self.held_cr {
                self.held_cr = false;
                self.push_text("\n");
                if character == '\n' {
                    continue;
                }
            }
            if character == '\r' {
                self.held_cr = true;
            } else {
                self.push_char(character);
            }
        }
        if end && self.held_cr {
            self.held_cr = false;
            self.push_text("\n");
        }
    }

    /// Splits every complete block, in order, and parses each block whose data
    /// is non-empty once (`JSON.parse` refuses → `MalformedResponse`).
    fn split(&mut self, events: &mut Vec<Value>) -> Result<(), StreamError> {
        let mut at = 0;
        while let Some(offset) = self.buffer[at..].find("\n\n") {
            let end = at + offset;
            let data = data_lines(&self.buffer[at..end]);
            at = end + 2;
            if !data.is_empty() {
                match ace_json::parse(&data) {
                    Ok(value) => events.push(value),
                    Err(_) => return Err(StreamError::MalformedResponse),
                }
            }
        }
        if at > 0 {
            let removed = self.buffer[..at].encode_utf16().count();
            self.buffer.drain(..at);
            self.units -= removed;
        }
        Ok(())
    }

    fn push_char(&mut self, character: char) {
        self.units += character.len_utf16();
        self.buffer.push(character);
    }

    fn push_text(&mut self, text: &str) {
        self.units += text.encode_utf16().count();
        self.buffer.push_str(text);
    }
}

/// A block's data: its `data:` lines with `slice(5).trimStart()`, joined by `\n`.
/// Empty lines are kept, so a leading empty `data:` line still shifts the join.
fn data_lines(block: &str) -> String {
    let mut out = String::new();
    let mut first = true;
    for line in block.split('\n') {
        let Some(rest) = line.strip_prefix("data:") else {
            continue;
        };
        if !first {
            out.push('\n');
        }
        out.push_str(rest.trim_start_matches(is_js_whitespace));
        first = false;
    }
    out
}

/// JavaScript's `\s` (ECMA-262 WhiteSpace + LineTerminator). Rust's
/// `char::is_whitespace` differs: it strips U+0085, which JavaScript keeps.
fn is_js_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// One server's SSE body: the elision bound, then the SDK's framing. Chunks are
/// `Buffer`s; every event is parsed once here and handed on as a value.
pub struct EventStream {
    bounded: Bounded,
    framer: Framer,
    /// The elided bytes of the chunk being pushed, reused across chunks.
    scratch: Vec<u8>,
}

impl Default for EventStream {
    fn default() -> Self {
        Self::new()
    }
}

impl EventStream {
    pub fn new() -> Self {
        Self {
            bounded: Bounded::new(),
            framer: Framer::default(),
            scratch: Vec::new(),
        }
    }

    /// One body chunk. On failure the stream is dead until [`EventStream::reset`];
    /// events parsed before the failure are already in `events`.
    pub fn push(&mut self, bytes: &[u8], events: &mut Vec<Value>) -> Result<(), StreamError> {
        self.scratch.clear();
        self.bounded.push(bytes, &mut self.scratch)?;
        self.framer.push(&self.scratch, false, events)
    }

    /// The end of the body: an unterminated block is flushed, as `next.done`
    /// does, and the stream is ready for the next connection.
    pub fn end(&mut self, events: &mut Vec<Value>) -> Result<(), StreamError> {
        self.scratch.clear();
        let result = self
            .bounded
            .end(&mut self.scratch)
            .and_then(|()| self.framer.push(&self.scratch, true, events));
        self.reset();
        result
    }

    /// A fresh connection's decoder, buffer and elider state.
    pub fn reset(&mut self) {
        self.bounded = Bounded::new();
        self.framer = Framer::default();
    }
}

#[cfg(test)]
mod tests;
