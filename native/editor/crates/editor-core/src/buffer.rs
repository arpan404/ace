// SPDX-License-Identifier: Apache-2.0

//! The rope buffer and the byte offsets behind UTF-16 positions.

use std::borrow::Cow;

use ropey::Rope;
use unicode_segmentation::UnicodeSegmentation;

use crate::position::Position;

/// The line ending a document was loaded with.
///
/// New lines the editor inserts use this ending, so editing a CRLF file never mixes endings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum LineEnding {
    /// `\n`
    #[default]
    Lf,
    /// `\r\n`
    Crlf,
}

impl LineEnding {
    /// The characters a new line is written with.
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::Crlf => "\r\n",
        }
    }
}

/// A rope plus the conversions between byte offsets, lines and UTF-16 columns.
pub(crate) struct Buffer {
    rope: Rope,
    line_ending: LineEnding,
}

impl Buffer {
    pub(crate) fn new(text: &str) -> Buffer {
        Buffer {
            rope: Rope::from_str(text),
            line_ending: detect_line_ending(text),
        }
    }

    pub(crate) fn line_ending(&self) -> LineEnding {
        self.line_ending
    }

    pub(crate) fn set_line_ending(&mut self, ending: LineEnding) {
        self.line_ending = ending;
    }

    /// Reads the ending from the first line break again, after an undo put other text back.
    /// A document with no break keeps the ending it had.
    pub(crate) fn redetect_line_ending(&mut self) {
        if self.len_lines() > 1 {
            self.line_ending = if self.ending_len(0) == 2 {
                LineEnding::Crlf
            } else {
                LineEnding::Lf
            };
        }
    }

    pub(crate) fn text(&self) -> String {
        self.rope.to_string()
    }

    pub(crate) fn len_lines(&self) -> usize {
        self.rope.len_lines()
    }

    pub(crate) fn len_bytes(&self) -> usize {
        self.rope.len_bytes()
    }

    /// One line without its ending. Out-of-range lines are empty.
    pub(crate) fn line(&self, index: usize) -> Cow<'_, str> {
        if index >= self.len_lines() {
            return Cow::Borrowed("");
        }
        let mut text = self.rope.line(index).to_string();
        let ending = self.ending_len(index);
        text.truncate(text.len() - ending);
        Cow::Owned(text)
    }

    /// The UTF-16 width of one line's text, excluding its ending.
    pub(crate) fn line_utf16_len(&self, index: usize) -> u32 {
        if index >= self.len_lines() {
            return 0;
        }
        let start = self.rope.line_to_char(index);
        let end = start + self.content_chars(index);
        let width = self.rope.char_to_utf16_cu(end) - self.rope.char_to_utf16_cu(start);
        u32::try_from(width).unwrap_or(u32::MAX)
    }

    /// The byte offset of a position, clamped to the line's content and the document.
    ///
    /// Uses ropey's UTF-16 index, so a column in a five-megabyte line costs the same as one in a
    /// short line. A column inside a surrogate pair rounds down to the character it belongs to.
    pub(crate) fn offset(&self, position: Position) -> usize {
        let line = (position.line as usize).min(self.len_lines() - 1);
        let start = self.rope.line_to_char(line);
        let start_utf16 = self.rope.char_to_utf16_cu(start);
        let end = start + self.content_chars(line);
        let end_utf16 = self.rope.char_to_utf16_cu(end);
        let target = start_utf16
            .saturating_add(position.column as usize)
            .min(end_utf16);
        let char_idx = self.rope.utf16_cu_to_char(target);
        self.rope.char_to_byte(char_idx)
    }

    /// The position of a byte offset, clamped to the line's content and character boundaries.
    pub(crate) fn position(&self, offset: usize) -> Position {
        let char_idx = self.rope.byte_to_char(offset.min(self.len_bytes()));
        let line = self.rope.char_to_line(char_idx);
        let start = self.rope.line_to_char(line);
        let end = start + self.content_chars(line);
        let char_idx = char_idx.min(end);
        let column = self.rope.char_to_utf16_cu(char_idx) - self.rope.char_to_utf16_cu(start);
        Position::new(
            u32::try_from(line).unwrap_or(u32::MAX),
            u32::try_from(column).unwrap_or(u32::MAX),
        )
    }

    /// The line containing a byte offset.
    pub(crate) fn line_at(&self, offset: usize) -> u32 {
        let line = self.rope.byte_to_line(offset.min(self.len_bytes()));
        u32::try_from(line).unwrap_or(u32::MAX)
    }

    pub(crate) fn line_start(&self, line: usize) -> usize {
        let line = line.min(self.len_lines() - 1);
        self.rope.line_to_byte(line)
    }

    /// The byte after a line's content and its ending, or the end of the document.
    pub(crate) fn line_full_end(&self, line: usize) -> usize {
        let line = line.min(self.len_lines() - 1);
        if line + 1 < self.len_lines() {
            self.rope.line_to_byte(line + 1)
        } else {
            self.len_bytes()
        }
    }

    /// The line's own ending, or `""` for a last line without one.
    pub(crate) fn line_break(&self, line: usize) -> &'static str {
        match self.ending_len(line) {
            2 => "\r\n",
            1 => "\n",
            _ => "",
        }
    }

    pub(crate) fn line_has_break(&self, line: usize) -> bool {
        self.ending_len(line) > 0
    }

    fn ending_len(&self, line: usize) -> usize {
        if line >= self.len_lines() {
            return 0;
        }
        let slice = self.rope.line(line);
        let chars = slice.len_chars();
        if chars >= 2 && slice.char(chars - 2) == '\r' && slice.char(chars - 1) == '\n' {
            2
        } else if chars >= 1 && slice.char(chars - 1) == '\n' {
            1
        } else {
            0
        }
    }

    /// The number of characters in a line before its ending.
    fn content_chars(&self, line: usize) -> usize {
        self.rope.line(line).len_chars() - self.ending_len(line)
    }

    /// The text between two byte offsets.
    pub(crate) fn slice(&self, start: usize, end: usize) -> String {
        let start = start.min(self.len_bytes());
        let end = end.min(self.len_bytes());
        if end <= start {
            return String::new();
        }
        let start = self.rope.byte_to_char(start);
        let end = self.rope.byte_to_char(end);
        if end <= start {
            return String::new();
        }
        self.rope.slice(start..end).to_string()
    }

    pub(crate) fn insert(&mut self, offset: usize, text: &str) {
        let char_idx = self.rope.byte_to_char(offset.min(self.len_bytes()));
        self.rope.insert(char_idx, text);
    }

    pub(crate) fn remove(&mut self, start: usize, end: usize) {
        let start = start.min(self.len_bytes());
        let end = end.min(self.len_bytes());
        if end <= start {
            return;
        }
        let start = self.rope.byte_to_char(start);
        let end = self.rope.byte_to_char(end);
        if end > start {
            self.rope.remove(start..end);
        }
    }

    /// The spaces and tabs a line starts with.
    pub(crate) fn leading_whitespace(&self, line: usize) -> String {
        let line = line.min(self.len_lines() - 1);
        self.rope
            .line(line)
            .chars()
            .take_while(|ch| *ch == ' ' || *ch == '\t')
            .collect()
    }

    /// The start of the grapheme cluster before a byte offset.
    ///
    /// Only the 64 characters before the offset are segmented, so backspacing in a five-megabyte
    /// line does not walk the line. A line break counts as one cluster, so backspacing at a line
    /// start removes the whole `\r\n` pair rather than leaving a stray `\r`.
    pub(crate) fn grapheme_before(&self, offset: usize) -> usize {
        const WINDOW: usize = 64;
        let char_idx = self.rope.byte_to_char(offset.min(self.len_bytes()));
        if char_idx == 0 {
            return 0;
        }
        let start_char = char_idx.saturating_sub(WINDOW);
        let start = self.rope.char_to_byte(start_char);
        let end = self.rope.char_to_byte(char_idx);
        let text = self.rope.byte_slice(start..end).to_string();
        let mut boundary = 0;
        for (index, _) in text.grapheme_indices(true) {
            boundary = index;
        }
        start + boundary
    }

    /// The start of the word before a byte offset, skipping whitespace first.
    pub(crate) fn word_before(&self, offset: usize) -> usize {
        let mut index = self.rope.byte_to_char(offset.min(self.len_bytes()));
        while index > 0 && self.rope.char(index - 1).is_whitespace() {
            index -= 1;
        }
        if index == 0 {
            return 0;
        }
        if is_word_char(self.rope.char(index - 1)) {
            while index > 0 && is_word_char(self.rope.char(index - 1)) {
                index -= 1;
            }
        } else {
            index -= 1;
        }
        self.rope.char_to_byte(index)
    }

    /// The word around a byte offset, if one is there.
    pub(crate) fn word_at(&self, offset: usize) -> Option<(usize, usize)> {
        let len = self.rope.len_chars();
        let index = self.rope.byte_to_char(offset.min(self.len_bytes()));
        let mut start = index;
        let mut end;
        if index < len && is_word_char(self.rope.char(index)) {
            end = index + 1;
            while end < len && is_word_char(self.rope.char(end)) {
                end += 1;
            }
            while start > 0 && is_word_char(self.rope.char(start - 1)) {
                start -= 1;
            }
        } else if index > 0 && is_word_char(self.rope.char(index - 1)) {
            start = index - 1;
            end = index;
            while start > 0 && is_word_char(self.rope.char(start - 1)) {
                start -= 1;
            }
            while end < len && is_word_char(self.rope.char(end)) {
                end += 1;
            }
        } else {
            return None;
        }
        Some((self.rope.char_to_byte(start), self.rope.char_to_byte(end)))
    }
}

impl Buffer {
    /// The bracket that pairs with the one at char index `at`, scanning at most `limit`
    /// characters, as a char index. Nested pairs of the same kind are skipped; other kinds and
    /// strings are not looked at.
    fn pair_of(&self, at: usize, limit: usize) -> Option<usize> {
        let ch = self.rope.char(at);
        let (open, close, forward) = match ch {
            '(' => ('(', ')', true),
            '[' => ('[', ']', true),
            '{' => ('{', '}', true),
            ')' => ('(', ')', false),
            ']' => ('[', ']', false),
            '}' => ('{', '}', false),
            _ => return None,
        };
        let mut depth = 0usize;
        if forward {
            let end = (at + 1 + limit).min(self.rope.len_chars());
            for (index, next) in self.rope.slice(at + 1..end).chars().enumerate() {
                if next == open {
                    depth += 1;
                } else if next == close {
                    if depth == 0 {
                        return Some(at + 1 + index);
                    }
                    depth -= 1;
                }
            }
        } else {
            let start = at.saturating_sub(limit);
            let slice = self.rope.slice(start..at);
            let mut index = at;
            for previous in slice.chars_at(slice.len_chars()).reversed() {
                index -= 1;
                if previous == close {
                    depth += 1;
                } else if previous == open {
                    if depth == 0 {
                        return Some(index);
                    }
                    depth -= 1;
                }
            }
        }
        None
    }

    /// The pair of brackets at a byte offset: the bracket just before it, else the one at it,
    /// and its match, as byte offsets of the two brackets in document order.
    pub(crate) fn matching_bracket(&self, offset: usize, limit: usize) -> Option<(usize, usize)> {
        let at = self.rope.byte_to_char(offset.min(self.len_bytes()));
        let candidates = [
            at.checked_sub(1),
            (at < self.rope.len_chars()).then_some(at),
        ];
        for candidate in candidates.into_iter().flatten() {
            if let Some(other) = self.pair_of(candidate, limit) {
                let (first, second) = (candidate.min(other), candidate.max(other));
                return Some((
                    self.rope.char_to_byte(first),
                    self.rope.char_to_byte(second),
                ));
            }
        }
        None
    }
}

/// Whether a character counts as part of a word for deletion and whole-word search.
pub(crate) fn is_word_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_'
}

fn detect_line_ending(text: &str) -> LineEnding {
    match text.find('\n') {
        Some(index) if index > 0 && text.as_bytes()[index - 1] == b'\r' => LineEnding::Crlf,
        _ => LineEnding::Lf,
    }
}
