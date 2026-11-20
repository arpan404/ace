// SPDX-License-Identifier: Apache-2.0

//! Typing, newlines, backspace and word deletion.

use std::borrow::Cow;

use super::deletion_set;
use crate::document::Document;
use crate::transaction::{Applied, Edit, EditSet};

impl Document {
    /// Inserts `text` at every selection, replacing selected text.
    ///
    /// Any `\r\n`, `\r` or `\n` in `text` becomes the document's own line ending, so pasted text
    /// never mixes endings. Runs of plain typing without a line break fold into one undo step
    /// until [`Document::commit`] or a selection change ends the run.
    pub fn insert_text(&mut self, text: &str) -> Applied {
        if text.is_empty() {
            return self.unchanged();
        }
        let ending = self.buffer.line_ending().as_str();
        let text = normalise_line_endings(text, ending);
        let typing = !text.contains('\n') && !text.contains('\r');
        let mut raw = Vec::with_capacity(self.selections.len());
        for selection in &self.selections {
            let range = selection.range();
            raw.push(Edit {
                start: self.buffer.offset(range.start),
                end: self.buffer.offset(range.end),
                text: text.to_string(),
            });
        }
        self.apply_edits(EditSet::new(raw), typing)
    }

    /// Inserts a line break carrying the current line's indentation at every selection.
    ///
    /// The break is the document's own line ending, so a CRLF file stays CRLF.
    pub fn insert_newline(&mut self) -> Applied {
        let ending = self.buffer.line_ending().as_str();
        let mut raw = Vec::with_capacity(self.selections.len());
        for selection in &self.selections {
            let range = selection.range();
            let whitespace = self.buffer.leading_whitespace(range.start.line as usize);
            let indent: String = whitespace
                .chars()
                .take(range.start.column as usize)
                .collect();
            raw.push(Edit {
                start: self.buffer.offset(range.start),
                end: self.buffer.offset(range.end),
                text: format!("{ending}{indent}"),
            });
        }
        self.apply_edits(EditSet::new(raw), false)
    }

    /// Deletes the selected text, or one grapheme cluster before each caret.
    ///
    /// A line break, including a `\r\n` pair, counts as one cluster.
    pub fn backspace(&mut self) -> Applied {
        let mut raw = Vec::with_capacity(self.selections.len());
        for selection in &self.selections {
            let range = selection.range();
            let start = self.buffer.offset(range.start);
            let end = self.buffer.offset(range.end);
            if end > start {
                raw.push(Edit {
                    start,
                    end,
                    text: String::new(),
                });
            } else if start > 0 {
                raw.push(Edit {
                    start: self.buffer.grapheme_before(start),
                    end: start,
                    text: String::new(),
                });
            }
        }
        self.apply_edits(deletion_set(raw), false)
    }

    /// Deletes the selected text, or the word before each caret plus the whitespace before it.
    pub fn delete_word_backward(&mut self) -> Applied {
        let mut raw = Vec::with_capacity(self.selections.len());
        for selection in &self.selections {
            let range = selection.range();
            let start = self.buffer.offset(range.start);
            let end = self.buffer.offset(range.end);
            if end > start {
                raw.push(Edit {
                    start,
                    end,
                    text: String::new(),
                });
            } else if start > 0 {
                raw.push(Edit {
                    start: self.buffer.word_before(start),
                    end: start,
                    text: String::new(),
                });
            }
        }
        self.apply_edits(deletion_set(raw), false)
    }
}

fn normalise_line_endings<'a>(text: &'a str, ending: &str) -> Cow<'a, str> {
    if !text.contains(['\r', '\n']) {
        return Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push_str(ending);
            }
            '\n' => out.push_str(ending),
            _ => out.push(ch),
        }
    }
    Cow::Owned(out)
}
