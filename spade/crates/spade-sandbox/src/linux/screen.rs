//! What of a command's terminal output reaches the person's terminal (ADR 0167 amendment 1,
//! decision 4). The relay passes the command's output through [`Screen`], a byte-at-a-time state
//! machine that holds its place across reads, so a sequence split between two reads is judged
//! whole. It keeps what draws on the screen: text (UTF-8), newlines, tabs, backspace and the bell,
//! SGR colours and attributes, cursor movement and saving, erasing, scrolling regions, inserting
//! and deleting, line-drawing character sets, keypad and cursor-key modes, cursor visibility and
//! the alternate screen. Everything else is dropped: OSC (clipboard, title, hyperlinks, colours),
//! DCS, APC, PM and SOS strings, window manipulation (`CSI … t`), device and status queries whose
//! answers would come back as input (`CSI n`, `CSI c`, `ENQ`, `ESC Z`), mouse and paste modes,
//! resets and any other private mode. 8-bit C1 controls are dropped too, raw or UTF-8 encoded.
//! Each kept CSI operation takes only the parameters that act within the visible screen
//! ([`acts_on_screen`]: `ESC[3J`, erasing scrollback, is dropped). When the output ends,
//! [`restore`] returns the person's terminal to its defaults unconditionally: what a command
//! sets can't be tracked through cursor save and restore or the alternate screen. Pure: no I/O.

/// Longest CSI sequence judged; a longer one is dropped whole.
const MOST_CSI: usize = 128;
/// DEC private modes kept: cursor keys, autowrap, cursor visible, the alternate screens.
const PRIVATE_MODES: &[&[u8]] = &[b"1", b"7", b"25", b"47", b"1047", b"1048", b"1049"];
/// Final bytes of CSI sequences kept with at most one number: cursor movement, erasing
/// characters, inserting and deleting characters and lines, scrolling and repeating. Every one
/// acts within the visible screen.
const ONE_NUMBER: &[u8] = b"ABCDEFGIPLMSTXZ@`abde";
/// What every finished relay sends, whatever the command did: the main screen, plain text, the
/// ASCII character sets in G0 and G1 with G0 in use, autowrap on, insert mode off, full-screen
/// scroll margins (set between saving and restoring the cursor, since setting them homes it,
/// which also leaves a clean rendition in the cursor-save slot), a visible cursor, and normal
/// cursor and keypad keys.
const RESET: &[u8] =
    b"\x1b[?1047l\x1b[0m\x1b(B\x1b)B\x0f\x1b[?7h\x1b[4l\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?1l\x1b>";
/// Leaves the alternate screen entered with `?1049h`, restoring the cursor it saved. Sent only
/// then: on the main screen it would move the cursor to wherever the command last saved it.
const LEAVE_1049: &[u8] = b"\x1b[?1049l";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    /// After ESC.
    Escape,
    /// After `ESC (` or `ESC )`.
    Charset(u8),
    /// An escape sequence with intermediates, dropped up to its final byte.
    Skip,
    Csi,
    /// A CSI sequence too long to judge, dropped up to its final byte.
    CsiSkip,
    /// An OSC (`osc`, which BEL also ends) or DCS, APC, PM, SOS string, dropped up to its end.
    Text {
        osc: bool,
    },
    /// ESC inside a string: `\` ends it, anything else ends it and starts a new escape.
    TextEscape,
    /// Inside a UTF-8 character, this many bytes still to come.
    Utf8(u8),
}

/// The relay's filter between the command's output and the person's terminal.
#[derive(Debug, Clone)]
pub struct Screen {
    state: State,
    /// The sequence or character being read.
    pending: Vec<u8>,
    /// The byte before, inside a string (`C2 9C` is ST in UTF-8).
    last: u8,
    /// The command is on the alternate screen it entered with `?1049h`.
    alternate: bool,
}

impl Default for Screen {
    fn default() -> Self {
        Self {
            state: State::Ground,
            pending: Vec::new(),
            last: 0,
            alternate: false,
        }
    }
}

impl Screen {
    /// Appends to `out` what of `input` may reach the person's terminal.
    pub fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) {
        for &byte in input {
            self.byte(byte, out);
        }
    }

    /// Whether the command is on the alternate screen it entered with `?1049h`.
    pub fn alternate(&self) -> bool {
        self.alternate
    }

    fn byte(&mut self, byte: u8, out: &mut Vec<u8>) {
        match self.state {
            State::Ground => self.ground(byte, out),
            State::Escape => self.escape(byte, out),
            State::Charset(set) => self.charset(set, byte, out),
            State::Skip => {
                if (0x30..=0x7e).contains(&byte) {
                    self.state = State::Ground;
                } else if !(0x20..=0x2f).contains(&byte) {
                    self.state = State::Ground;
                    self.ground(byte, out);
                }
            }
            State::Csi => self.csi(byte, out),
            State::CsiSkip => {
                if (0x40..=0x7e).contains(&byte) {
                    self.state = State::Ground;
                } else if byte == 0x1b {
                    self.state = State::Escape;
                } else if matches!(byte, 0x18 | 0x1a) || byte >= 0x80 {
                    self.state = State::Ground;
                }
            }
            State::Text { osc } => self.text(osc, byte),
            State::TextEscape => {
                if byte == b'\\' {
                    self.state = State::Ground;
                } else {
                    self.state = State::Escape;
                    self.escape(byte, out);
                }
            }
            State::Utf8(left) => self.utf8(left, byte, out),
        }
    }

    fn ground(&mut self, byte: u8, out: &mut Vec<u8>) {
        match byte {
            0x1b => self.state = State::Escape,
            0x07..=0x0d | 0x20..=0x7f => out.push(byte),
            0x0e | 0x0f => out.push(byte),
            // Leading bytes of 2-, 3- and 4-byte characters; the rest never start one.
            0xc2..=0xdf => self.lead(byte, 1),
            0xe0..=0xef => self.lead(byte, 2),
            0xf0..=0xf4 => self.lead(byte, 3),
            // ENQ and the other C0 controls, stray continuation bytes, raw C1, invalid leads.
            _ => {}
        }
    }

    fn lead(&mut self, byte: u8, left: u8) {
        self.pending.clear();
        self.pending.push(byte);
        self.state = State::Utf8(left);
    }

    fn utf8(&mut self, left: u8, byte: u8, out: &mut Vec<u8>) {
        let first = self.pending.first().copied().unwrap_or(0);
        // The second byte's range excludes overlong forms, surrogates and code points past
        // U+10FFFF, so nothing decodes to a control another way.
        let range = match (self.pending.len(), first) {
            (1, 0xe0) => 0xa0..=0xbf,
            (1, 0xed) => 0x80..=0x9f,
            (1, 0xf0) => 0x90..=0xbf,
            (1, 0xf4) => 0x80..=0x8f,
            _ => 0x80..=0xbf,
        };
        if !range.contains(&byte) {
            self.pending.clear();
            self.state = State::Ground;
            self.ground(byte, out);
            return;
        }
        self.pending.push(byte);
        if left > 1 {
            self.state = State::Utf8(left - 1);
            return;
        }
        self.state = State::Ground;
        if first == 0xc2 && byte <= 0x9f {
            // U+0080 to U+009F: an 8-bit control, read the way a terminal would.
            self.pending.clear();
            self.c1(byte);
            return;
        }
        out.append(&mut self.pending);
    }

    fn c1(&mut self, control: u8) {
        self.state = match control {
            0x9b => {
                self.pending.extend_from_slice(b"\x1b[");
                State::Csi
            }
            0x9d => State::Text { osc: true },
            0x90 | 0x98 | 0x9e | 0x9f => State::Text { osc: false },
            _ => State::Ground,
        };
    }

    fn escape(&mut self, byte: u8, out: &mut Vec<u8>) {
        self.state = State::Ground;
        match byte {
            b'[' => {
                self.pending.clear();
                self.pending.extend_from_slice(b"\x1b[");
                self.state = State::Csi;
            }
            b']' => self.state = State::Text { osc: true },
            b'P' | b'X' | b'^' | b'_' => self.state = State::Text { osc: false },
            b'(' | b')' => self.state = State::Charset(byte),
            0x20..=0x2f => self.state = State::Skip,
            b'7' | b'8' | b'D' | b'E' | b'M' | b'=' | b'>' => out.extend_from_slice(&[0x1b, byte]),
            0x1b => self.state = State::Escape,
            // A control inside an escape: the escape is dropped, the control judged alone.
            0x00..=0x1f => self.ground(byte, out),
            // ESC c (reset), ESC Z (identify), ESC \ alone and anything unknown.
            _ => {}
        }
    }

    fn charset(&mut self, set: u8, byte: u8, out: &mut Vec<u8>) {
        self.state = State::Ground;
        match byte {
            b'0' | b'B' => out.extend_from_slice(&[0x1b, set, byte]),
            0x20..=0x2f => self.state = State::Skip,
            _ => {}
        }
    }

    fn csi(&mut self, byte: u8, out: &mut Vec<u8>) {
        match byte {
            0x20..=0x3f => {
                self.pending.push(byte);
                if self.pending.len() > MOST_CSI {
                    self.pending.clear();
                    self.state = State::CsiSkip;
                }
            }
            0x40..=0x7e => {
                self.state = State::Ground;
                let body = std::mem::take(&mut self.pending);
                self.judge(&body[2..], byte, out);
            }
            0x1b => {
                self.pending.clear();
                self.state = State::Escape;
            }
            0x18 | 0x1a => {
                self.pending.clear();
                self.state = State::Ground;
            }
            // A terminal acts on a control inside a sequence; kept ones are passed on.
            0x07..=0x0d => out.push(byte),
            0x80..=0xff => {
                self.pending.clear();
                self.state = State::Ground;
                self.ground(byte, out);
            }
            _ => {}
        }
    }

    /// One whole CSI sequence: its parameters and final byte.
    fn judge(&mut self, body: &[u8], last: u8, out: &mut Vec<u8>) {
        let digits = |params: &[u8]| {
            params
                .iter()
                .all(|b| b.is_ascii_digit() || *b == b';' || *b == b':')
        };
        if let Some(params) = body.strip_prefix(b"?") {
            if !matches!(last, b'h' | b'l') || !digits(params) {
                return;
            }
            let on = last == b'h';
            let kept: Vec<&[u8]> = params
                .split(|b| *b == b';')
                .filter(|mode| PRIVATE_MODES.contains(mode))
                .collect();
            if kept.is_empty() {
                return;
            }
            for mode in &kept {
                match *mode {
                    b"1049" => self.alternate = on,
                    // Leaving by another mode leaves the screen `?1049l` would restore from.
                    b"47" | b"1047" if !on => self.alternate = false,
                    _ => {}
                }
            }
            out.extend_from_slice(b"\x1b[?");
            out.extend_from_slice(&kept.join(&b';'));
            out.push(last);
            return;
        }
        if !digits(body) {
            // A private marker or intermediates: queries, resets, cursor styles, key modes.
            return;
        }
        if !acts_on_screen(body, last) {
            return;
        }
        out.extend_from_slice(b"\x1b[");
        out.extend_from_slice(body);
        out.push(last);
    }

    fn text(&mut self, osc: bool, byte: u8) {
        let last = std::mem::replace(&mut self.last, byte);
        match byte {
            0x07 if osc => self.state = State::Ground,
            0x1b => self.state = State::TextEscape,
            0x18 | 0x1a => self.state = State::Ground,
            // ST, raw or as UTF-8 (C2 9C).
            0x9c if last == 0xc2 || last < 0x80 => self.state = State::Ground,
            _ => {}
        }
        if self.state != (State::Text { osc }) {
            self.last = 0;
        }
    }
}

/// What returns the person's terminal to how it was: [`RESET`], after leaving a `?1049h`
/// alternate screen when `alternate`.
pub fn restore(alternate: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(LEAVE_1049.len() + RESET.len());
    if alternate {
        out.extend_from_slice(LEAVE_1049);
    }
    out.extend_from_slice(RESET);
    out
}

/// Whether a CSI sequence without a private marker (`body`, its parameters, and `last`) acts
/// only within the visible screen: each operation with only the parameters it takes there.
/// `ESC[3J`, which erases the person's scrollback, is not among them.
fn acts_on_screen(body: &[u8], last: u8) -> bool {
    if last == b'm' {
        // SGR alone takes colon sub-parameters.
        return true;
    }
    if body.contains(&b':') {
        return false;
    }
    let numbers: Vec<&[u8]> = if body.is_empty() {
        Vec::new()
    } else {
        body.split(|b| *b == b';').collect()
    };
    match last {
        b'J' | b'K' => {
            numbers.len() <= 1
                && numbers
                    .first()
                    .is_none_or(|n| matches!(*n, b"" | b"0" | b"1" | b"2"))
        }
        b'H' | b'f' | b'r' => numbers.len() <= 2,
        b's' | b'u' => numbers.is_empty(),
        b'h' | b'l' => body == b"4",
        _ => ONE_NUMBER.contains(&last) && numbers.len() <= 1,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filtered(chunks: &[&[u8]]) -> Vec<u8> {
        let mut screen = Screen::default();
        let mut out = Vec::new();
        for chunk in chunks {
            screen.feed(chunk, &mut out);
        }
        out
    }

    /// What `input` becomes, the same however its bytes are split between reads.
    fn shown(input: &[u8]) -> Vec<u8> {
        let whole = filtered(&[input]);
        for at in 0..=input.len() {
            let (a, b) = input.split_at(at);
            assert_eq!(filtered(&[a, b]), whole, "split at {at} of {input:?}");
        }
        let bytes: Vec<&[u8]> = input.chunks(1).collect();
        assert_eq!(filtered(&bytes), whole, "byte by byte: {input:?}");
        whole
    }

    #[test]
    fn text_and_what_draws_the_screen_pass_unchanged() {
        for kept in [
            "plain text\r\n\ttabbed\x08\x07".as_bytes(),
            "héllo ✓ 🙂 日本".as_bytes(),
            b"\x1b[1;31mred\x1b[0m \x1b[38;5;208m\x1b[48:2::1:2:3mx\x1b[m",
            b"\x1b[10;5H\x1b[2J\x1b[K\x1b[3A\x1b[2C\x1b[s\x1b[u\x1b7\x1b8\x1bM",
            b"\x1b[1;24r\x1b[4h\x1b[4l\x1b[2P\x1b[3@\x1b[L\x1b[M\x1b[5X\x1b[2S\x1b[3b",
            b"\x1b[?1049h\x1b[?25l\x1b[?1h\x1b=\x1b[?7l\x1b[?7h\x1b>\x1b[?1l\x1b[?25h\x1b[?1049l",
            b"\x1b(0lqk\x1b(B\x0e\x0f",
        ] {
            assert_eq!(shown(kept), kept, "{:?}", String::from_utf8_lossy(kept));
        }
    }

    #[test]
    fn clipboard_title_and_other_strings_are_dropped_whole() {
        for (input, left) in [
            (&b"a\x1b]52;c;c2VjcmV0\x07b"[..], &b"ab"[..]),
            (b"a\x1b]52;c;?\x1b\\b", b"ab"),
            (
                b"\x1b]0;title\x07\x1b]2;title\x1b\\\x1b]8;;http://x\x1b\\link",
                b"link",
            ),
            (b"\x1b]10;?\x07\x1b]4;1;rgb:ff/00/00\x07ok", b"ok"),
            (b"\x1bP+q544e\x1b\\\x1bP$qm\x1b\\ok", b"ok"),
            (b"\x1b_Gf=1;AAAA\x1b\\\x1b^pm\x1b\\\x1bXsos\x1b\\ok", b"ok"),
            ("\u{9d}52;c;?\u{9c}ok\u{90}x\u{9c}".as_bytes(), b"ok"),
            // An unterminated string ends at the next escape, which is judged on its own.
            (b"\x1b]52;c;AAAA\x1b[1mbold", b"\x1b[1mbold"),
        ] {
            assert_eq!(shown(input), left, "{:?}", String::from_utf8_lossy(input));
        }
    }

    #[test]
    fn queries_whose_answers_would_come_back_as_input_are_dropped() {
        for query in [
            &b"\x1b[6n"[..],
            b"\x1b[5n",
            b"\x1b[c",
            b"\x1b[>c",
            b"\x1b[=c",
            b"\x1b[>q",
            b"\x1b[?u",
            b"\x1b[?1$p",
            b"\x1b[18t",
            b"\x1b[14t",
            b"\x05",
            b"\x1bZ",
            "\u{9b}6n".as_bytes(),
        ] {
            assert_eq!(shown(&[b"<", query, b">"].concat()), b"<>", "{query:?}");
        }
        // A raw 8-bit CSI is dropped; what followed it is only text then.
        assert_eq!(shown(b"<\x9b6n>"), b"<6n>");
    }

    #[test]
    fn window_mouse_paste_and_reset_controls_are_dropped() {
        for control in [
            &b"\x1b[8;50;100t"[..],
            b"\x1b[3;0;0t",
            b"\x1b[22;0;0t",
            b"\x1b[?1000h",
            b"\x1b[?1006h",
            b"\x1b[?2004h",
            b"\x1b[?3h",
            b"\x1b[?5h",
            b"\x1b[2 q",
            b"\x1b[!p",
            b"\x1b[3g",
            b"\x1bc",
            b"\x1b#8",
            b"\x1bH",
            b"\x1b[>4;2m",
            b"\x1b[20h",
        ] {
            assert_eq!(shown(&[b"<", control, b">"].concat()), b"<>", "{control:?}");
        }
        // Mixed private modes keep only the screen's own.
        assert_eq!(shown(b"\x1b[?1049;1000;25h"), b"\x1b[?1049;25h");
    }

    #[test]
    fn controls_hidden_in_utf8_or_oversized_sequences_are_dropped() {
        // Overlong ESC and CSI, a surrogate, a stray continuation, invalid leads.
        let input = b"a\xe0\x80\x9b6n\xed\xa0\x80\x80\xc0\x9b\xffb";
        let out = shown(input);
        assert!(!out.contains(&0x9b) && !out.contains(&0x1b), "{out:?}");
        assert!(out.starts_with(b"a") && out.ends_with(b"b"));
        let long = [b"\x1b[".as_slice(), &[b'1'; 300], b"mafter"].concat();
        assert_eq!(shown(&long), b"after");
    }

    /// The state of a terminal that the kept sequences can change and that outlives the
    /// command, as xterm keeps it: enough to tell whether the person's terminal is as it was.
    #[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
    struct Rendition {
        /// Any SGR attribute or colour set (concealed, reverse, colours, …).
        styled: bool,
        g0_line_drawing: bool,
        g1_line_drawing: bool,
        shifted: bool,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    struct Model {
        rendition: Rendition,
        /// What DECSC (`ESC 7`, and `?1049h`) saved, which DECRC (`ESC 8`, `?1049l`) restores.
        saved: Rendition,
        alternate: bool,
        autowrap: bool,
        insert: bool,
        full_margins: bool,
        cursor_visible: bool,
        cursor_keys: bool,
        keypad: bool,
    }

    impl Default for Model {
        fn default() -> Self {
            Self {
                rendition: Rendition::default(),
                saved: Rendition::default(),
                alternate: false,
                autowrap: true,
                insert: false,
                full_margins: true,
                cursor_visible: true,
                cursor_keys: false,
                keypad: false,
            }
        }
    }

    impl Model {
        /// Applies what the filter let through (only kept sequences, each whole).
        fn apply(&mut self, mut bytes: &[u8]) {
            while let Some((&first, rest)) = bytes.split_first() {
                bytes = rest;
                match first {
                    0x0e => self.rendition.shifted = true,
                    0x0f => self.rendition.shifted = false,
                    0x1b => bytes = self.escape(bytes),
                    _ => {}
                }
            }
        }

        fn escape<'a>(&mut self, bytes: &'a [u8]) -> &'a [u8] {
            let Some((&kind, rest)) = bytes.split_first() else {
                return bytes;
            };
            match kind {
                b'7' => self.saved = self.rendition,
                b'8' => self.rendition = self.saved,
                b'=' => self.keypad = true,
                b'>' => self.keypad = false,
                b'(' | b')' => {
                    let line = rest.first() == Some(&b'0');
                    if kind == b'(' {
                        self.rendition.g0_line_drawing = line;
                    } else {
                        self.rendition.g1_line_drawing = line;
                    }
                    return &rest[1..];
                }
                b'[' => {
                    let end = rest
                        .iter()
                        .position(|b| (0x40..=0x7e).contains(b))
                        .unwrap_or(rest.len() - 1);
                    self.csi(&rest[..end], rest[end]);
                    return &rest[end + 1..];
                }
                _ => {}
            }
            rest
        }

        fn csi(&mut self, body: &[u8], last: u8) {
            if let Some(modes) = body.strip_prefix(b"?") {
                let on = last == b'h';
                for mode in modes.split(|b| *b == b';') {
                    match mode {
                        b"1" => self.cursor_keys = on,
                        b"7" => self.autowrap = on,
                        b"25" => self.cursor_visible = on,
                        b"47" | b"1047" => self.alternate = on,
                        b"1048" if on => self.saved = self.rendition,
                        b"1048" => self.rendition = self.saved,
                        b"1049" if on => {
                            self.saved = self.rendition;
                            self.alternate = true;
                        }
                        b"1049" => {
                            self.alternate = false;
                            self.rendition = self.saved;
                        }
                        _ => {}
                    }
                }
                return;
            }
            match last {
                b'm' => {
                    for param in body.split(|b| *b == b';') {
                        self.rendition.styled = !matches!(param, b"" | b"0");
                    }
                }
                b'h' | b'l' if body == b"4" => self.insert = last == b'h',
                b'r' => self.full_margins = body.is_empty(),
                b's' => self.saved = self.rendition,
                b'u' => self.rendition = self.saved,
                _ => {}
            }
        }
    }

    /// The person's terminal after the command wrote `output` and the relay finished.
    fn after(output: &[u8]) -> Model {
        let mut screen = Screen::default();
        let mut shown = Vec::new();
        screen.feed(output, &mut shown);
        shown.extend_from_slice(&restore(screen.alternate()));
        let mut model = Model::default();
        model.apply(&shown);
        model
    }

    #[test]
    fn every_mode_a_command_may_set_is_back_as_it_was_after_it_ends() {
        for output in [
            &b"\x1b[?7l"[..],
            b"\x1b[4h",
            b"\x1b[5;10r",
            b"\x1b[?25l\x1b[?1h\x1b=",
            b"\x1b[1;31m\x1b(0\x1b)0\x0e",
            b"\x1b[?1049h\x1b[8m\x1b[?7l\x1b[4h\x1b[2;5r",
            b"\x1b[?47h\x1b[7m",
            b"\x1b[?1047h",
        ] {
            assert_eq!(after(output), Model::default(), "{output:?}");
        }
    }

    #[test]
    fn saving_and_restoring_the_cursor_cant_carry_attributes_past_the_end() {
        for output in [
            // Concealed, saved, plain again, restored: concealed at the end.
            &b"\x1b[8m\x1b7\x1b[0m\x1b8"[..],
            b"\x1b[8m\x1b[s\x1b[0m\x1b[u",
            b"\x1b(0\x1b7\x1b(B\x1b8",
            b"\x1b[8m\x1b[?1048h\x1b[0m\x1b[?1048l",
            // Concealed saved by the alternate screen and restored on leaving it.
            b"\x1b[8m\x1b[?1049h\x1b[0m\x1b[?1049l",
            b"\x1b[?1049h\x1b[8m\x1b7\x1b[0m\x1b8",
            // A concealed rendition left in the saved slot, for the person's prompt to restore.
            b"\x1b[8m\x1b7\x1b[0m",
        ] {
            assert_eq!(after(output), Model::default(), "{output:?}");
        }
    }

    #[test]
    fn the_restore_needs_no_knowledge_of_what_the_command_did() {
        // Even a filter that missed every mode change leaves the terminal as it was: the
        // restore is unconditional.
        let mut model = Model::default();
        model.apply(b"\x1b[?7l\x1b[4h\x1b[3;9r\x1b[8m\x1b7\x1b[?25l\x1b[?1h\x1b=\x1b)0\x0e");
        model.apply(&restore(false));
        assert_eq!(model, Model::default());
    }

    #[test]
    fn only_operations_that_act_within_the_visible_screen_are_kept() {
        for kept in [
            &b"\x1b[J"[..],
            b"\x1b[0J",
            b"\x1b[1J",
            b"\x1b[2J",
            b"\x1b[2K",
            b"\x1b[5;10H",
            b"\x1b[;H",
            b"\x1b[3;20r",
            b"\x1b[r",
            b"\x1b[s",
            b"\x1b[u",
            b"\x1b[4X",
            b"\x1b[2T",
            b"\x1b[38:2::1:2:3m",
        ] {
            assert_eq!(shown(kept), kept, "{:?}", String::from_utf8_lossy(kept));
        }
        for dropped in [
            // Erases the person's scrollback.
            &b"\x1b[3J"[..],
            b"\x1b[3K",
            b"\x1b[0;3J",
            // Too many parameters: other operations share these finals.
            b"\x1b[1;2;3H",
            b"\x1b[1;2;3;4;5T",
            b"\x1b[1;2A",
            b"\x1b[5;10s",
            b"\x1b[1u",
            b"\x1b[1;2;3r",
            // Sub-parameters belong to SGR alone.
            b"\x1b[1:2H",
        ] {
            assert_eq!(
                shown(&[b"<", dropped, b">"].concat()),
                b"<>",
                "{:?}",
                String::from_utf8_lossy(dropped)
            );
        }
    }
}
