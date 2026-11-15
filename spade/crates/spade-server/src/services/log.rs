//! A service's output as numbered lines, keeping the newest up to [`LOG_BYTES`]. Pure.

use std::collections::VecDeque;

/// The most of a service's output kept, in bytes of text.
pub const LOG_BYTES: usize = 256 * 1024;
/// The longest line kept; the rest of a longer one is dropped.
const LONGEST_LINE: usize = 4096;

/// One line of output and its number, from 1.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Line {
    pub n: u64,
    pub text: String,
}

#[derive(Debug)]
pub struct Log {
    lines: VecDeque<Line>,
    bytes: usize,
    next: u64,
    /// The end of the output that is not a whole line yet.
    partial: Vec<u8>,
}

impl Default for Log {
    fn default() -> Self {
        Self {
            lines: VecDeque::new(),
            bytes: 0,
            next: 1,
            partial: Vec::new(),
        }
    }
}

impl Log {
    /// Adds output; answers the lines it completed.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        let mut done = Vec::new();
        for &byte in bytes {
            if byte == b'\n' {
                done.push(self.take_partial());
            } else if self.partial.len() < LONGEST_LINE {
                self.partial.push(byte);
            }
        }
        for text in &done {
            self.keep(text.clone());
        }
        done
    }

    /// The output ended: a last line without its newline is kept.
    pub fn finish(&mut self) {
        if !self.partial.is_empty() {
            let text = self.take_partial();
            self.keep(text);
        }
    }

    fn take_partial(&mut self) -> String {
        let raw = std::mem::take(&mut self.partial);
        let text = String::from_utf8_lossy(&raw);
        text.trim_end_matches('\r').to_owned()
    }

    fn keep(&mut self, text: String) {
        self.bytes += text.len();
        self.lines.push_back(Line { n: self.next, text });
        self.next += 1;
        while self.bytes > LOG_BYTES {
            match self.lines.pop_front() {
                Some(old) => self.bytes -= old.text.len(),
                None => break,
            }
        }
    }

    /// The last `most` lines numbered after `after`.
    pub fn tail(&self, after: u64, most: usize) -> Vec<Line> {
        let newer: Vec<&Line> = self.lines.iter().filter(|l| l.n > after).collect();
        let skip = newer.len().saturating_sub(most);
        newer.into_iter().skip(skip).cloned().collect()
    }

    /// The number the next line gets.
    pub fn next(&self) -> u64 {
        self.next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_splits_into_numbered_lines_across_chunks() {
        let mut log = Log::default();
        assert_eq!(log.push(b"starting\r\nlisten"), vec!["starting"]);
        assert_eq!(log.push(b"ing on :3000\nhalf"), vec!["listening on :3000"]);
        log.finish();
        let all: Vec<(u64, String)> = log.tail(0, 10).into_iter().map(|l| (l.n, l.text)).collect();
        assert_eq!(
            all,
            vec![
                (1, "starting".to_owned()),
                (2, "listening on :3000".to_owned()),
                (3, "half".to_owned())
            ]
        );
        assert_eq!(log.tail(1, 1).len(), 1);
        assert_eq!(log.tail(1, 1)[0].n, 3);
        assert_eq!(log.next(), 4);
    }

    #[test]
    fn the_oldest_lines_go_once_the_log_is_full() {
        let mut log = Log::default();
        let line = "x".repeat(1000);
        for _ in 0..400 {
            log.push(format!("{line}\n").as_bytes());
        }
        let kept = log.tail(0, usize::MAX);
        assert!(kept.len() <= LOG_BYTES / 1000);
        assert_eq!(kept.last().map(|l| l.n), Some(400));
        assert!(kept[0].n > 1);
    }
}
