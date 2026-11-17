// SPDX-License-Identifier: Apache-2.0

//! The document: text, selections, version and the edit pipeline.

use std::borrow::Cow;

use crate::buffer::{Buffer, LineEnding};
use crate::find::{self, FindQuery};
use crate::history::{Entry, History};
use crate::position::{Position, Range};
use crate::selection::Selection;
use crate::transaction::{Applied, Edit, EditSet, Transaction, shift};

/// One open text file being edited.
///
/// The document owns the text, every selection, the undo history and a version that rises with
/// each edit. All positions are line plus UTF-16 column.
pub struct Document {
    pub(crate) buffer: Buffer,
    pub(crate) selections: Vec<Selection>,
    pub(crate) history: History,
    pub(crate) version: u64,
}

/// The result of applying one set of changes: what the highlighter needs and the inverse edits.
pub(crate) struct Outcome {
    pub applied: Applied,
    pub inverse: EditSet,
}

impl Document {
    /// A document holding `text`, with one caret at the start.
    pub fn new(text: &str) -> Document {
        Document {
            buffer: Buffer::new(text),
            selections: vec![Selection::caret(Position::new(0, 0))],
            history: History::default(),
            version: 0,
        }
    }

    /// The whole text, with its original line endings.
    pub fn text(&self) -> String {
        self.buffer.text()
    }

    /// The number of lines. A trailing line break leaves a last empty line, as the DOM does.
    pub fn len_lines(&self) -> usize {
        self.buffer.len_lines()
    }

    /// One line without its line ending. An index past the end is empty.
    pub fn line(&self, index: usize) -> Cow<'_, str> {
        self.buffer.line(index)
    }

    /// The line ending the document was loaded with, used for every new line.
    pub fn line_ending(&self) -> LineEnding {
        self.buffer.line_ending()
    }

    /// The number of edits applied so far. Clients use it to discard stale results.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// The current cursors, in document order. The last one is the primary.
    pub fn selections(&self) -> &[Selection] {
        &self.selections
    }

    /// Replaces every selection, clamping positions to the document and merging overlaps.
    ///
    /// This ends the current typing run: the next keystroke starts a new undo step.
    pub fn set_selections(&mut self, selections: Vec<Selection>) {
        self.selections = self.normalize_selections(selections);
        self.history.close();
    }

    /// Applies a transaction and reports the changed lines.
    ///
    /// Selections are carried through the changes: a selection whose text was replaced becomes a
    /// caret after the new text, and the others move with the text around them.
    pub fn apply(&mut self, edit: Transaction) -> Applied {
        let edits = self.transaction_edits(edit);
        if edits.is_empty() {
            return self.unchanged();
        }
        let before: Vec<(usize, usize)> = self
            .selections
            .iter()
            .map(|selection| {
                (
                    self.buffer.offset(selection.anchor),
                    self.buffer.offset(selection.head),
                )
            })
            .collect();
        let outcome = self.run(&edits);
        let after = before
            .into_iter()
            .map(|(anchor, head)| {
                Selection::new(
                    self.buffer.position(map_offset(anchor, &edits)),
                    self.buffer.position(map_offset(head, &edits)),
                )
            })
            .collect();
        self.finish(edits, outcome, after, false)
    }

    /// Undoes the last step, or returns `None` when there is nothing to undo.
    pub fn undo(&mut self) -> Option<Applied> {
        let mut entry = self.history.take_undo()?;
        let outcome = self.run(&entry.inverse);
        let before = std::mem::take(&mut entry.before);
        self.selections = self.normalize_selections(before);
        self.history.push_redo(entry);
        Some(outcome.applied)
    }

    /// Redoes the step undone last, or returns `None` when there is nothing to redo.
    pub fn redo(&mut self) -> Option<Applied> {
        let mut entry = self.history.take_redo()?;
        let outcome = self.run(&entry.forward);
        let after = std::mem::take(&mut entry.after);
        self.selections = self.normalize_selections(after);
        self.history.push_undo(entry);
        Some(outcome.applied)
    }

    /// Finds matches for a query, at most `limit` of them, in document order.
    ///
    /// A pattern that is not a valid regular expression finds nothing; callers validate queries
    /// before they reach the editor. Empty patterns and empty matches are skipped.
    pub fn find(&self, query: &FindQuery, limit: usize) -> Vec<Range> {
        if limit == 0 {
            return Vec::new();
        }
        let Some(regex) = find::compile(query) else {
            return Vec::new();
        };
        let text = self.buffer.text();
        let mut ranges = Vec::new();
        for matched in regex.find_iter(&text) {
            if matched.start() == matched.end() {
                continue;
            }
            if query.whole_word && !find::is_whole_word(&text, matched.start(), matched.end()) {
                continue;
            }
            ranges.push(Range::new(
                self.buffer.position(matched.start()),
                self.buffer.position(matched.end()),
            ));
            if ranges.len() >= limit {
                break;
            }
        }
        ranges
    }

    /// Ends the current typing run, so the next keystroke is a separate undo step.
    ///
    /// Call this when typing pauses; newline commands and selection changes already do it.
    pub fn commit(&mut self) {
        self.history.close();
    }

    pub(crate) fn unchanged(&self) -> Applied {
        Applied {
            first_line: 0,
            removed_lines: 0,
            inserted_lines: 0,
            version: self.version,
        }
    }

    pub(crate) fn run(&mut self, edits: &EditSet) -> Outcome {
        let (Some(first), Some(last)) = (edits.first(), edits.last()) else {
            return Outcome {
                applied: self.unchanged(),
                inverse: EditSet::default(),
            };
        };
        let first_line = self.buffer.line_at(first.start);
        let removed_lines = self
            .buffer
            .line_at(last.end)
            .saturating_sub(first_line)
            .saturating_add(1);

        let mut inverse = Vec::with_capacity(edits.len());
        let mut delta: isize = 0;
        for edit in edits.edits() {
            let post_start = shift(edit.start, delta);
            inverse.push(Edit {
                start: post_start,
                end: post_start + edit.text.len(),
                text: self.buffer.slice(edit.start, edit.end),
            });
            delta += edit.text.len() as isize - (edit.end - edit.start) as isize;
        }
        let last_post_end = inverse.last().map_or(0, |edit| edit.end);

        for edit in edits.edits().iter().rev() {
            self.buffer.remove(edit.start, edit.end);
            if !edit.text.is_empty() {
                self.buffer.insert(edit.start, &edit.text);
            }
        }

        self.version += 1;
        let inserted_lines = self
            .buffer
            .line_at(last_post_end)
            .saturating_sub(first_line)
            .saturating_add(1);

        Outcome {
            applied: Applied {
                first_line,
                removed_lines,
                inserted_lines,
                version: self.version,
            },
            inverse: EditSet::new(inverse),
        }
    }

    pub(crate) fn finish(
        &mut self,
        forward: EditSet,
        outcome: Outcome,
        after: Vec<Selection>,
        typing: bool,
    ) -> Applied {
        let after = self.normalize_selections(after);
        if typing && self.history.absorb_typing(&forward, &after) {
            self.selections = after;
            return outcome.applied;
        }
        let entry_after = after.clone();
        let before = std::mem::replace(&mut self.selections, after);
        self.history.record(
            Entry {
                forward,
                inverse: outcome.inverse,
                before,
                after: entry_after,
            },
            typing,
        );
        outcome.applied
    }

    /// Applies an edit set built by a command and leaves a caret at the end of every change.
    pub(crate) fn apply_edits(&mut self, edits: EditSet, typing: bool) -> Applied {
        if edits.is_empty() {
            return self.unchanged();
        }
        let carets = edits.post_ends();
        let outcome = self.run(&edits);
        let after = carets
            .into_iter()
            .map(|offset| Selection::caret(self.buffer.position(offset)))
            .collect();
        self.finish(edits, outcome, after, typing)
    }

    pub(crate) fn normalize_selections(&self, selections: Vec<Selection>) -> Vec<Selection> {
        if selections.is_empty() {
            return vec![Selection::caret(Position::default())];
        }
        struct Span {
            start: usize,
            end: usize,
            selection: Selection,
        }
        let mut spans: Vec<Span> = selections
            .into_iter()
            .map(|selection| {
                let anchor = self.buffer.offset(selection.anchor);
                let head = self.buffer.offset(selection.head);
                Span {
                    start: anchor.min(head),
                    end: anchor.max(head),
                    selection,
                }
            })
            .collect();
        spans.sort_by_key(|span| (span.start, span.end));

        let mut out = Vec::with_capacity(spans.len());
        let mut open: Option<Span> = None;
        for span in spans {
            match open.take() {
                None => open = Some(span),
                Some(current) => {
                    let caret_inside_selection = if current.start == current.end {
                        span.start <= current.start && current.start <= span.end
                    } else if span.start == span.end {
                        current.start <= span.start && span.start <= current.end
                    } else {
                        false
                    };
                    if span.start < current.end || caret_inside_selection {
                        let start = current.start.min(span.start);
                        let end = current.end.max(span.end);
                        open = Some(Span {
                            start,
                            end,
                            selection: Selection::new(
                                self.buffer.position(start),
                                self.buffer.position(end),
                            ),
                        });
                    } else {
                        out.push(current.selection);
                        open = Some(span);
                    }
                }
            }
        }
        if let Some(current) = open {
            out.push(current.selection);
        }
        out
    }

    fn transaction_edits(&self, transaction: Transaction) -> EditSet {
        let mut edits = Vec::new();
        let mut last_end = 0;
        for change in transaction.into_changes() {
            let start = self.buffer.offset(change.range.start).max(last_end);
            let end = self.buffer.offset(change.range.end).max(start);
            if start != end || !change.text.is_empty() {
                edits.push(Edit {
                    start,
                    end,
                    text: change.text,
                });
            }
            last_end = end;
        }
        EditSet::new(edits)
    }
}

fn map_offset(offset: usize, edits: &EditSet) -> usize {
    let mut delta: isize = 0;
    for edit in edits.edits() {
        if offset < edit.start {
            break;
        }
        if offset < edit.end {
            return shift(edit.start, delta) + edit.text.len();
        }
        delta += edit.text.len() as isize - (edit.end - edit.start) as isize;
    }
    shift(offset, delta)
}
