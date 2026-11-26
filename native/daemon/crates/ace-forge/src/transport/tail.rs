// SPDX-License-Identifier: Apache-2.0
#![allow(clippy::expect_used)]
//! Bounded log tails (`tail.ts`) and the runner's stderr window (ADR 0224 §8a rule 3): the
//! whole window is decoded once, its cut line dropped, and everything redacted before it is
//! clipped, matched or projected, so a secret straddling the cut is never half-kept.

use ace_redaction::EnvironmentMatcher;

/// The largest tail kept: a full job log for the PR panel.
pub const MAX_TAIL_BYTES: usize = 2_097_152;
/// A single line longer than this is replaced rather than retained.
const MAX_LINE_BYTES: usize = 65_536;

/// `redact.ts`'s text mask: see [`super::redact`].
pub fn redact(text: &str, environment: Option<&EnvironmentMatcher>) -> String {
    super::redact::redact(text, environment)
}

/// A fixed byte ring over whole lines, each redacted before it is kept.
#[derive(Debug)]
pub struct LogTail {
    ring: Vec<u8>,
    position: usize,
    bytes: usize,
    line: String,
    line_bytes: usize,
    /// Bytes of the unfinished last line: decoding waits for its newline, so a character
    /// split across two chunks is read whole (the TypeScript's `StringDecoder`).
    pending: Vec<u8>,
    discard: bool,
    truncated: bool,
    environment: Option<EnvironmentMatcher>,
}

impl LogTail {
    /// A tail keeping the newest `cap` bytes (16 KiB by default).
    pub fn new(cap: usize) -> Option<LogTail> {
        if cap == 0 || cap > MAX_TAIL_BYTES {
            return None;
        }
        Some(LogTail {
            ring: vec![0; cap],
            position: 0,
            bytes: 0,
            line: String::new(),
            line_bytes: 0,
            pending: Vec::new(),
            discard: false,
            truncated: false,
            environment: None,
        })
    }

    /// The request's credential values, masked in every kept line.
    pub fn with_environment(mut self, environment: EnvironmentMatcher) -> LogTail {
        self.environment = Some(environment);
        self
    }

    /// One chunk of stdout; only the bytes up to the last newline are decoded, so a
    /// character split across chunks is read whole.
    pub fn write(&mut self, chunk: &[u8]) {
        self.pending.extend_from_slice(chunk);
        // A single line longer than the cap is discarded, and its bytes need not be kept.
        if self.pending.len() > MAX_LINE_BYTES.saturating_mul(2) && !self.pending.contains(&b'\n') {
            self.pending.clear();
            self.line.clear();
            self.line_bytes = 0;
            self.discard = true;
            self.truncated = true;
            return;
        }
        if let Some(cut) = self.pending.iter().rposition(|byte| *byte == b'\n') {
            let complete: Vec<u8> = self.pending.drain(..=cut).collect();
            self.consume(&String::from_utf8_lossy(&complete));
        }
    }

    /// The kept text (newest bytes) and whether older output was dropped.
    pub fn finish(mut self) -> (String, bool) {
        if !self.pending.is_empty() {
            let rest = String::from_utf8_lossy(&self.pending).into_owned();
            self.pending.clear();
            self.consume(&rest);
        }
        if !self.line.is_empty() || self.discard {
            let line = if self.discard {
                String::from("[oversized log line omitted]")
            } else {
                redact(&self.line, self.environment.as_ref())
            };
            self.append(&line);
        }
        self.line.clear();
        self.line_bytes = 0;
        self.discard = false;
        let start = (self.position + self.ring.len() - self.bytes) % self.ring.len();
        let mut output: Vec<u8> = Vec::with_capacity(self.bytes);
        output.extend_from_slice(&self.ring[start..(start + self.bytes).min(self.ring.len())]);
        if start + self.bytes > self.ring.len() {
            output.extend_from_slice(&self.ring[..start + self.bytes - self.ring.len()]);
        }
        // Never emit a partial UTF-8 character at the truncated start.
        let offset = output
            .iter()
            .position(|byte| byte & 0xc0 != 0x80)
            .unwrap_or(0);
        (
            String::from_utf8_lossy(&output[offset..]).into_owned(),
            self.truncated,
        )
    }

    fn consume(&mut self, text: &str) {
        let mut start = 0;
        for (offset, character) in text.char_indices() {
            if character != '\n' {
                continue;
            }
            self.line_part(&text[start..offset]);
            self.append_line();
            start = offset + 1;
        }
        if start < text.len() {
            self.line_part(&text[start..]);
        }
    }

    fn line_part(&mut self, part: &str) {
        if self.discard {
            return;
        }
        self.line_bytes += part.len();
        self.line.push_str(part);
        if self.line_bytes > MAX_LINE_BYTES {
            self.line.clear();
            self.line_bytes = 0;
            self.discard = true;
            self.truncated = true;
        }
    }

    fn append_line(&mut self) {
        let line = if self.discard {
            String::from("[oversized log line omitted]")
        } else {
            redact(&self.line, self.environment.as_ref())
        };
        self.append(&line);
        self.append("\n");
        self.line.clear();
        self.line_bytes = 0;
        self.discard = false;
    }

    fn append(&mut self, text: &str) {
        let bytes = text.as_bytes();
        self.truncated |= self.bytes + bytes.len() > self.ring.len();
        let kept = &bytes[bytes.len().saturating_sub(self.ring.len())..];
        for byte in kept {
            self.ring[self.position] = *byte;
            self.position = (self.position + 1) % self.ring.len();
        }
        self.bytes = (self.bytes + kept.len()).min(self.ring.len());
    }
}

/// The runner's stderr window: a bounded byte window, decoded once, its cut line dropped.
#[derive(Debug, Default)]
pub struct StderrWindow {
    bytes: Vec<u8>,
    cut: bool,
}

/// The window the runner keeps, and the characters it reports.
pub const STDERR_WINDOW_BYTES: usize = 4_096;
/// The characters the runner keeps after redacting and clipping.
pub const STDERR_REPORTED_UNITS: usize = 4_096;

impl StderrWindow {
    /// Keeps at most [`STDERR_WINDOW_BYTES`] of the first stderr; `more` marks a cut.
    pub fn accept(&mut self, chunk: &[u8]) {
        if self.bytes.len() >= STDERR_WINDOW_BYTES {
            if !chunk.is_empty() {
                self.cut = true;
            }
            return;
        }
        let room = STDERR_WINDOW_BYTES - self.bytes.len();
        if chunk.len() > room {
            self.bytes.extend_from_slice(&chunk[..room]);
            self.cut = true;
            return;
        }
        self.bytes.extend_from_slice(chunk);
    }

    /// The window redacted whole, its partial last line dropped, then clipped for reporting.
    pub fn diagnostics(&self, environment: Option<&EnvironmentMatcher>) -> String {
        let decoded = String::from_utf8_lossy(&self.bytes);
        // A cut inside a line leaves half a line: its marker's value would be out of view, so
        // the line is dropped after redaction (before clipping would have cut a secret).
        let window = if self.cut {
            match decoded.rfind('\n') {
                Some(end) => &decoded[..=end],
                None => "",
            }
        } else {
            decoded.as_ref()
        };
        let redacted = redact(window, environment);
        clip_units(&redacted, STDERR_REPORTED_UNITS)
    }
}

/// `text` cut to `units` UTF-16 code units, as the TypeScript's `.slice` does.
pub fn clip_units(text: &str, units: usize) -> String {
    if ace_json::utf16_len(text) <= units {
        return text.to_owned();
    }
    let mut kept = String::new();
    let mut count = 0;
    for character in text.chars() {
        let width = character.len_utf16();
        if count + width > units {
            break;
        }
        kept.push(character);
        count += width;
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::{LogTail, STDERR_WINDOW_BYTES, StderrWindow, clip_units, redact};
    use ace_redaction::EnvironmentMatcher;

    #[test]
    fn a_tail_keeps_the_newest_bytes_and_redacts_before_it_stores() {
        let mut tail = LogTail::new(80).expect("valid cap");
        tail.write("old\n".repeat(100).as_bytes());
        tail.write(b"ghp_12345678901234567890\n");
        let (text, truncated) = tail.finish();
        assert!(text.len() <= 80, "{text}");
        assert!(text.contains("[REDACTED]"), "{text}");
        assert!(!text.contains("ghp_"), "{text}");
        assert!(truncated);
    }

    #[test]
    fn an_oversized_line_is_replaced_not_kept() {
        let mut tail = LogTail::new(100).expect("valid cap");
        tail.write("x".repeat(100_000).as_bytes());
        tail.write(b"\nlast\n");
        let (text, truncated) = tail.finish();
        assert_eq!(text, "[oversized log line omitted]\nlast\n");
        assert!(truncated);
    }

    #[test]
    fn a_character_split_across_chunks_is_kept_whole() {
        let mut tail = LogTail::new(4_096).expect("valid cap");
        let bytes = "caf\u{e9} line\n".as_bytes();
        for chunk in bytes.chunks(2) {
            tail.write(chunk);
        }
        let (text, _) = tail.finish();
        assert_eq!(text, "caf\u{e9} line\n");
        assert!(!text.contains('\u{fffd}'));
    }

    #[test]
    fn a_tail_cap_must_be_positive_and_bounded() {
        assert!(LogTail::new(0).is_none());
        assert!(LogTail::new(2_097_153).is_none());
        assert!(LogTail::new(1).is_some());
    }

    #[test]
    fn a_bare_environment_value_is_masked_in_a_kept_line() {
        let environment = EnvironmentMatcher::new(&["opaque-echoed-value"]);
        let mut tail = LogTail::new(4_096)
            .expect("valid cap")
            .with_environment(environment);
        tail.write(b"pushed with opaque-echoed-value\n");
        let (text, _) = tail.finish();
        assert_eq!(text, "pushed with [REDACTED]\n");
    }

    #[test]
    fn a_secret_straddling_the_stderr_cut_is_masked_whole() {
        // The window ends inside the token; redaction runs over the whole window first, so the
        // half kept is still a secret prefix and is masked, never leaked.
        let mut window = StderrWindow::default();
        let padding = "y".repeat(STDERR_WINDOW_BYTES - 20);
        window.accept(format!("{padding}fatal: ghp_12345678901234567890").as_bytes());
        let diagnostics = window.diagnostics(None);
        assert!(!diagnostics.contains("ghp_"), "{diagnostics}");
        assert!(diagnostics.len() <= STDERR_WINDOW_BYTES, "{diagnostics}");
    }

    #[test]
    fn a_cut_line_is_dropped_after_redaction_so_the_window_stays_one_sided() {
        let mut window = StderrWindow::default();
        let padding = "y".repeat(STDERR_WINDOW_BYTES - 40);
        window.accept(
            format!("HTTP/1.1 403 Forbidden\n{padding}\npartial line that continues").as_bytes(),
        );
        let diagnostics = window.diagnostics(None);
        assert!(
            diagnostics.contains("HTTP/1.1 403 Forbidden"),
            "{diagnostics}"
        );
        assert!(!diagnostics.contains("partial"), "{diagnostics}");
    }

    #[test]
    fn clipping_counts_utf16_units() {
        assert_eq!(clip_units("abc", 3), "abc");
        assert_eq!(clip_units("abcd", 3), "abc");
        assert_eq!(clip_units("😀x", 2), "😀");
        assert_eq!(clip_units("😀x", 1), "");
    }

    #[test]
    fn a_caller_marker_replaces_a_credential_shape() {
        assert_eq!(redact("ghp_12345678901234567890", None), "[REDACTED]");
        assert_eq!(
            redact("token=ghp_12345678901234567890", None),
            "token=[REDACTED]"
        );
    }
}
