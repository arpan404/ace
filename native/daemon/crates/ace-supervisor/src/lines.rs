// SPDX-License-Identifier: Apache-2.0
//! Line framing for `lineReader` (`line-reader.ts`, `line-segments.ts`). Lines end
//! at CR, LF or CRLF only: U+2028 and U+2029 are ordinary characters (Node's
//! readline would split them), so they and U+FDD0 travel through the line as a
//! reversible shield escape and are restored before the caller sees a line. The
//! byte counter that guards a line runs before decoding, on the bytes the provider
//! wrote, exactly as the output gate did.

/// The noncharacter `line-reader.ts` uses as its escape marker.
pub const SHIELD: char = '\u{FDD0}';

/// Escape U+2028, U+2029 and the shield itself so a line survives readline.
pub fn protect(text: &str) -> String {
    if !text.contains('\u{FDD0}') && !text.contains('\u{2028}') && !text.contains('\u{2029}') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '\u{FDD0}' => out.push_str("\u{FDD0}0"),
            '\u{2028}' => out.push_str("\u{FDD0}1"),
            '\u{2029}' => out.push_str("\u{FDD0}2"),
            c => out.push(c),
        }
    }
    out
}

/// Undo [`protect`] in one line.
pub fn restore(text: &str) -> String {
    if !text.contains(SHIELD) {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != SHIELD {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('0') => {
                let _ = chars.next();
                out.push(SHIELD);
            }
            Some('1') => {
                let _ = chars.next();
                out.push('\u{2028}');
            }
            Some('2') => {
                let _ = chars.next();
                out.push('\u{2029}');
            }
            _ => out.push(c),
        }
    }
    out
}

/// Incremental UTF-8 decoding with CR/LF framing, skipping the LF of a CRLF pair
/// that a chunk boundary split. Complete lines come out protected; a trailing
/// fragment waits for the next chunk.
#[derive(Debug)]
pub struct LineFramer {
    max_bytes: usize,
    line_bytes: usize,
    /// Bytes of an incomplete UTF-8 sequence at the end of the last chunk.
    tail: Vec<u8>,
    /// Text of the line being assembled.
    pending: String,
    skip_lf: bool,
    ended: bool,
    failed: bool,
}

impl LineFramer {
    pub fn new(max_bytes: usize) -> LineFramer {
        LineFramer {
            max_bytes,
            line_bytes: 0,
            tail: Vec::new(),
            pending: String::new(),
            skip_lf: false,
            ended: false,
            failed: false,
        }
    }

    /// Feed one chunk's raw bytes; complete lines, terminators stripped.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        if self.ended || self.failed {
            return Ok(Vec::new());
        }
        if let Some(message) = self.check_limit(chunk) {
            self.failed = true;
            return Err(message);
        }
        let mut text = String::with_capacity(chunk.len());
        self.decode(chunk, &mut text);
        let mut lines = Vec::new();
        self.frame(&text, &mut lines);
        Ok(lines)
    }

    /// The input ended: decode what is left and deliver the final partial line.
    pub fn finish(&mut self) -> Vec<String> {
        if self.ended || self.failed {
            return Vec::new();
        }
        self.ended = true;
        let mut lines = Vec::new();
        if !self.tail.is_empty() {
            let text = String::from_utf8_lossy(&self.tail).into_owned();
            self.tail.clear();
            self.frame(&text, &mut lines);
        }
        if !self.pending.is_empty() {
            lines.push(protect(&self.pending));
            self.pending.clear();
        }
        lines
    }

    /// The line-byte guard, over the raw bytes the gate saw before decoding.
    fn check_limit(&mut self, chunk: &[u8]) -> Option<String> {
        for &byte in chunk {
            if byte == b'\n' || byte == b'\r' {
                self.line_bytes = 0;
                continue;
            }
            self.line_bytes += 1;
            if self.line_bytes > self.max_bytes {
                return Some(format!(
                    "Process output line exceeded limit (line limit {} bytes)",
                    self.max_bytes
                ));
            }
        }
        None
    }

    /// Append the decodable part of `chunk`; an incomplete final sequence waits.
    fn decode(&mut self, chunk: &[u8], out: &mut String) {
        let mut bytes = Vec::with_capacity(self.tail.len() + chunk.len());
        bytes.append(&mut self.tail);
        bytes.extend_from_slice(chunk);
        let mut rest = bytes.as_slice();
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    return;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if let Ok(text) = std::str::from_utf8(&rest[..valid]) {
                        out.push_str(text);
                    }
                    rest = &rest[valid..];
                    match error.error_len() {
                        // The chunk ends inside a sequence: hold those bytes.
                        None => {
                            self.tail.extend_from_slice(rest);
                            return;
                        }
                        Some(length) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &rest[length..];
                        }
                    }
                }
            }
        }
    }

    /// Split decoded text on CR and LF, keeping CRLF and split CRLF together.
    fn frame(&mut self, text: &str, lines: &mut Vec<String>) {
        let bytes = text.as_bytes();
        let mut start = 0usize;
        let mut index = 0usize;
        while index < bytes.len() {
            let byte = bytes[index];
            if self.skip_lf {
                self.skip_lf = false;
                if byte == b'\n' {
                    start = index + 1;
                    index += 1;
                    continue;
                }
            }
            if byte != b'\r' && byte != b'\n' {
                index += 1;
                continue;
            }
            self.pending.push_str(&text[start..index]);
            lines.push(protect(&self.pending));
            self.pending.clear();
            self.skip_lf = byte == b'\r';
            start = index + 1;
            index += 1;
        }
        self.pending.push_str(&text[start..]);
    }
}
