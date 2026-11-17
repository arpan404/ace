// SPDX-License-Identifier: Apache-2.0

//! Selection commands: box selection and adding the next occurrence of the selected text.

use unicode_segmentation::UnicodeSegmentation;

use crate::document::Document;
use crate::find::{self, occurrences};
use crate::position::Position;
use crate::selection::Selection;

impl Document {
    /// Selects a rectangular block from `anchor` to `head`.
    ///
    /// The columns are visual columns with tabs expanded to `tab_size` stops, the way the client
    /// lays the text out. One selection is created per line, each clamped to that line's end, so
    /// a box over short lines selects only the text those lines have.
    pub fn select_column(&mut self, anchor: Position, head: Position, tab_size: u32) {
        let last_line = u32::try_from(self.buffer.len_lines() - 1).unwrap_or(u32::MAX);
        let first = anchor.line.min(head.line).min(last_line);
        let last = anchor.line.max(head.line).min(last_line);
        let capacity = last.saturating_sub(first) as usize + 1;
        let mut selections = Vec::with_capacity(capacity);
        for line in first..=last {
            let content = self.buffer.line(line as usize);
            let anchor_column = visual_to_utf16(&content, anchor.column, tab_size);
            let head_column = visual_to_utf16(&content, head.column, tab_size);
            selections.push(Selection::new(
                Position::new(line, anchor_column),
                Position::new(line, head_column),
            ));
        }
        self.set_selections(selections);
    }

    /// Adds a selection over the next occurrence of the primary selection's text.
    ///
    /// With a plain caret this selects the word under it and returns true; later calls in that
    /// chain match whole words only, as VS Code does. With a selection it adds the next
    /// occurrence, wrapping around the document, and matches any part of longer words. Returns
    /// false when every occurrence is already selected.
    pub fn select_next_occurrence(&mut self) -> bool {
        let primary_index = self.primary_selection();
        let Some(primary) = self.selections.get(primary_index).copied() else {
            return false;
        };
        if primary.is_empty() {
            let offset = self.buffer.offset(primary.head);
            let Some((start, end)) = self.buffer.word_at(offset) else {
                return false;
            };
            let mut selections = Vec::with_capacity(self.selections.len());
            for (index, selection) in self.selections.iter().enumerate() {
                if index != primary_index {
                    selections.push(*selection);
                }
            }
            selections.push(Selection::new(
                self.buffer.position(start),
                self.buffer.position(end),
            ));
            self.set_selections(selections);
            self.word_chain = true;
            return true;
        }

        let range = primary.range();
        let start = self.buffer.offset(range.start);
        let end = self.buffer.offset(range.end);
        let text = self.buffer.text();
        let Some(needle) = text.get(start..end) else {
            return false;
        };
        let whole_word = self.word_chain;
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
        self.word_chain = whole_word;
        true
    }
}

/// Converts a visual column to a UTF-16 column, clamping to the line's text.
fn visual_to_utf16(content: &str, visual: u32, tab_size: u32) -> u32 {
    let tab = u64::from(tab_size.max(1));
    let target = u64::from(visual);
    let mut column = 0u64;
    let mut utf16 = 0u32;
    for grapheme in content.graphemes(true) {
        let next = if grapheme == "\t" {
            (column / tab + 1) * tab
        } else {
            column + 1
        };
        if next > target {
            break;
        }
        column = next;
        utf16 += grapheme.encode_utf16().count() as u32;
    }
    utf16
}

fn overlaps(existing: &[(usize, usize)], start: usize, end: usize) -> bool {
    existing
        .iter()
        .any(|(other_start, other_end)| start < *other_end && *other_start < end)
}
