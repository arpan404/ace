// SPDX-License-Identifier: Apache-2.0

//! Smart typing: brackets and quotes that close themselves, typing over a closer, wrapping a
//! selection, Enter that indents after an opening bracket, and Backspace that removes a whole
//! indent step or an empty pair.

use crate::buffer::is_word_char;
use crate::document::Document;
use crate::transaction::{Applied, Edit, EditSet};

/// How far back from a caret Enter and Backspace look, in bytes.
const LOOK_BACK: usize = 256;

/// The closer each auto-closing character pairs with.
fn closer(ch: char) -> Option<char> {
    match ch {
        '(' => Some(')'),
        '[' => Some(']'),
        '{' => Some('}'),
        '"' => Some('"'),
        '\'' => Some('\''),
        '`' => Some('`'),
        _ => None,
    }
}

fn is_quote(ch: char) -> bool {
    matches!(ch, '"' | '\'' | '`')
}

fn is_closer(ch: char) -> bool {
    matches!(ch, ')' | ']' | '}' | '"' | '\'' | '`')
}

/// Whether a pair may open before `next`: at a line's end, before space or punctuation that
/// ends an expression, as VS Code's default `autoCloseBefore`.
fn closes_before(next: Option<char>) -> bool {
    next.is_none_or(|ch| ch.is_whitespace() || ";:.,=}])>".contains(ch))
}

/// What one keystroke does at one selection.
enum Typed {
    /// Insert `text` over the selection, then put the caret `caret` bytes after its start.
    Insert { text: String, caret: usize },
    /// Wrap the selection: the selection stays on the wrapped text.
    Wrap { open: char, close: char },
    /// The next character is the one typed: step over it.
    Over,
}

impl Document {
    /// Types one keystroke at every selection, with brackets and quotes that close themselves.
    ///
    /// An opening bracket or quote at a caret inserts its pair when the next character allows it
    /// (end of line, space, or a closer); over a selection it wraps the selection. A closer typed
    /// just before the same character steps over it. Anything else, and every multi-character
    /// text such as a paste, is plain [`Document::insert_text`].
    pub fn type_text(&mut self, text: &str) -> Applied {
        let mut chars = text.chars();
        let (Some(ch), None) = (chars.next(), chars.next()) else {
            return self.insert_text(text);
        };
        if closer(ch).is_none() && !is_closer(ch) {
            return self.insert_text(text);
        }
        let plans: Vec<Typed> = self
            .selections
            .iter()
            .map(|selection| self.plan(ch, *selection))
            .collect();
        if plans
            .iter()
            .all(|plan| matches!(plan, Typed::Insert { text, caret } if *caret == text.len()))
        {
            return self.insert_text(text);
        }
        let mut raw = Vec::new();
        let mut after = Vec::with_capacity(plans.len());
        let mut delta: isize = 0;
        for (selection, plan) in self.selections.iter().zip(plans) {
            let range = selection.range();
            let start = self.buffer.offset(range.start);
            let end = self.buffer.offset(range.end);
            let post_start = crate::transaction::shift(start, delta);
            match plan {
                Typed::Over => {
                    let to = post_start + ch.len_utf8();
                    after.push((to, to));
                }
                Typed::Insert { text, caret } => {
                    after.push((post_start + caret, post_start + caret));
                    delta += text.len() as isize - (end - start) as isize;
                    raw.push(Edit { start, end, text });
                }
                Typed::Wrap { open, close } => {
                    let inner = (
                        post_start + open.len_utf8(),
                        crate::transaction::shift(end, delta) + open.len_utf8(),
                    );
                    let forward = selection.anchor <= selection.head;
                    after.push(if forward { inner } else { (inner.1, inner.0) });
                    delta += (open.len_utf8() + close.len_utf8()) as isize;
                    raw.push(Edit {
                        start,
                        end: start,
                        text: open.to_string(),
                    });
                    raw.push(Edit {
                        start: end,
                        end,
                        text: close.to_string(),
                    });
                }
            }
        }
        if raw.is_empty() {
            // Only steps over closers: the carets move and nothing is edited.
            let selections = after
                .into_iter()
                .map(|(anchor, head)| {
                    crate::selection::Selection::new(
                        self.buffer.position(anchor),
                        self.buffer.position(head),
                    )
                })
                .collect();
            self.set_selections(selections);
            return self.unchanged();
        }
        self.apply_with_offsets(EditSet::new(raw), after, false)
    }

    fn plan(&self, ch: char, selection: crate::selection::Selection) -> Typed {
        let range = selection.range();
        let start = self.buffer.offset(range.start);
        let end = self.buffer.offset(range.end);
        let plain = || Typed::Insert {
            text: ch.to_string(),
            caret: ch.len_utf8(),
        };
        if start != end {
            return match closer(ch) {
                Some(close) => Typed::Wrap { open: ch, close },
                None => plain(),
            };
        }
        let next = self.char_after(start);
        if is_closer(ch) && next == Some(ch) {
            return Typed::Over;
        }
        let Some(close) = closer(ch) else {
            return plain();
        };
        if !closes_before(next) {
            return plain();
        }
        if is_quote(ch) {
            // A quote after a word character is an apostrophe or a closing quote, not a pair.
            let previous = self.char_before(start);
            if previous.is_some_and(|before| is_word_char(before) || before == ch) {
                return plain();
            }
        }
        Typed::Insert {
            text: format!("{ch}{close}"),
            caret: ch.len_utf8(),
        }
    }

    /// Enter: a line break carrying the line's indentation, one step more after an opening
    /// bracket, and the closer on a line of its own when the caret sits between a pair.
    pub fn smart_newline(&mut self) -> Applied {
        let ending = self.buffer.line_ending().as_str();
        let unit = self.indent.unit();
        let mut raw = Vec::with_capacity(self.selections.len());
        let mut after = Vec::with_capacity(self.selections.len());
        let mut delta: isize = 0;
        for selection in &self.selections {
            let range = selection.range();
            let start = self.buffer.offset(range.start);
            let end = self.buffer.offset(range.end);
            let line = range.start.line as usize;
            let line_start = self.buffer.line_start(line);
            let whitespace = self.buffer.leading_whitespace(line);
            // Leading whitespace is single-byte, so a caret inside it cuts it at its own byte.
            let indent: String = if start - line_start < whitespace.len() {
                whitespace[..start - line_start].to_owned()
            } else {
                whitespace.clone()
            };
            // Only the text just before the caret is read: a long line costs no more than a short one.
            let near = self
                .buffer
                .slice(start.saturating_sub(LOOK_BACK).max(line_start), start);
            let opener = near.trim_end().chars().next_back();
            let opens = opener.is_some_and(|ch| matches!(ch, '(' | '[' | '{'));
            let next = self.char_after(end);
            let splits = opens && next.is_some_and(|ch| Some(ch) == opener.and_then(closer));
            let (text, caret) = if splits {
                let middle = format!("{ending}{indent}{unit}");
                let caret = middle.len();
                (format!("{middle}{ending}{indent}"), caret)
            } else if opens {
                let text = format!("{ending}{indent}{unit}");
                let caret = text.len();
                (text, caret)
            } else {
                let text = format!("{ending}{indent}");
                let caret = text.len();
                (text, caret)
            };
            let post_start = crate::transaction::shift(start, delta);
            after.push((post_start + caret, post_start + caret));
            delta += text.len() as isize - (end - start) as isize;
            raw.push(Edit { start, end, text });
        }
        self.apply_with_offsets(EditSet::new(raw), after, false)
    }

    /// Backspace: a selection or one grapheme as [`Document::backspace`], except that a caret in
    /// a line's leading spaces removes back to the previous indent stop, and a caret between an
    /// empty pair such as `(|)` removes both halves.
    pub fn smart_backspace(&mut self) -> Applied {
        let size = self.indent.size.max(1) as usize;
        let mut special = false;
        let mut raw = Vec::with_capacity(self.selections.len());
        for selection in &self.selections {
            let range = selection.range();
            let start = self.buffer.offset(range.start);
            let end = self.buffer.offset(range.end);
            if start != end || start == 0 {
                raw.push(None);
                continue;
            }
            let line = range.start.line as usize;
            let line_start = self.buffer.line_start(line);
            // Leading spaces only: a caret further in than that is never in the indentation.
            let in_indent = start - line_start <= LOOK_BACK;
            let before = if in_indent {
                self.buffer.slice(line_start, start)
            } else {
                String::new()
            };
            if !before.is_empty() && before.bytes().all(|b| b == b' ') && !self.indent.tabs {
                let remove = match before.len() % size {
                    0 => size,
                    rest => rest,
                };
                special = true;
                raw.push(Some(Edit {
                    start: start - remove,
                    end: start,
                    text: String::new(),
                }));
                continue;
            }
            let previous = self.char_before(start);
            let next = self.char_after(start);
            if let (Some(open), Some(close)) = (previous, next)
                && closer(open) == Some(close)
            {
                special = true;
                raw.push(Some(Edit {
                    start: start - open.len_utf8(),
                    end: start + close.len_utf8(),
                    text: String::new(),
                }));
                continue;
            }
            raw.push(None);
        }
        if !special {
            return self.backspace();
        }
        let edits = raw
            .into_iter()
            .zip(self.selections.clone())
            .filter_map(|(edit, selection)| {
                edit.or_else(|| {
                    let range = selection.range();
                    let start = self.buffer.offset(range.start);
                    let end = self.buffer.offset(range.end);
                    if end > start {
                        Some(Edit {
                            start,
                            end,
                            text: String::new(),
                        })
                    } else if start > 0 {
                        Some(Edit {
                            start: self.buffer.grapheme_before(start),
                            end: start,
                            text: String::new(),
                        })
                    } else {
                        None
                    }
                })
            })
            .collect();
        self.apply_edits(super::deletion_set(edits), false)
    }

    fn char_after(&self, offset: usize) -> Option<char> {
        let next = self.buffer.slice(offset, offset + 4);
        next.chars().next().filter(|ch| *ch != '\r' && *ch != '\n')
    }

    fn char_before(&self, offset: usize) -> Option<char> {
        let previous = self.buffer.slice(offset.saturating_sub(4), offset);
        previous
            .chars()
            .next_back()
            .filter(|ch| *ch != '\r' && *ch != '\n')
    }
}
