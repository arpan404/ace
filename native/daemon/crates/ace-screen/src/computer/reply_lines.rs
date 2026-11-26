// SPDX-License-Identifier: Apache-2.0

//! Splits the helper's stdout into reply lines without ever holding more than `max_bytes` of
//! one line (`computer/reply-lines.ts`). A longer line is discarded as it streams; only its
//! first and last few kilobytes are kept, to recover the request id so that request can fail
//! at once. Pure: no I/O.

/// The bytes kept of an oversized line's head and tail (`reply-lines.ts:24`).
pub const EDGE_BYTES: usize = 64 * 1024;
/// A reason's id is at most this many units (`reply-lines.ts:25`'s `{1,128}`).
const MAX_ID_UNITS: usize = 128;

/// One line `push` completed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplyLine {
    /// A line within the cap, without its `\r`.
    Line { text: String },
    /// A line past the cap, and the request id recovered from its edges when one is readable.
    Oversize { id: Option<String> },
}

/// The stdout splitter (`reply-lines.ts:27`).
#[derive(Debug)]
pub struct ReplyLines {
    max_bytes: usize,
    parts: Vec<u8>,
    size: usize,
    discarding: bool,
    head: Vec<u8>,
    tail: Vec<u8>,
}

impl ReplyLines {
    pub fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            parts: Vec::new(),
            size: 0,
            discarding: false,
            head: Vec::new(),
            tail: Vec::new(),
        }
    }

    /// Every line `chunk` completes, in order (`reply-lines.ts:35`).
    pub fn push(&mut self, chunk: &[u8]) -> Vec<ReplyLine> {
        let mut lines = Vec::new();
        let mut start = 0;
        while start < chunk.len() {
            let newline = chunk[start..].iter().position(|byte| *byte == b'\n');
            match newline {
                Some(offset) => {
                    self.take(&chunk[start..start + offset]);
                    lines.push(self.finish());
                    start += offset + 1;
                }
                None => {
                    self.take(&chunk[start..]);
                    break;
                }
            }
        }
        lines
    }

    fn take(&mut self, piece: &[u8]) {
        if piece.is_empty() {
            return;
        }
        if self.discarding {
            // Only the tail is kept: the head was full when the line went over.
            let mut joined = std::mem::take(&mut self.tail);
            joined.extend_from_slice(piece);
            self.tail = joined[joined.len().saturating_sub(EDGE_BYTES)..].to_vec();
            return;
        }
        self.parts.extend_from_slice(piece);
        self.size += piece.len();
        if self.size <= self.max_bytes {
            return;
        }
        let all = std::mem::take(&mut self.parts);
        self.head = all[..all.len().min(EDGE_BYTES)].to_vec();
        self.tail = all[all.len().saturating_sub(EDGE_BYTES)..].to_vec();
        self.size = 0;
        self.discarding = true;
    }

    fn finish(&mut self) -> ReplyLine {
        if self.discarding {
            let id = id_in(&self.head).or_else(|| id_in(&self.tail));
            self.discarding = false;
            self.head.clear();
            self.tail.clear();
            return ReplyLine::Oversize { id };
        }
        let text = String::from_utf8_lossy(&self.parts).into_owned();
        self.parts.clear();
        self.size = 0;
        ReplyLine::Line {
            text: text
                .strip_suffix('\r')
                .map_or(text.clone(), ToOwned::to_owned),
        }
    }
}

/// `reply-lines.ts:25`'s `/"id"\s*:\s*"((?:[^"\\\n]|\\.){1,128})"/`, by hand: the id of a
/// reply whose line was too long, so its request can fail without waiting for the deadline.
fn id_in(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let bytes = text.as_bytes();
    let mut at = 0;
    while at + 4 <= bytes.len() {
        if &bytes[at..at + 4] != b"\"id\"" {
            at += 1;
            continue;
        }
        let mut index = at + 4;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b':' {
            at += 4;
            continue;
        }
        index += 1;
        while index < bytes.len() && bytes[index].is_ascii_whitespace() {
            index += 1;
        }
        if index >= bytes.len() || bytes[index] != b'"' {
            at += 4;
            continue;
        }
        index += 1;
        let start = index;
        let mut units = 0;
        while index < bytes.len() {
            let byte = bytes[index];
            if byte == b'"' {
                if units == 0 || units > MAX_ID_UNITS {
                    break;
                }
                return Some(String::from_utf8_lossy(&bytes[start..index]).into_owned());
            }
            if byte == b'\n' || units == MAX_ID_UNITS {
                break;
            }
            if byte == b'\\' {
                // `\\.`: an escape takes the next byte with it.
                index += 2;
                units += 1;
                continue;
            }
            index += 1;
            units += 1;
        }
        at += 4;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{EDGE_BYTES, ReplyLine, ReplyLines};

    fn line(text: &str) -> ReplyLine {
        ReplyLine::Line {
            text: text.to_owned(),
        }
    }

    #[test]
    fn lines_split_on_lf_and_drop_a_crlf_carriage_return() {
        let mut lines = ReplyLines::new(1024);
        assert_eq!(
            lines.push(b"{\"a\":1}\n{\"b\":2}\r\nhalf"),
            vec![line("{\"a\":1}"), line("{\"b\":2}")]
        );
        assert_eq!(lines.push(b"-done\n"), vec![line("half-done")]);
    }

    #[test]
    fn a_line_past_the_cap_is_discarded_and_its_id_recovered_from_the_head() {
        let mut lines = ReplyLines::new(64);
        let mut chunk = b"{\"id\":\"abc\",\"ok\":true,\"result\":\"".to_vec();
        chunk.extend(std::iter::repeat_n(b'x', 4 * 1024));
        chunk.extend_from_slice(b"\"}\n");
        assert_eq!(
            lines.push(&chunk),
            vec![ReplyLine::Oversize {
                id: Some("abc".to_owned())
            }]
        );
        // The next line is read normally again.
        assert_eq!(
            lines.push(b"{\"id\":\"d\"}\n"),
            vec![line("{\"id\":\"d\"}")]
        );
    }

    #[test]
    fn an_id_past_the_edges_is_recovered_from_the_tail_when_it_sits_there() {
        // `max_bytes` past the head edge, then the id: only the tail holds it.
        let mut lines = ReplyLines::new(16);
        let mut chunk = Vec::new();
        chunk.extend(std::iter::repeat_n(b'y', EDGE_BYTES + 4_096));
        chunk.extend_from_slice(b"\"id\":\"late\"}\n");
        assert_eq!(
            lines.push(&chunk),
            vec![ReplyLine::Oversize {
                id: Some("late".to_owned())
            }]
        );
    }

    #[test]
    fn an_oversized_line_without_a_readable_id_reports_none() {
        let mut lines = ReplyLines::new(8);
        let mut chunk = vec![b'z'; 1024];
        chunk.push(b'\n');
        assert_eq!(lines.push(&chunk), vec![ReplyLine::Oversize { id: None }]);
    }
}
