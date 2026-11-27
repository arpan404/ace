// SPDX-License-Identifier: Apache-2.0
//! LF-only record framing for `readJsonLines` (`jsonl.ts`): records end at LF,
//! one trailing CR is dropped, an unterminated final record is an error, and the
//! current record's byte count is bounded. Framing is on raw bytes with the
//! decoded byte count checked before a record is delivered; malformed UTF-8
//! decodes with replacement characters exactly as `StringDecoder` did and never
//! ends the stream. The shell owns the stream, the flow pause and the callbacks.

use crate::lines::{FramedLines, Utf8Decoder};

/// What one chunk produced: complete records, in order, and the refusal that
/// stopped the stream (the records before it are still delivered).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct JsonlPush {
    pub lines: FramedLines,
    pub error: Option<String>,
}

#[derive(Debug)]
pub struct JsonLines {
    max_bytes: usize,
    decoder: Utf8Decoder,
    /// Text of the record being assembled.
    pending: String,
    /// `Buffer.byteLength` of `pending`, as the TypeScript counted it.
    bytes: usize,
    failed: bool,
}

impl JsonLines {
    pub fn new(max_bytes: usize) -> JsonLines {
        JsonLines {
            max_bytes,
            decoder: Utf8Decoder::default(),
            pending: String::new(),
            bytes: 0,
            failed: false,
        }
    }

    /// Feed one chunk of bytes.
    pub fn push(&mut self, chunk: &[u8]) -> JsonlPush {
        let mut out = JsonlPush::default();
        if self.failed {
            return out;
        }
        let mut text = String::with_capacity(chunk.len());
        self.decoder.push(chunk, &mut text);
        let mut start = 0usize;
        while let Some(offset) = text[start..].find('\n') {
            let end = start + offset;
            let part = &text[start..end];
            if self.over_budget(part) {
                out.error = Some("JSONL line exceeded limit".to_owned());
                return out;
            }
            let (held, fragment) = without_carriage_return(&self.pending, part);
            if !held.is_empty() || !fragment.is_empty() {
                out.lines.push_parts(held, fragment);
            }
            self.pending.clear();
            self.bytes = 0;
            start = end + 1;
        }
        if self.over_budget(&text[start..]) {
            out.error = Some("JSONL line exceeded limit".to_owned());
            return out;
        }
        self.pending.push_str(&text[start..]);
        out
    }

    /// The stream ended. `paused` is the owner's flow state when it did: the
    /// held UTF-8 tail is only counted when the reader was reading, as the
    /// TypeScript's `accept(decoder.end())` was deferred behind the pause.
    pub fn finish(&mut self, paused: bool) -> Option<String> {
        if self.failed {
            return None;
        }
        if !paused {
            let mut tail = String::new();
            self.decoder.finish(&mut tail);
            if self.over_budget(&tail) {
                return Some("JSONL line exceeded limit".to_owned());
            }
        }
        if self.bytes > 0 {
            return Some("Incomplete JSONL record".to_owned());
        }
        None
    }

    /// Count one decoded piece; true once the record is over budget.
    fn over_budget(&mut self, part: &str) -> bool {
        self.bytes = self.bytes.saturating_add(part.len());
        if self.bytes > self.max_bytes {
            self.failed = true;
            self.pending.clear();
            self.bytes = 0;
            return true;
        }
        false
    }
}

/// The record's text with one trailing CR removed, as the TypeScript did, split
/// into the prefix held from earlier chunks and this chunk's fragment.
fn without_carriage_return<'a>(held: &'a str, fragment: &'a str) -> (&'a str, &'a str) {
    if let Some(stripped) = fragment.strip_suffix('\r') {
        (held, stripped)
    } else if fragment.is_empty() {
        match held.strip_suffix('\r') {
            Some(stripped) => (stripped, ""),
            None => (held, ""),
        }
    } else {
        (held, fragment)
    }
}
