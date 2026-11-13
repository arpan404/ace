//! What a terminal's bytes mean, without I/O (ADR 0142): a bot command's output cut out of the
//! stream between Spade's markers, that output as plain text for the model, and the lines the
//! person entered, for the hand-back note.

/// Spade's private terminal sequence: an OSC that terminals ignore, so the person's view shows
/// nothing of it. `\x1b]777;spade;<nonce>;start\x07` opens a command's output and
/// `\x1b]777;spade;<nonce>;end;<code>\x07` closes it.
const OSC: &str = "\x1b]777;spade;";

/// The shell line that prints a marker: `printf` turns `\033` and `\007` into the bytes.
pub fn marker_printf(nonce: &str, what: &str) -> String {
    format!("printf '\\033]777;spade;{nonce};{what}\\007'")
}

/// Output kept for one command; the rest is dropped and the result says so.
pub const MOST_CAPTURED: usize = 4 * 1024 * 1024;

/// Where a capture is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// Before the start marker: the echoed line and anything else is not the command's.
    Before,
    In,
    Done,
}

/// Cuts one command's output out of the terminal's stream, fed chunk by chunk; markers may be
/// split across chunks.
#[derive(Debug)]
pub struct Capture {
    start: Vec<u8>,
    end: Vec<u8>,
    phase: Phase,
    /// Bytes that may be the start of a marker, held until the next chunk.
    carry: Vec<u8>,
    output: Vec<u8>,
    cut: bool,
    code: Option<i32>,
}

impl Capture {
    pub fn new(nonce: &str) -> Self {
        Self {
            start: format!("{OSC}{nonce};start\x07").into_bytes(),
            end: format!("{OSC}{nonce};end;").into_bytes(),
            phase: Phase::Before,
            carry: Vec::new(),
            output: Vec::new(),
            cut: false,
            code: None,
        }
    }

    /// Takes the next chunk; answers whether the end marker has now been seen.
    pub fn feed(&mut self, chunk: &[u8]) -> bool {
        if self.phase == Phase::Done {
            return true;
        }
        let mut data = std::mem::take(&mut self.carry);
        data.extend_from_slice(chunk);
        if self.phase == Phase::Before {
            match find(&data, &self.start) {
                Some(at) => {
                    self.phase = Phase::In;
                    data.drain(..at + self.start.len());
                }
                None => {
                    let keep = data.len().min(self.start.len() - 1);
                    self.carry = data.split_off(data.len() - keep);
                    return false;
                }
            }
        }
        if let Some(at) = find(&data, &self.end) {
            let rest = &data[at + self.end.len()..];
            if let Some(bell) = rest.iter().position(|b| *b == 0x07) {
                self.code = std::str::from_utf8(&rest[..bell])
                    .ok()
                    .and_then(|code| code.trim().parse().ok());
                self.keep(&data[..at]);
                self.phase = Phase::Done;
                return true;
            }
            // The code has not all arrived yet.
            self.carry = data.split_off(at);
            self.keep(&data);
            return false;
        }
        // Up to a whole marker and its code may be in the tail.
        let hold = data.len().min(self.end.len() + 12);
        self.carry = data.split_off(data.len() - hold);
        self.keep(&data);
        false
    }

    fn keep(&mut self, bytes: &[u8]) {
        let room = MOST_CAPTURED.saturating_sub(self.output.len());
        if bytes.len() > room {
            self.cut = true;
        }
        self.output
            .extend_from_slice(&bytes[..bytes.len().min(room)]);
    }

    /// Whether the command's output began.
    pub fn started(&self) -> bool {
        self.phase != Phase::Before
    }

    /// The exit code the end marker carried.
    pub fn code(&self) -> Option<i32> {
        self.code
    }

    /// The output so far as plain text, and whether some was dropped. Bytes still held back as a
    /// possible marker are included when the command never finished.
    pub fn output(&self) -> (String, bool) {
        let mut bytes = self.output.clone();
        if self.phase == Phase::In {
            bytes.extend_from_slice(&self.carry);
        }
        (plain(&bytes), self.cut)
    }
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

/// Terminal output as the model reads it: escape sequences (colours, cursor moves, titles) gone,
/// `\r\n` as `\n`, a line redrawn with `\r` (a progress bar) kept as it was last drawn, and
/// backspaces applied.
pub fn plain(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    // Where the line being written starts in `out`, for `\r`.
    let mut line_start = 0;
    let mut overwrite = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => skip_escape(&mut chars),
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    continue;
                }
                overwrite = true;
            }
            '\n' => {
                out.push('\n');
                line_start = out.len();
                overwrite = false;
            }
            '\x08' => {
                if out.len() > line_start {
                    out.pop();
                }
            }
            '\t' => push(&mut out, line_start, &mut overwrite, '\t'),
            c if c.is_control() => {}
            c => push(&mut out, line_start, &mut overwrite, c),
        }
    }
    out
}

/// Writes `c`; after a lone `\r` the line is drawn again from its start, so the old one goes.
fn push(out: &mut String, line_start: usize, overwrite: &mut bool, c: char) {
    if *overwrite {
        out.truncate(line_start);
        *overwrite = false;
    }
    out.push(c);
}

/// Skips the rest of an escape sequence: CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC \`),
/// or a two-character one.
fn skip_escape(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    match chars.next() {
        Some('[') => {
            for c in chars.by_ref() {
                if ('\x40'..='\x7e').contains(&c) {
                    break;
                }
            }
        }
        Some(']' | 'P' | '_' | '^') => {
            while let Some(c) = chars.next() {
                if c == '\x07' {
                    break;
                }
                if c == '\x1b' {
                    chars.next();
                    break;
                }
            }
        }
        Some('(' | ')' | '#') => {
            chars.next();
        }
        _ => {}
    }
}

/// Lines the person entered, kept for the hand-back note: at most this many, each this long.
pub const MOST_LINES: usize = 50;
pub const LINE_CHARS: usize = 300;

/// Follows the person's typing well enough to tell which lines they entered at the shell's
/// prompt: printable text, backspace, Ctrl-U and Ctrl-C (which drop the line) and escape
/// sequences (arrow keys, which are skipped). Tab completion and history are the shell's and are
/// not seen, so a line is what they typed, not always what ran.
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
    /// Takes typed bytes; answers each line entered (Return), in order. The caller decides
    /// whether each was entered at the prompt; a line typed into a program (a password at a
    /// `sudo` prompt) must never be kept.
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
                    let line = line.trim();
                    if !line.is_empty() {
                        entered.push(line.chars().take(LINE_CHARS).collect());
                    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_what_lies_between_the_markers_is_the_commands_output() {
        let mut capture = Capture::new("n1");
        let stream = b"$ . '/tmp/run.sh'\r\n\x1b]777;spade;n1;start\x07hello\r\nworld\r\n\x1b]777;spade;n1;end;3\x07$ ";
        // Fed a byte at a time, so every marker is split.
        let mut done = false;
        for byte in stream {
            done = capture.feed(std::slice::from_ref(byte));
        }
        assert!(done);
        assert_eq!(capture.code(), Some(3));
        assert_eq!(capture.output(), ("hello\nworld\n".to_owned(), false));
    }

    #[test]
    fn another_commands_markers_are_not_this_ones() {
        let mut capture = Capture::new("n2");
        assert!(!capture.feed(b"\x1b]777;spade;n1;start\x07old\x1b]777;spade;n1;end;0\x07"));
        assert!(!capture.started());
        assert!(capture.feed(b"\x1b]777;spade;n2;start\x07new\x1b]777;spade;n2;end;0\x07"));
        assert_eq!(capture.output().0, "new");
    }

    #[test]
    fn a_command_that_never_ends_still_shows_what_it_printed() {
        let mut capture = Capture::new("n3");
        capture.feed(b"\x1b]777;spade;n3;start\x07working");
        assert!(capture.started());
        assert_eq!(capture.output().0, "working");
        assert_eq!(capture.code(), None);
    }

    #[test]
    fn output_past_the_cap_is_dropped_and_said_so_but_the_end_is_still_found() {
        let mut capture = Capture::new("n4");
        capture.feed(b"\x1b]777;spade;n4;start\x07");
        let block = vec![b'x'; 1024 * 1024];
        for _ in 0..5 {
            capture.feed(&block);
        }
        assert!(capture.feed(b"\x1b]777;spade;n4;end;0\x07"));
        let (text, cut) = capture.output();
        assert!(cut);
        assert_eq!(text.len(), MOST_CAPTURED);
    }

    #[test]
    fn plain_text_drops_colours_and_keeps_the_last_drawing_of_a_line() {
        assert_eq!(plain(b"\x1b[31mred\x1b[0m\r\n"), "red\n");
        assert_eq!(plain(b"10%\r50%\r100%\r\ndone\n"), "100%\ndone\n");
        assert_eq!(plain(b"\x1b]0;title\x07ab\x08c"), "ac");
    }

    #[test]
    fn lines_follow_editing_keys_and_skip_arrow_keys() {
        let mut lines = Lines::default();
        assert_eq!(lines.feed(b"lsx\x7f -la\r"), vec!["ls -la".to_owned()]);
        assert_eq!(lines.feed(b"rm -rf /\x15echo hi\x1b[A\r"), vec!["echo hi"]);
        assert_eq!(lines.feed(b"half"), Vec::<String>::new());
        assert_eq!(lines.feed(b" done\r\r"), vec!["half done"]);
        assert_eq!(lines.feed(b"oops\x03\r"), Vec::<String>::new());
    }
}
