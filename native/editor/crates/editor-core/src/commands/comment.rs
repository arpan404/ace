// SPDX-License-Identifier: Apache-2.0

//! Toggling line comments on the selected lines.

use super::{adjust_selection_columns, merged_line_spans};
use crate::document::Document;
use crate::transaction::{Applied, Edit, EditSet};

impl Document {
    /// Comments the selected lines, or removes the comment from all of them when every non-blank
    /// line is already commented.
    ///
    /// `token` is the language's line comment (`"//"`, `"--"`, `"#"`). It goes at the smallest
    /// indentation of the non-blank selected lines, followed by one space, so the comments line
    /// up; that space is removed with the token.
    pub fn toggle_line_comment(&mut self, token: &str) -> Applied {
        if token.is_empty() {
            return self.unchanged();
        }
        let spans = merged_line_spans(&self.buffer, &self.selections);
        let mut lines = Vec::new();
        for (start, end) in &spans {
            lines.extend(*start..*end);
        }

        let mut infos = Vec::with_capacity(lines.len());
        let mut min_indent = usize::MAX;
        for line in lines {
            let content = self.buffer.line(line).to_string();
            let trimmed = content.trim_start_matches([' ', '\t']);
            let indent = content.len() - trimmed.len();
            let blank = trimmed.trim().is_empty();
            if !blank {
                min_indent = min_indent.min(indent);
            }
            infos.push((line, content, blank));
        }
        if infos.iter().all(|info| info.2) {
            return self.unchanged();
        }
        let indent = if min_indent == usize::MAX {
            0
        } else {
            min_indent
        };
        let non_blank = infos.iter().filter(|info| !info.2).count();
        let commented = infos
            .iter()
            .filter(|info| {
                !info.2
                    && info
                        .1
                        .get(indent..)
                        .is_some_and(|rest| rest.starts_with(token))
            })
            .count();
        let remove = non_blank == commented;
        let insert = if token.ends_with(char::is_whitespace) {
            token.to_owned()
        } else {
            format!("{token} ")
        };
        let insert_width = insert.chars().map(char::len_utf16).sum::<usize>() as i64;

        let mut raw = Vec::new();
        let mut columns = Vec::new();
        for (line, _, blank) in infos {
            if blank {
                continue;
            }
            let offset = self.buffer.line_start(line) + indent;
            if remove {
                let mut width = token.len();
                if self.buffer.slice(offset + width, offset + width + 1) == " " {
                    width += 1;
                }
                raw.push(Edit {
                    start: offset,
                    end: offset + width,
                    text: String::new(),
                });
                columns.push((line as u32, indent as u32, -(width as i64)));
            } else {
                raw.push(Edit {
                    start: offset,
                    end: offset,
                    text: insert.clone(),
                });
                columns.push((line as u32, indent as u32, insert_width));
            }
        }
        let edits = EditSet::new(raw);
        if edits.is_empty() {
            return self.unchanged();
        }
        let outcome = self.run(&edits);
        let after = self
            .selections
            .iter()
            .map(|selection| adjust_selection_columns(*selection, &columns))
            .collect();
        self.finish(edits, outcome, after, false)
    }

    /// Wraps each selection in a block comment, or unwraps it when it already is one.
    ///
    /// A selection is unwrapped when its own text, or the text just around it, starts with
    /// `open` and ends with `close`; one space inside each delimiter goes with it. A caret gets
    /// an empty comment with the caret in the middle. The selection keeps covering its text.
    pub fn toggle_block_comment(&mut self, open: &str, close: &str) -> Applied {
        if open.is_empty() || close.is_empty() {
            return self.unchanged();
        }
        let mut raw = Vec::new();
        let mut after = Vec::with_capacity(self.selections.len());
        let mut delta: isize = 0;
        for selection in &self.selections {
            let range = selection.range();
            let start = self.buffer.offset(range.start);
            let end = self.buffer.offset(range.end);
            let forward = selection.anchor <= selection.head;
            let shifted = |offset: usize, by: isize| crate::transaction::shift(offset, by);
            if start == end {
                raw.push(Edit {
                    start,
                    end,
                    text: format!("{open}  {close}"),
                });
                let caret = shifted(start, delta) + open.len() + 1;
                after.push((caret, caret));
                delta += (open.len() + close.len() + 2) as isize;
                continue;
            }
            let (open_at, close_at) = match self.block_delimiters(start, end, open, close) {
                Some(found) => found,
                None => {
                    let opening = format!("{open} ");
                    let closing = format!(" {close}");
                    let (inner_start, inner_end) = (
                        shifted(start, delta) + opening.len(),
                        shifted(end, delta) + opening.len(),
                    );
                    after.push(if forward {
                        (inner_start, inner_end)
                    } else {
                        (inner_end, inner_start)
                    });
                    delta += (opening.len() + closing.len()) as isize;
                    raw.push(Edit {
                        start,
                        end: start,
                        text: opening,
                    });
                    raw.push(Edit {
                        start: end,
                        end,
                        text: closing,
                    });
                    continue;
                }
            };
            let removed_open = open_at.1 - open_at.0;
            let removed_close = close_at.1 - close_at.0;
            // The text left between the delimiters stays selected.
            let inner_start = shifted(open_at.1, delta) - removed_open;
            let inner_end = shifted(close_at.0, delta) - removed_open;
            after.push(if forward {
                (inner_start, inner_end)
            } else {
                (inner_end, inner_start)
            });
            delta -= (removed_open + removed_close) as isize;
            raw.push(Edit {
                start: open_at.0,
                end: open_at.1,
                text: String::new(),
            });
            raw.push(Edit {
                start: close_at.0,
                end: close_at.1,
                text: String::new(),
            });
        }
        self.apply_with_offsets(EditSet::new(raw), after, false)
    }

    /// The byte spans of an opening and a closing delimiter (with one inner space each) inside
    /// `start..end` or just around it, if the selection is already a block comment.
    fn block_delimiters(
        &self,
        start: usize,
        end: usize,
        open: &str,
        close: &str,
    ) -> Option<((usize, usize), (usize, usize))> {
        let inside = self.buffer.slice(start, end);
        let lead = inside.len() - inside.trim_start().len();
        let trail = inside.len() - inside.trim_end().len();
        let body = inside.trim();
        if body.len() >= open.len() + close.len() && body.starts_with(open) && body.ends_with(close)
        {
            let open_start = start + lead;
            let mut open_end = open_start + open.len();
            let close_end = end - trail;
            let mut close_start = close_end - close.len();
            if close_start > open_end && self.buffer.slice(open_end, open_end + 1) == " " {
                open_end += 1;
            }
            if close_start > open_end && self.buffer.slice(close_start - 1, close_start) == " " {
                close_start -= 1;
            }
            return Some(((open_start, open_end), (close_start, close_end)));
        }
        let before_start = start.saturating_sub(open.len() + 1);
        let before = self.buffer.slice(before_start, start);
        let after = self.buffer.slice(end, end + close.len() + 1);
        let open_span = if before.ends_with(&format!("{open} ")) {
            (start - open.len() - 1, start)
        } else if before.ends_with(open) {
            (start - open.len(), start)
        } else {
            return None;
        };
        let close_span = if after.starts_with(&format!(" {close}")) {
            (end, end + close.len() + 1)
        } else if after.starts_with(close) {
            (end, end + close.len())
        } else {
            return None;
        };
        Some((open_span, close_span))
    }
}
