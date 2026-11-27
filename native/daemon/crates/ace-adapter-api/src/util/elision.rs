// SPDX-License-Identifier: Apache-2.0
//! Streaming elision of heavy JSON strings in provider output.
//!
//! Providers store images inline as base64: OpenCode attachments and tool
//! output as data URLs, Codex generated images as raw base64. One image is
//! megabytes, and every history page, event or JSON-RPC line that carries it
//! would be too. ace never reads those bytes back; it needs the structure
//! around them. So a string that outgrows `hold_bytes` and looks binary is
//! replaced with a short placeholder, and any other string keeps its first
//! `text_bytes` plus a marker.
//!
//! Work is one pass over the bytes and memory is `hold_bytes` per stream,
//! whatever the input size. A raw line feed closes any open string: valid
//! JSON never has one inside a string, and SSE and JSON-RPC frames are
//! line-delimited, so a malformed frame cannot desynchronise the next one.
//!
//! Ported from `packages/provider-kit/src/elision.ts`; the TypeScript module
//! stays for the daemon code that still uses it.

use crate::error::AdapterApiError;

/// How much of a string the elider holds and keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElisionLimits {
    /// Bytes held back to decide binary or prose (at least 64).
    pub hold_bytes: usize,
    /// Bytes of a prose string kept before truncating (at least `hold_bytes`).
    pub text_bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    Outside,
    Holding,
    Passing,
    Eliding,
    Truncating,
}

/// Streams JSON bytes, replacing heavy strings with short placeholders.
/// Feed input with `push`, appending emitted bytes to `out`; `end` flushes an
/// unterminated string as-is for the caller's parser to report.
pub struct JsonElider {
    limits: ElisionLimits,
    hold: Vec<u8>,
    held: usize,
    mode: Mode,
    escape: bool,
    unicode: u8,
    bytes: u64,
    label: Vec<u8>,
}

impl JsonElider {
    /// Starts an elider. Rejects the limits the TypeScript's constructor
    /// throws a `RangeError` for.
    pub fn new(limits: ElisionLimits) -> Result<Self, AdapterApiError> {
        if limits.hold_bytes < 64 || limits.text_bytes < limits.hold_bytes {
            return Err(AdapterApiError::Frame(format!(
                "invalid JSON elision limits: hold_bytes={} text_bytes={}",
                limits.hold_bytes, limits.text_bytes
            )));
        }
        Ok(JsonElider {
            hold: vec![0; limits.hold_bytes],
            limits,
            held: 0,
            mode: Mode::Outside,
            escape: false,
            unicode: 0,
            bytes: 0,
            label: Vec::new(),
        })
    }

    /// Feeds a chunk, appending at most the chunk's share of output to `out`.
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<u8>) {
        self.push_inner(chunk, out, &mut None);
    }

    /// Like `push`, but records where each emitted piece ends in `out`. The
    /// TypeScript's elider calls its `out` callback once per piece, and a
    /// downstream stage that must run per piece (the OpenCode event bound and
    /// the SDK's reader) needs the same boundaries.
    pub fn push_pieces(&mut self, chunk: &[u8], out: &mut Vec<u8>, ends: &mut Vec<usize>) {
        self.push_inner(chunk, out, &mut Some(ends));
    }

    fn push_inner(&mut self, chunk: &[u8], out: &mut Vec<u8>, ends: &mut Option<&mut Vec<usize>>) {
        let mut from = 0;
        for (i, byte) in chunk.iter().enumerate() {
            let byte = *byte;
            if self.mode == Mode::Outside {
                if byte != b'"' {
                    continue;
                }
                emit(out, ends, &chunk[from..i + 1]);
                from = i + 1;
                self.open();
                continue;
            }
            let closes = byte == b'\n' || (byte == b'"' && !self.escape && self.unicode == 0);
            if closes {
                // A passing string is still part of the pending range; anything
                // else was emitted here.
                if self.mode != Mode::Passing {
                    from = i;
                }
                self.close(out, ends);
                continue;
            }
            if self.mode == Mode::Passing
                && self.bytes >= self.limits.text_bytes as u64
                && !self.escape
                && self.unicode == 0
                && !(0x80..0xc0).contains(&byte)
            {
                // Cut only between whole characters and escapes so the kept
                // head stays valid JSON.
                emit(out, ends, &chunk[from..i]);
                self.mode = Mode::Truncating;
            }
            self.track(byte);
            if self.mode != Mode::Holding {
                continue;
            }
            self.hold[self.held] = byte;
            self.held += 1;
            if self.held < self.limits.hold_bytes {
                continue;
            }
            match binary_label(&self.hold[..self.held]) {
                Some(label) => {
                    self.label.clear();
                    self.label.extend_from_slice(label);
                    self.mode = Mode::Eliding;
                }
                None => {
                    emit(out, ends, &self.hold[..self.held]);
                    self.held = 0;
                    self.mode = Mode::Passing;
                    from = i + 1;
                }
            }
        }
        if self.mode == Mode::Outside || self.mode == Mode::Passing {
            emit(out, ends, &chunk[from..]);
        }
    }

    /// Flushes an unterminated string as-is; the caller's parser reports the
    /// malformed body.
    pub fn end(&mut self, out: &mut Vec<u8>) {
        self.end_inner(out, &mut None);
    }

    /// Like `end`, with the pieces it emits recorded as `push_pieces` records them.
    pub fn end_pieces(&mut self, out: &mut Vec<u8>, ends: &mut Vec<usize>) {
        self.end_inner(out, &mut Some(ends));
    }

    fn end_inner(&mut self, out: &mut Vec<u8>, ends: &mut Option<&mut Vec<usize>>) {
        if self.mode != Mode::Outside {
            self.close(out, ends);
        }
    }

    fn open(&mut self) {
        self.mode = Mode::Holding;
        self.held = 0;
        self.bytes = 0;
        self.escape = false;
        self.unicode = 0;
    }

    fn track(&mut self, byte: u8) {
        self.bytes += 1;
        if self.unicode > 0 {
            self.unicode -= 1;
        } else if self.escape {
            self.escape = false;
            if byte == b'u' {
                self.unicode = 4;
            }
        } else if byte == b'\\' {
            self.escape = true;
        }
    }

    fn close(&mut self, out: &mut Vec<u8>, ends: &mut Option<&mut Vec<usize>>) {
        // The hold buffer is reused, so emitted held bytes are a copy the
        // consumer may keep.
        match self.mode {
            Mode::Holding => emit(out, ends, &self.hold[..self.held]),
            Mode::Eliding => {
                let mut marker = Vec::with_capacity(self.label.len() + 32);
                marker.extend_from_slice(b"[ace: ");
                marker.extend_from_slice(self.bytes.to_string().as_bytes());
                marker.extend_from_slice(b" bytes of ");
                marker.extend_from_slice(&self.label);
                marker.extend_from_slice(b" elided]");
                emit(out, ends, &marker);
            }
            Mode::Truncating => {
                let marker = format!(
                    "[ace: {} more bytes truncated]",
                    self.bytes - self.limits.text_bytes as u64
                );
                emit(out, ends, marker.as_bytes());
            }
            Mode::Outside | Mode::Passing => {}
        }
        self.held = 0;
        self.mode = Mode::Outside;
    }
}

/// Appends one emitted piece. `ends` records where it ends, one entry per
/// non-empty piece, which is what the TypeScript's `#emit` enqueues.
fn emit(out: &mut Vec<u8>, ends: &mut Option<&mut Vec<usize>>, bytes: &[u8]) {
    if !bytes.is_empty() {
        out.extend_from_slice(bytes);
        if let Some(ends) = ends.as_deref_mut() {
            ends.push(out.len());
        }
    }
}

/// What the held head is, when it looks binary: a data-URL header, or plain
/// base64 data. Mirrors the TypeScript's `binaryLabel`, including its ASCII
/// header decode and its acceptance of `=` inside the hold window.
fn binary_label(hold: &[u8]) -> Option<&[u8]> {
    // data:<mime>[;params];base64,<payload>
    if hold.starts_with(b"data:")
        && let Some(comma) = hold.iter().position(|byte| *byte == b',')
        && comma > 0
        && comma <= 256
        && let Ok(header) = std::str::from_utf8(&hold[..comma])
        && is_data_header(header)
    {
        return Some(&hold[..comma]);
    }
    if hold.iter().all(|byte| is_elision_byte(*byte)) {
        return Some(b"base64 data");
    }
    None
}

fn is_mime_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '+' | '-')
}

fn is_data_header(header: &str) -> bool {
    let rest = match header.strip_prefix("data:") {
        Some(rest) => rest,
        None => return false,
    };
    let slash = match rest.find('/') {
        Some(slash) => slash,
        None => return false,
    };
    let (mime_type, after_slash) = rest.split_at(slash);
    let subtype = &after_slash[1..];
    if !is_mime_token(mime_type) || subtype.is_empty() {
        return false;
    }
    let mut at = subtype.find(';').unwrap_or(subtype.len());
    if !is_mime_token(&subtype[..at]) {
        return false;
    }
    while at < subtype.len() {
        // Each parameter is `;key=value`; the header ends with `;base64`.
        if subtype[at..].starts_with(";base64") && at + ";base64".len() == subtype.len() {
            return true;
        }
        if !subtype[at..].starts_with(';') {
            return false;
        }
        let key_start = at + 1;
        let key_end = subtype[key_start..]
            .find(|c: char| !is_mime_char(c))
            .map_or(subtype.len(), |i| key_start + i);
        if key_end == key_start || subtype.as_bytes().get(key_end) != Some(&b'=') {
            return false;
        }
        let value_start = key_end + 1;
        let value_end = subtype[value_start..]
            .find(|c: char| !is_mime_char(c))
            .map_or(subtype.len(), |i| value_start + i);
        if value_end == value_start {
            return false;
        }
        at = value_end;
    }
    false
}

fn is_mime_token(token: &str) -> bool {
    !token.is_empty() && token.chars().all(is_mime_char)
}

/// The TypeScript's hold-window alphabet: base64 plus `=` and the URL-safe
/// pair, so a padded or URL-safe payload still elides.
fn is_elision_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
}

#[cfg(test)]
mod tests {
    use super::{ElisionLimits, JsonElider};

    const LIMITS: ElisionLimits = ElisionLimits {
        hold_bytes: 64,
        text_bytes: 128,
    };

    fn elide(input: &str, chunk_bytes: usize) -> String {
        let bytes = input.as_bytes();
        let mut out = Vec::new();
        let mut elider = JsonElider::new(LIMITS).expect("valid limits");
        let mut at = 0;
        while at < bytes.len() {
            let end = (at + chunk_bytes).min(bytes.len());
            elider.push(&bytes[at..end], &mut out);
            at = end;
        }
        elider.end(&mut out);
        String::from_utf8(out).expect("elider keeps valid UTF-8")
    }

    #[test]
    fn heavy_strings_elide_and_the_rest_survives_intact() {
        for chunk_bytes in [1, 7, 64, 4096] {
            let image = format!("data:image/png;base64,{}", "QUJD".repeat(64));
            let data = "QUJD".repeat(64);
            let text = "héllo wörld \\u00e9 \u{1F600} ".repeat(16);
            // The object is stringified, as `JSON.stringify` does in the
            // TypeScript case, so the literal backslash is escaped.
            let value = ace_json::to_string(&ace_json::json!({
                "small": "a\"quoted\\ value",
                "image": image,
                "data": data,
                "text": text,
                "nested": [{ "keep": "x".repeat(40) }],
            }));
            let parsed = ace_json::parse(&elide(&value, chunk_bytes)).expect("stays JSON");
            assert_eq!(parsed["small"], ace_json::json!("a\"quoted\\ value"));
            assert_eq!(
                parsed["nested"],
                ace_json::json!([{"keep": "x".repeat(40)}])
            );
            assert_eq!(
                parsed["image"],
                ace_json::json!(format!(
                    "[ace: {} bytes of data:image/png;base64 elided]",
                    image.len()
                )),
                "chunk {chunk_bytes}"
            );
            assert_eq!(
                parsed["data"],
                ace_json::json!(format!("[ace: {} bytes of base64 data elided]", data.len())),
                "chunk {chunk_bytes}"
            );
            let kept = parsed["text"].as_str().expect("text stays text");
            let at = kept.rfind("[ace:").expect("truncation marker");
            assert!(text.starts_with(&kept[..at]), "chunk {chunk_bytes}");
            let digits = kept[at..]
                .strip_prefix("[ace: ")
                .and_then(|tail| tail.strip_suffix(" more bytes truncated]"));
            assert!(
                digits
                    .is_some_and(|digits| !digits.is_empty()
                        && digits.bytes().all(|byte| byte.is_ascii_digit())),
                "chunk {chunk_bytes}: {kept:?}"
            );
        }
    }

    #[test]
    fn a_line_feed_ends_an_unterminated_string_for_the_next_frame() {
        let output = elide(
            "data: {\"a\":\"{}\"}\n\ndata: {\"b\":\"ok\"}\n\n"
                .replace("{}", &"Q".repeat(200))
                .as_str(),
            5,
        );
        assert_eq!(output.split("\n\n").nth(1), Some("data: {\"b\":\"ok\"}"));
    }

    #[test]
    fn pieces_are_where_the_type_script_callback_runs() {
        let mut out = Vec::new();
        let mut ends = Vec::new();
        let mut elider = JsonElider::new(LIMITS).expect("valid limits");
        // `x "` then the string's bytes, then ` y`: three pieces.
        elider.push_pieces(b"x \"abc\" y", &mut out, &mut ends);
        assert_eq!(
            String::from_utf8(out.clone()).expect("UTF-8"),
            "x \"abc\" y"
        );
        assert_eq!(ends, vec![3, 6, 9]);

        // A held string emits nothing until it closes or the stream ends.
        out.clear();
        ends.clear();
        elider.push_pieces(b"\"abcdef", &mut out, &mut ends);
        assert_eq!(ends, vec![1], "the opening quote's outside text");
        elider.push_pieces(b"abcdef", &mut out, &mut ends);
        assert_eq!(ends, vec![1], "the hold window has not decided yet");
        elider.end_pieces(&mut out, &mut ends);
        assert_eq!(ends, vec![1, 13], "the flush is its own piece");

        // An elided string emits its marker, then the closing quote as the
        // outside text resumes: the TypeScript enqueues both.
        out.clear();
        ends.clear();
        let image = format!("\"data:image/png;base64,{}\"", "QUJD".repeat(64));
        elider.push_pieces(image.as_bytes(), &mut out, &mut ends);
        assert_eq!(
            ends.len(),
            3,
            "the opening quote, the marker, the closing quote"
        );
        assert_eq!(ends[2], out.len(), "the last piece ends the output");
    }

    #[test]
    fn invalid_limits_are_rejected() {
        assert!(
            JsonElider::new(ElisionLimits {
                hold_bytes: 63,
                text_bytes: 128
            })
            .is_err()
        );
        assert!(
            JsonElider::new(ElisionLimits {
                hold_bytes: 64,
                text_bytes: 63
            })
            .is_err()
        );
    }
}
