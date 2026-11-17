// SPDX-License-Identifier: Apache-2.0

//! Selection commands: box selection and adding the next occurrence of the selected text.

use crate::buffer::is_word_char;
use crate::document::Document;
use crate::find::{self, occurrences};
use crate::position::Position;
use crate::selection::Selection;

impl Document {
    /// Selects a rectangular block from `anchor` to `head`.
    ///
    /// One selection is created per line, each with the same two columns clamped to the line's
    /// length, so a box over short lines selects only the text those lines have.
    pub fn select_column(&mut self, anchor: Position, head: Position) {
        let last_line = u32::try_from(self.buffer.len_lines() - 1).unwrap_or(u32::MAX);
        let first = anchor.line.min(head.line).min(last_line);
        let last = anchor.line.max(head.line).min(last_line);
        let capacity = last.saturating_sub(first) as usize + 1;
        let mut selections = Vec::with_capacity(capacity);
        for line in first..=last {
            let length = self.buffer.line_utf16_len(line as usize);
            selections.push(Selection::new(
                Position::new(line, anchor.column.min(length)),
                Position::new(line, head.column.min(length)),
            ));
        }
        self.set_selections(selections);
    }

    /// Adds a selection over the next occurrence of the primary selection's text.
    ///
    /// With a plain caret this selects the word under it and returns true. With a selection it
    /// adds the next occurrence, wrapping around the document, and returns false when every
    /// occurrence is already selected.
    pub fn select_next_occurrence(&mut self) -> bool {
        let Some(primary) = self.selections.last().copied() else {
            return false;
        };
        if primary.is_empty() {
            let offset = self.buffer.offset(primary.head);
            let Some((start, end)) = self.buffer.word_at(offset) else {
                return false;
            };
            let mut selections = self.selections.clone();
            let Some(last) = selections.last_mut() else {
                return false;
            };
            *last = Selection::new(self.buffer.position(start), self.buffer.position(end));
            self.set_selections(selections);
            return true;
        }

        let range = primary.range();
        let start = self.buffer.offset(range.start);
        let end = self.buffer.offset(range.end);
        let text = self.buffer.text();
        let Some(needle) = text.get(start..end) else {
            return false;
        };
        let whole_word = needle.chars().all(is_word_char);
        let existing: Vec<(usize, usize)> = self
            .selections
            .iter()
            .map(|selection| {
                (
                    self.buffer.offset(selection.range().start),
                    self.buffer.offset(selection.range().end),
                )
            })
            .collect();
        let candidates = occurrences(&text, needle);
        let pick = |after_only: bool| {
            candidates
                .iter()
                .copied()
                .find(|(candidate_start, candidate_end)| {
                    let position_ok = if after_only {
                        *candidate_start >= end
                    } else {
                        *candidate_start < start
                    };
                    position_ok
                        && !overlaps(&existing, *candidate_start, *candidate_end)
                        && (!whole_word
                            || find::is_whole_word(&text, *candidate_start, *candidate_end))
                })
        };
        let chosen = pick(true).or_else(|| pick(false));
        let Some((chosen_start, chosen_end)) = chosen else {
            return false;
        };
        let mut selections = self.selections.clone();
        selections.push(Selection::new(
            self.buffer.position(chosen_start),
            self.buffer.position(chosen_end),
        ));
        self.set_selections(selections);
        true
    }
}

fn overlaps(existing: &[(usize, usize)], start: usize, end: usize) -> bool {
    existing
        .iter()
        .any(|(other_start, other_end)| start < *other_end && *other_start < end)
}
