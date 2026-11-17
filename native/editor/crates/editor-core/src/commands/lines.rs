// SPDX-License-Identifier: Apache-2.0

//! Line commands: indent, outdent, move lines and duplicate them.

use super::{
    adjust_selection_for_indent, adjust_selection_for_outdent, merged_line_spans,
    shift_selection_lines,
};
use crate::document::Document;
use crate::transaction::{Applied, Edit, EditSet};

/// One indent step, in spaces.
const INDENT: &str = "  ";

impl Document {
    /// Adds one indent step to the start of every selected line.
    pub fn indent_lines(&mut self) -> Applied {
        let spans = merged_line_spans(&self.buffer, &self.selections);
        let mut raw = Vec::new();
        let mut columns = Vec::new();
        for (start, end) in &spans {
            for line in *start..*end {
                let offset = self.buffer.line_start(line);
                raw.push(Edit {
                    start: offset,
                    end: offset,
                    text: INDENT.to_owned(),
                });
                columns.push((line as u32, 0, INDENT.len() as i64));
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
            .map(|selection| adjust_selection_for_indent(*selection, &columns))
            .collect();
        self.finish(edits, outcome, after, false)
    }

    /// Removes one indent step (a tab or up to `INDENT` spaces) from every selected line.
    pub fn outdent_lines(&mut self) -> Applied {
        let spans = merged_line_spans(&self.buffer, &self.selections);
        let mut raw = Vec::new();
        let mut columns = Vec::new();
        for (start, end) in &spans {
            for line in *start..*end {
                let content = self.buffer.line(line);
                let removed = if content.starts_with('\t') {
                    1
                } else {
                    content
                        .bytes()
                        .take(INDENT.len())
                        .take_while(|b| *b == b' ')
                        .count()
                };
                if removed == 0 {
                    continue;
                }
                let offset = self.buffer.line_start(line);
                raw.push(Edit {
                    start: offset,
                    end: offset + removed,
                    text: String::new(),
                });
                columns.push((line as u32, 0, -(removed as i64)));
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
            .map(|selection| adjust_selection_for_outdent(*selection, &columns))
            .collect();
        self.finish(edits, outcome, after, false)
    }

    /// Swaps the selected lines with the line above them.
    pub fn move_lines_up(&mut self) -> Applied {
        let spans = merged_line_spans(&self.buffer, &self.selections);
        let ending = self.buffer.line_ending().as_str();
        let mut raw = Vec::new();
        let mut shifts = Vec::new();
        for (start, end) in &spans {
            if *start == 0 {
                continue;
            }
            let previous = self.buffer.line(start - 1).to_string();
            let block = self.buffer.slice(
                self.buffer.line_start(*start),
                self.buffer.line_full_end(end - 1),
            );
            let text = if self.buffer.line_has_break(end - 1) {
                format!("{block}{previous}{ending}")
            } else {
                format!("{block}{ending}{previous}")
            };
            raw.push(Edit {
                start: self.buffer.line_start(start - 1),
                end: self.buffer.line_full_end(end - 1),
                text,
            });
            for line in *start..*end {
                shifts.push((line as u32, -1));
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
            .map(|selection| shift_selection_lines(*selection, &shifts))
            .collect();
        self.finish(edits, outcome, after, false)
    }

    /// Swaps the selected lines with the line below them.
    pub fn move_lines_down(&mut self) -> Applied {
        let spans = merged_line_spans(&self.buffer, &self.selections);
        let ending = self.buffer.line_ending().as_str();
        let mut raw = Vec::new();
        let mut shifts = Vec::new();
        for (start, end) in &spans {
            if *end >= self.buffer.len_lines() {
                continue;
            }
            let next = self.buffer.line(*end).to_string();
            let block = self.buffer.slice(
                self.buffer.line_start(*start),
                self.buffer.line_full_end(end - 1),
            );
            let text = if self.buffer.line_has_break(*end) {
                format!("{next}{ending}{block}")
            } else {
                let trimmed = block
                    .strip_suffix(self.buffer.line_break(end - 1))
                    .unwrap_or(&block);
                format!("{next}{ending}{trimmed}")
            };
            raw.push(Edit {
                start: self.buffer.line_start(*start),
                end: self.buffer.line_full_end(*end),
                text,
            });
            for line in *start..*end {
                shifts.push((line as u32, 1));
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
            .map(|selection| shift_selection_lines(*selection, &shifts))
            .collect();
        self.finish(edits, outcome, after, false)
    }

    /// Copies the selected lines below themselves and moves the carets onto the copies.
    pub fn duplicate_lines(&mut self) -> Applied {
        let spans = merged_line_spans(&self.buffer, &self.selections);
        let ending = self.buffer.line_ending().as_str();
        let mut raw = Vec::new();
        let mut shifts = Vec::new();
        let mut cumulative = 0i64;
        for (start, end) in &spans {
            let height = (*end - *start) as i64;
            cumulative += height;
            let insert_at = self.buffer.line_full_end(end - 1);
            let block = self.buffer.slice(self.buffer.line_start(*start), insert_at);
            let text = if self.buffer.line_has_break(end - 1) {
                block
            } else {
                format!("{ending}{block}")
            };
            raw.push(Edit {
                start: insert_at,
                end: insert_at,
                text,
            });
            for line in *start..*end {
                shifts.push((line as u32, cumulative));
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
            .map(|selection| shift_selection_lines(*selection, &shifts))
            .collect();
        self.finish(edits, outcome, after, false)
    }
}
