// SPDX-License-Identifier: Apache-2.0

//! The document: text, selections, version and the edit pipeline.

use std::borrow::Cow;
use std::cell::RefCell;

use crate::applied::{OffsetMapper, Outcome};
use crate::buffer::{Buffer, LineEnding};
use crate::history::{Entry, History};
use crate::indent::Indent;
use crate::position::Position;
use crate::selection::Selection;
use crate::transaction::{Applied, Edit, EditSet, Transaction};

/// One open text file being edited.
///
/// The document owns the text, every selection, the undo history and a version that rises with
/// each edit. All positions are line plus UTF-16 column.
pub struct Document {
    pub(crate) buffer: Buffer,
    pub(crate) selections: Vec<Selection>,
    /// The index of the newest selection in `selections`; the UI reveals this one.
    pub(crate) primary: usize,
    pub(crate) history: History,
    pub(crate) version: u64,
    /// The whole text, kept between finds and rebuilt when the version moves.
    pub(crate) search_text: RefCell<Option<(u64, String)>>,
    /// Whether the current next-occurrence chain started from a word under a caret.
    pub(crate) word_chain: bool,
    /// How an indent step is written.
    pub(crate) indent: Indent,
}

impl Document {
    /// A document holding `text`, with one caret at the start.
    pub fn new(text: &str) -> Document {
        Document {
            buffer: Buffer::new(text),
            selections: vec![Selection::caret(Position::new(0, 0))],
            primary: 0,
            history: History::default(),
            version: 0,
            search_text: RefCell::new(None),
            word_chain: false,
            indent: Indent::default(),
        }
    }

    /// How one indent step is written: tabs, or a number of spaces.
    pub fn indent(&self) -> Indent {
        self.indent
    }

    /// Sets how indent commands, Tab and new lines write one indent step.
    pub fn set_indent(&mut self, indent: Indent) {
        self.indent = Indent {
            tabs: indent.tabs,
            size: indent.size.clamp(1, 16),
        };
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

    /// The current cursors, in document order.
    pub fn selections(&self) -> &[Selection] {
        &self.selections
    }

    /// The index in [`Document::selections`] of the newest cursor, the one the UI reveals.
    pub fn primary_selection(&self) -> usize {
        self.primary.min(self.selections.len().saturating_sub(1))
    }

    /// Replaces every selection, clamping positions to the document and merging overlaps.
    ///
    /// The last selection in `selections` is the newest and becomes the primary. The current
    /// typing run ends only if the normalised selections actually differ, so a client echoing
    /// the carets back on every keystroke does not split the undo step.
    pub fn set_selections(&mut self, selections: Vec<Selection>) {
        let primary = selections.len().saturating_sub(1);
        let (normalised, primary) = self.normalize_selections(selections, primary);
        let changed = normalised != self.selections;
        self.selections = normalised;
        self.primary = primary;
        if changed {
            self.word_chain = false;
            self.history.close();
        }
    }

    /// Applies a transaction and reports the changed lines.
    ///
    /// Selections are carried through the changes: a selection whose text was replaced becomes a
    /// caret after the new text, and the others move with the text around them.
    pub fn apply(&mut self, edit: Transaction) -> Applied {
        let edits = self.transaction_edits(edit);
        self.apply_mapped(edits)
    }

    /// Applies an edit set, carrying every selection through it as [`Document::apply`] does.
    pub(crate) fn apply_mapped(&mut self, edits: EditSet) -> Applied {
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
        let mapped: Vec<(usize, usize, bool)> = {
            let mut mapper = OffsetMapper::new(&edits);
            before
                .into_iter()
                .map(|(anchor, head)| {
                    let forward = anchor <= head;
                    let (start, end) = if forward {
                        (anchor, head)
                    } else {
                        (head, anchor)
                    };
                    let start = mapper.map(start);
                    let end = mapper.map(end);
                    (start, end, forward)
                })
                .collect()
        };
        let outcome = self.run(&edits);
        let after = mapped
            .into_iter()
            .map(|(start, end, forward)| {
                let start = self.buffer.position(start);
                let end = self.buffer.position(end);
                if forward {
                    Selection::new(start, end)
                } else {
                    Selection::new(end, start)
                }
            })
            .collect();
        self.finish(edits, outcome, after, false)
    }

    /// Undoes the last step, or returns `None` when there is nothing to undo.
    pub fn undo(&mut self) -> Option<Applied> {
        let mut entry = self.history.take_undo()?;
        let outcome = self.run(&entry.inverse);
        let before = std::mem::take(&mut entry.before);
        let primary = before.len().saturating_sub(1);
        let (selections, primary) = self.normalize_selections(before, primary);
        self.selections = selections;
        self.primary = primary;
        self.word_chain = false;
        self.history.push_redo(entry);
        Some(outcome.applied)
    }

    /// Redoes the step undone last, or returns `None` when there is nothing to redo.
    pub fn redo(&mut self) -> Option<Applied> {
        let mut entry = self.history.take_redo()?;
        let outcome = self.run(&entry.forward);
        let after = std::mem::take(&mut entry.after);
        let primary = after.len().saturating_sub(1);
        let (selections, primary) = self.normalize_selections(after, primary);
        self.selections = selections;
        self.primary = primary;
        self.word_chain = false;
        self.history.push_undo(entry);
        Some(outcome.applied)
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
            spans: Vec::new(),
            replacements: Vec::new(),
            version: self.version,
        }
    }

    pub(crate) fn finish(
        &mut self,
        forward: EditSet,
        outcome: Outcome,
        after: Vec<Selection>,
        typing: bool,
    ) -> Applied {
        let primary = after.len().saturating_sub(1);
        let (after, primary) = self.normalize_selections(after, primary);
        self.primary = primary;
        self.word_chain = false;
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

    /// Applies an edit set and leaves the selections at `after`, given as (anchor, head) byte
    /// offsets in the text after the edit.
    pub(crate) fn apply_with_offsets(
        &mut self,
        edits: EditSet,
        after: Vec<(usize, usize)>,
        typing: bool,
    ) -> Applied {
        if edits.is_empty() {
            return self.unchanged();
        }
        let outcome = self.run(&edits);
        let after = after
            .into_iter()
            .map(|(anchor, head)| {
                Selection::new(self.buffer.position(anchor), self.buffer.position(head))
            })
            .collect();
        self.finish(edits, outcome, after, typing)
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

    /// Sorts, clamps and merges selections. `primary` indexes `selections`; the returned index
    /// points at the same selection after sorting and merging.
    pub(crate) fn normalize_selections(
        &self,
        selections: Vec<Selection>,
        primary: usize,
    ) -> (Vec<Selection>, usize) {
        if selections.is_empty() {
            return (vec![Selection::caret(Position::default())], 0);
        }
        let primary = primary.min(selections.len() - 1);

        struct Span {
            start: usize,
            end: usize,
            index: usize,
            reversed: bool,
        }
        let mut spans: Vec<Span> = selections
            .into_iter()
            .enumerate()
            .map(|(index, selection)| {
                let anchor = self.buffer.offset(selection.anchor);
                let head = self.buffer.offset(selection.head);
                Span {
                    start: anchor.min(head),
                    end: anchor.max(head),
                    index,
                    reversed: anchor > head,
                }
            })
            .collect();
        spans.sort_by_key(|span| (span.start, span.end));

        struct Open {
            start: usize,
            end: usize,
            later: usize,
            later_reversed: bool,
            has_primary: bool,
        }
        let mut out = Vec::with_capacity(spans.len());
        let mut primary_out = None;
        let mut open: Option<Open> = None;
        for span in spans {
            let has_primary = span.index == primary;
            match open.take() {
                None => {
                    open = Some(Open {
                        start: span.start,
                        end: span.end,
                        later: span.index,
                        later_reversed: span.reversed,
                        has_primary,
                    });
                }
                Some(mut current) => {
                    let caret_inside_selection = if current.start == current.end {
                        span.start <= current.start && current.start <= span.end
                    } else if span.start == span.end {
                        current.start <= span.start && span.start <= current.end
                    } else {
                        false
                    };
                    if span.start < current.end || caret_inside_selection {
                        current.start = current.start.min(span.start);
                        current.end = current.end.max(span.end);
                        if span.index > current.later {
                            current.later = span.index;
                            current.later_reversed = span.reversed;
                        }
                        current.has_primary |= has_primary;
                        open = Some(current);
                    } else {
                        let out_index = out.len();
                        if current.has_primary {
                            primary_out = Some(out_index);
                        }
                        out.push(self.normalized_selection(
                            current.start,
                            current.end,
                            current.later_reversed,
                        ));
                        open = Some(Open {
                            start: span.start,
                            end: span.end,
                            later: span.index,
                            later_reversed: span.reversed,
                            has_primary,
                        });
                    }
                }
            }
        }
        if let Some(current) = open {
            let out_index = out.len();
            if current.has_primary {
                primary_out = Some(out_index);
            }
            out.push(self.normalized_selection(current.start, current.end, current.later_reversed));
        }
        let primary_out = primary_out.unwrap_or(out.len().saturating_sub(1));
        (out, primary_out)
    }

    fn normalized_selection(&self, start: usize, end: usize, reversed: bool) -> Selection {
        let start = self.buffer.position(start);
        let end = self.buffer.position(end);
        if reversed {
            Selection::new(end, start)
        } else {
            Selection::new(start, end)
        }
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
