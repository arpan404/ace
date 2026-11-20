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
            let length = self.buffer.line_utf16_len(line as usize);
            let anchor_column = visual_to_utf16(&content, anchor.column, tab_size).min(length);
            let head_column = visual_to_utf16(&content, head.column, tab_size).min(length);
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
        let text = self.search_text().clone();
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

impl Document {
    /// Selects every occurrence of the primary selection's text, or of the word under a caret.
    ///
    /// A word taken from under a caret matches whole words only, as VS Code does. The occurrence
    /// the primary selection was on stays primary. Returns false when there is nothing to match.
    pub fn select_all_occurrences(&mut self) -> bool {
        let Some(primary) = self.selections.get(self.primary_selection()).copied() else {
            return false;
        };
        let (start, end, whole_word) = if primary.is_empty() {
            let offset = self.buffer.offset(primary.head);
            let Some((start, end)) = self.buffer.word_at(offset) else {
                return false;
            };
            (start, end, true)
        } else {
            let range = primary.range();
            (
                self.buffer.offset(range.start),
                self.buffer.offset(range.end),
                self.word_chain,
            )
        };
        let spans: Vec<(usize, usize)> = {
            let text = self.search_text();
            let Some(needle) = text.get(start..end) else {
                return false;
            };
            occurrences(&text, needle)
                .into_iter()
                .filter(|(from, to)| !whole_word || find::is_whole_word(&text, *from, *to))
                .collect()
        };
        if spans.is_empty() {
            return false;
        }
        let mut selections: Vec<Selection> = spans
            .iter()
            .filter(|span| **span != (start, end))
            .map(|(from, to)| {
                Selection::new(self.buffer.position(*from), self.buffer.position(*to))
            })
            .collect();
        selections.push(Selection::new(
            self.buffer.position(start),
            self.buffer.position(end),
        ));
        self.set_selections(selections);
        self.word_chain = whole_word;
        true
    }

    /// Cmd+K Cmd+D: moves the newest selection on to the next occurrence of its text, leaving the
    /// one it was on unselected. With a caret it behaves as [`Document::select_next_occurrence`].
    pub fn skip_occurrence(&mut self) -> bool {
        let Some(old) = self.selections.get(self.primary_selection()).copied() else {
            return false;
        };
        if old.is_empty() {
            return self.select_next_occurrence();
        }
        let chain = self.word_chain;
        if !self.select_next_occurrence() {
            return false;
        }
        let Some(new) = self.selections.get(self.primary_selection()).copied() else {
            return false;
        };
        if new == old {
            return false;
        }
        let mut selections: Vec<Selection> = self
            .selections
            .iter()
            .copied()
            .filter(|selection| *selection != old && *selection != new)
            .collect();
        selections.push(new);
        self.set_selections(selections);
        self.word_chain = chain;
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
