//! What a terminal's bytes mean, without I/O (ADR 0142): the prompt the person's shell draws,
//! found in its output by a secret mark, and the lines the person entered, for the hand-back
//! note. Every buffer here is bounded.

/// The mark the person's shell draws before each prompt: an OSC that terminals ignore, carrying a
/// token only Spade and that shell know (it is never exported, so no program the shell starts
/// sees it).
pub fn prompt_mark(token: &str) -> Vec<u8> {
    format!("\x1b]777;spade-prompt;{token}\x07").into_bytes()
}

/// Finds the prompt mark in a stream fed chunk by chunk; a mark may be split across chunks. Holds
/// at most the mark's length less one byte between chunks.
#[derive(Debug, Clone)]
pub struct PromptMarks {
    mark: Vec<u8>,
    carry: Vec<u8>,
}

impl PromptMarks {
    pub fn new(token: &str) -> Self {
        Self {
            mark: prompt_mark(token),
            carry: Vec::new(),
        }
    }

    /// Takes the next chunk; answers whether a prompt was drawn in it.
    pub fn feed(&mut self, chunk: &[u8]) -> bool {
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        let found = data.windows(self.mark.len()).any(|w| w == self.mark);
        let keep = data.len().min(self.mark.len() - 1);
        self.carry = data.split_off(data.len() - keep);
        found
    }
}

/// Lines the person entered, kept for the hand-back note: at most this many, each this long.
pub const MOST_LINES: usize = 50;
pub const LINE_CHARS: usize = 300;

/// Follows the person's typing well enough to tell each line they entered: printable text,
/// backspace, Ctrl-U and Ctrl-C (which drop the line) and escape sequences (arrow keys, which are
/// skipped). Tab completion and history are the shell's and are not seen, so a line is what they
/// typed, not always what ran.
#[derive(Debug, Default, Clone)]
pub struct Lines {
    current: String,
    escape: Escape,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum Escape {
    #[default]
    None,
    Started,
    Csi,
    Ss3,
}

impl Lines {
    /// Takes typed bytes; answers each line entered (Return), in order, empty ones included, so
    /// the caller can tell which Return answered which prompt. Whether a line is kept is the
    /// caller's to decide: only one entered right after the shell drew its prompt is a command.
    pub fn feed(&mut self, typed: &[u8]) -> Vec<String> {
        let mut entered = Vec::new();
        for c in String::from_utf8_lossy(typed).chars() {
            match self.escape {
                Escape::Started => {
                    self.escape = match c {
                        '[' => Escape::Csi,
                        'O' => Escape::Ss3,
                        _ => Escape::None,
                    };
                    continue;
                }
                Escape::Csi => {
                    if ('\x40'..='\x7e').contains(&c) {
                        self.escape = Escape::None;
                    }
                    continue;
                }
                Escape::Ss3 => {
                    self.escape = Escape::None;
                    continue;
                }
                Escape::None => {}
            }
            match c {
                '\x1b' => self.escape = Escape::Started,
                '\r' | '\n' => {
                    let line = std::mem::take(&mut self.current);
                    entered.push(line.trim().chars().take(LINE_CHARS).collect());
                }
                '\x7f' | '\x08' => {
                    self.current.pop();
                }
                '\x15' | '\x03' => self.current.clear(),
                c if c.is_control() => {}
                c => {
                    if self.current.chars().count() < LINE_CHARS * 4 {
                        self.current.push(c);
                    }
                }
            }
        }
        entered
    }
}

/// Output as a terminal shows it: `\n` becomes `\r\n` (a pipe's output never went through a
/// terminal's line discipline).
pub fn as_terminal(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len() + bytes.len() / 16);
    let mut previous = 0u8;
    for &byte in bytes {
        if byte == b'\n' && previous != b'\r' {
            out.push(b'\r');
        }
        out.push(byte);
        previous = byte;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prompt_mark_is_found_even_split_and_only_with_its_token() {
        let mut marks = PromptMarks::new("t0k3n");
        let drawn = [b"ls\r\n".as_slice(), &prompt_mark("t0k3n"), b"$ "].concat();
        let found = drawn
            .iter()
            .any(|byte| marks.feed(std::slice::from_ref(byte)));
        assert!(found);
        let mut others = PromptMarks::new("t0k3n");
        assert!(!others.feed(&prompt_mark("forged")));
    }

    #[test]
    fn the_prompt_scanner_holds_no_more_than_one_mark() {
        let mut marks = PromptMarks::new("t0k3n");
        let partial = &prompt_mark("t0k3n")[..10];
        for _ in 0..10_000 {
            marks.feed(partial);
        }
        assert!(marks.carry.len() < prompt_mark("t0k3n").len());
    }

    #[test]
    fn lines_follow_editing_keys_and_skip_arrow_keys() {
        let mut lines = Lines::default();
        assert_eq!(lines.feed(b"lsx\x7f -la\r"), vec!["ls -la".to_owned()]);
        assert_eq!(lines.feed(b"rm -rf /\x15echo hi\x1b[A\r"), vec!["echo hi"]);
        assert_eq!(lines.feed(b"half"), Vec::<String>::new());
        assert_eq!(lines.feed(b" done\r\r"), vec!["half done", ""]);
        assert_eq!(lines.feed(b"oops\x03\r"), vec![""]);
    }

    #[test]
    fn piped_output_is_shown_with_terminal_line_ends() {
        assert_eq!(as_terminal(b"a\nb\r\nc"), b"a\r\nb\r\nc");
    }
}
