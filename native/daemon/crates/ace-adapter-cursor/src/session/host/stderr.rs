// SPDX-License-Identifier: Apache-2.0
//! Stderr framing for a host whose SDK hands its own stderr to the MCP servers it starts
//! (`onStderrLineDropped`, `host.ts:115`): an oversized line is dropped up to its terminator and
//! every line after it still arrives. Only an admissible line's bytes are held, at most
//! `maxFrameBytes`, and each complete line is decoded on its own.

use ace_supervisor::lines::{FramedLines, LineFramer};

/// `lineReader`'s dropping gate for stderr (`output-line-drop.ts`): an oversized line is dropped
/// up to its terminator, and every line after it still arrives. Only an admissible line's bytes
/// are held (at most `max_bytes`), and each complete line is framed on its own.
pub(super) struct DroppingStderr {
    max_bytes: usize,
    /// The current line's bytes, without its terminator.
    pending: Vec<u8>,
    /// The current line is already over the limit: skip to its terminator.
    dropping: bool,
    /// The last line ended at CR; an LF opening the next chunk closes that CRLF.
    skip_lf: bool,
}

impl DroppingStderr {
    pub(super) fn new(max_bytes: usize) -> DroppingStderr {
        DroppingStderr {
            max_bytes,
            pending: Vec::new(),
            dropping: false,
            skip_lf: false,
        }
    }

    pub(super) fn push(&mut self, chunk: &[u8]) -> FramedLines {
        let mut framed = FramedLines::default();
        let mut chunk = chunk;
        if self.skip_lf {
            self.skip_lf = false;
            if chunk.first() == Some(&b'\n') {
                chunk = chunk.get(1..).unwrap_or_default();
            }
        }
        let mut at = 0usize;
        while at < chunk.len() {
            let rest = chunk.get(at..).unwrap_or_default();
            let terminator = rest
                .iter()
                .position(|byte| *byte == b'\n' || *byte == b'\r')
                .map(|offset| at + offset);
            let content_end = terminator.unwrap_or(chunk.len());
            let content = chunk.get(at..content_end).unwrap_or_default();
            if self.dropping {
                if terminator.is_none() {
                    return framed;
                }
                self.dropping = false;
                self.skip_lf = chunk.get(content_end) == Some(&b'\r');
                at = after_terminator(chunk, content_end);
                continue;
            }
            if self.pending.len() + content.len() > self.max_bytes {
                self.pending.clear();
                self.dropping = true;
                if terminator.is_none() {
                    return framed;
                }
                self.dropping = false;
                self.skip_lf = chunk.get(content_end) == Some(&b'\r');
                at = after_terminator(chunk, content_end);
                continue;
            }
            self.pending.extend_from_slice(content);
            let Some(_) = terminator else {
                return framed;
            };
            // One complete line, decoded on its own: a terminator never splits a UTF-8 sequence.
            let mut framer = LineFramer::new(self.max_bytes);
            let end = after_terminator(chunk, content_end);
            if let Ok(lines) = framer.push(chunk.get(at..end).unwrap_or_default())
                && lines.count > 0
            {
                for line in lines.text.split('\n') {
                    framed.push(line);
                }
            }
            self.pending.clear();
            at = end;
        }
        framed
    }

    pub(super) fn finish(&mut self) -> FramedLines {
        let mut framed = FramedLines::default();
        if self.dropping || self.pending.is_empty() {
            self.pending.clear();
            return framed;
        }
        let mut framer = LineFramer::new(self.max_bytes);
        let pending = std::mem::take(&mut self.pending);
        if let Ok(lines) = framer.push(&pending) {
            let tail = framer.finish();
            for text in [lines, tail] {
                if text.count > 0 {
                    for line in text.text.split('\n') {
                        framed.push(line);
                    }
                }
            }
        }
        framed
    }
}

/// The byte after the terminator at `at`, taking an LF that closes a CR.
fn after_terminator(chunk: &[u8], at: usize) -> usize {
    let mut end = at + 1;
    if chunk.get(at) == Some(&b'\r') && chunk.get(end) == Some(&b'\n') {
        end += 1;
    }
    end
}
