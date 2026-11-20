// SPDX-License-Identifier: Apache-2.0

//! Line commands that add, remove or merge lines: copy up, delete, insert above or below, join,
//! and Tab at a caret.

use super::{merged_line_spans, shift_selection_lines};
use crate::document::Document;
use crate::position::Position;
use crate::selection::Selection;
use crate::transaction::{Applied, Edit, EditSet};

impl Document {
    /// Copies the selected lines above themselves; the carets stay on the upper copy.
    pub fn copy_lines_up(&mut self) -> Applied {
        let spans = merged_line_spans(&self.buffer, &self.selections);
        let ending = self.buffer.line_ending().as_str();
        let mut raw = Vec::with_capacity(spans.len());
        let mut shifts = Vec::new();
        let mut above = 0i64;
        for (start, end) in &spans {
            let at = self.buffer.line_start(*start);
            let block_end = self.buffer.line_full_end(end - 1);
            let mut text = self.buffer.slice(at, block_end);
            if !self.buffer.line_has_break(end - 1) {
                text.push_str(ending);
            }
            raw.push(Edit {
                start: at,
                end: at,
                text,
            });
            for line in *start..*end {
                shifts.push((line as u32, above));
            }
            above += (*end - *start) as i64;
        }
        let edits = EditSet::new(raw);
        if edits.is_empty() {
            return self.unchanged();
        }
        let outcome = self.run(&edits);
        let after = self
            .selections
            .iter()
            .map(|selection| shift_selection_lines(*selection, &shifts))
            .collect();
        self.finish(edits, outcome, after, false)
    }

    /// Deletes every selected line; each caret lands on the line that moves up into its place.
    pub fn delete_lines(&mut self) -> Applied {
        let spans = merged_line_spans(&self.buffer, &self.selections);
        let last = self.buffer.len_lines();
        let mut raw = Vec::with_capacity(spans.len());
        // Where each span's caret goes, as (line after the edit, the span's start line).
        let mut landing = Vec::with_capacity(spans.len());
        let mut removed = 0usize;
        for (start, end) in &spans {
            let (from, to, line) = if *end < last {
                (
                    self.buffer.line_start(*start),
                    self.buffer.line_start(*end),
                    *start - removed,
                )
            } else if *start > 0 {
                // The last line has no break of its own: take the one before it instead.
                let previous_end =
                    self.buffer.line_start(start - 1) + self.buffer.line(start - 1).len();
                (previous_end, self.buffer.len_bytes(), start - 1 - removed)
            } else {
                (0, self.buffer.len_bytes(), 0)
            };
            raw.push(Edit {
                start: from,
                end: to,
                text: String::new(),
            });
            landing.push((line, *start, *end));
            removed += *end - *start;
        }
        let edits = EditSet::new(raw);
        if edits.is_empty() {
            return self.unchanged();
        }
        // Each span keeps the column of its first caret.
        let columns: Vec<u32> = landing
            .iter()
            .map(|(_, start, end)| {
                self.selections
                    .iter()
                    .find(|selection| {
                        let line = selection.head.line as usize;
                        line >= *start && line < *end
                    })
                    .map_or(0, |selection| selection.head.column)
            })
            .collect();
        let outcome = self.run(&edits);
        let after = landing
            .iter()
            .zip(columns)
            .map(|((line, _, _), column)| {
                let column = column.min(self.buffer.line_utf16_len(*line));
                Selection::caret(Position::new(*line as u32, column))
            })
            .collect();
        self.finish(edits, outcome, after, false)
    }

    /// Opens an empty line below each caret's line, indented like it, and moves the caret there.
    pub fn insert_line_below(&mut self) -> Applied {
        let ending = self.buffer.line_ending().as_str();
        let mut raw = Vec::new();
        let mut seen = None;
        for selection in &self.selections {
            let line = selection.range().end.line as usize;
            if seen == Some(line) {
                continue;
            }
            seen = Some(line);
            let at = self.buffer.line_start(line) + self.buffer.line(line).len();
            let indent = self.buffer.leading_whitespace(line);
            raw.push(Edit {
                start: at,
                end: at,
                text: format!("{ending}{indent}"),
            });
        }
        self.apply_edits(EditSet::new(raw), false)
    }

    /// Opens an empty line above each caret's line, indented like it, and moves the caret there.
    pub fn insert_line_above(&mut self) -> Applied {
        let ending = self.buffer.line_ending().as_str();
        let mut raw = Vec::new();
        let mut seen = None;
        for selection in &self.selections {
            let line = selection.range().start.line as usize;
            if seen == Some(line) {
                continue;
            }
            seen = Some(line);
            let at = self.buffer.line_start(line);
            let indent = self.buffer.leading_whitespace(line);
            raw.push(Edit {
                start: at,
                end: at,
                text: format!("{indent}{ending}"),
            });
        }
        let edits = EditSet::new(raw);
        let after = edits
            .post_ends()
            .into_iter()
            .map(|end| (end - ending.len(), end - ending.len()))
            .collect();
        self.apply_with_offsets(edits, after, false)
    }

    /// Joins each selection's lines into one, or a caret's line with the next, with one space.
    ///
    /// The next line's indentation goes; no space is added where the line already ends in one
    /// or the next line is empty. A caret lands where the lines met.
    pub fn join_lines(&mut self) -> Applied {
        let last = self.buffer.len_lines();
        let mut joins = std::collections::BTreeSet::new();
        for selection in &self.selections {
            let range = selection.range();
            let start = range.start.line as usize;
            let through = (range.end.line as usize).max(start + 1);
            joins.extend(start..through.min(last.saturating_sub(1)));
        }
        let raw: Vec<Edit> = joins
            .into_iter()
            .map(|line| {
                let content = self.buffer.line(line);
                let next = self.buffer.line(line + 1);
                let trimmed = next.trim_start_matches([' ', '\t']);
                let space = !trimmed.is_empty() && !content.ends_with([' ', '\t']);
                Edit {
                    start: self.buffer.line_start(line) + content.len(),
                    end: self.buffer.line_start(line + 1) + (next.len() - trimmed.len()),
                    text: if space { " ".to_owned() } else { String::new() },
                }
            })
            .collect();
        let edits = EditSet::new(raw);
        if edits.is_empty() {
            return self.unchanged();
        }
        let after = self
            .selections
            .iter()
            .map(|selection| {
                if selection.anchor.line == selection.head.line {
                    // A caret or a one-line selection lands where its line met the next.
                    let line = selection.head.line as usize;
                    let met = self.buffer.line_start(line) + self.buffer.line(line).len();
                    let mapped = map_offset(&edits, met);
                    (mapped, mapped)
                } else {
                    (
                        map_offset(&edits, self.buffer.offset(selection.anchor)),
                        map_offset(&edits, self.buffer.offset(selection.head)),
                    )
                }
            })
            .collect();
        self.apply_with_offsets(edits, after, false)
    }

    /// Tab: indents the lines of a selection that spans lines, or inserts one indent step (up to
    /// the next tab stop) at every caret, replacing selected text on a single line.
    pub fn tab(&mut self) -> Applied {
        let spans_lines = self
            .selections
            .iter()
            .any(|selection| selection.anchor.line != selection.head.line);
        if spans_lines {
            return self.indent_lines();
        }
        let mut raw = Vec::with_capacity(self.selections.len());
        for selection in &self.selections {
            let range = selection.range();
            let line = self.buffer.line(range.start.line as usize);
            let prefix: String = utf16_prefix(&line, range.start.column);
            let text = self.indent.step_from(self.indent.visual_width(&prefix));
            raw.push(Edit {
                start: self.buffer.offset(range.start),
                end: self.buffer.offset(range.end),
                text,
            });
        }
        self.apply_edits(EditSet::new(raw), false)
    }
}

/// Where a byte offset before `edits` ends up after them; an offset inside an edit goes to its
/// start.
fn map_offset(edits: &EditSet, offset: usize) -> usize {
    let mut delta: isize = 0;
    for edit in edits.edits() {
        if edit.start >= offset {
            break;
        }
        if edit.end > offset {
            return crate::transaction::shift(edit.start, delta);
        }
        delta += edit.text.len() as isize - (edit.end - edit.start) as isize;
    }
    crate::transaction::shift(offset, delta)
}

/// The part of a line before a UTF-16 column.
fn utf16_prefix(line: &str, column: u32) -> String {
    let mut width = 0u32;
    let mut out = String::new();
    for ch in line.chars() {
        if width >= column {
            break;
        }
        width += ch.len_utf16() as u32;
        out.push(ch);
    }
    out
}
