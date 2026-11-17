// SPDX-License-Identifier: Apache-2.0

//! Transactions: one set of changes applied to a document at once.

use crate::error::Error;
use crate::position::{Position, Range};

/// One change: replace `range` with `text`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    /// The span in the document before the transaction.
    pub range: Range,
    /// The text that takes its place.
    pub text: String,
}

/// A set of changes applied together, one per selection when several cursors edit at once.
///
/// Ranges are in the coordinates of the document before the transaction. When it is applied, the
/// changes run from the start of the document to the end and each later one is shifted by the
/// text earlier changes inserted or removed. Changes never overlap; an attempt to add one that
/// does is an [`Error::InvalidEdit`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Transaction {
    changes: Vec<Change>,
}

impl Transaction {
    /// An empty transaction.
    pub fn new() -> Transaction {
        Transaction::default()
    }

    /// Insert `text` at `at`.
    pub fn insert(at: Position, text: impl Into<String>) -> Transaction {
        Transaction::single(Range::empty(at), text.into())
    }

    /// Replace the text in `range` with `text`.
    pub fn replace(range: Range, text: impl Into<String>) -> Transaction {
        Transaction::single(range, text.into())
    }

    /// Delete the text in `range`.
    pub fn delete(range: Range) -> Transaction {
        Transaction::single(range, String::new())
    }

    fn single(range: Range, text: String) -> Transaction {
        if range.is_empty() && text.is_empty() {
            return Transaction::default();
        }
        Transaction {
            changes: vec![Change { range, text }],
        }
    }

    /// Add one more change after the changes already present.
    ///
    /// Fails when the new range starts before an earlier change ends or covers the start of a
    /// later one. An empty insertion may share a point with another change; the changes are then
    /// applied in the order they were added.
    pub fn push(&mut self, range: Range, text: impl Into<String>) -> Result<(), Error> {
        let text = text.into();
        if range.is_empty() && text.is_empty() {
            return Ok(());
        }
        let index = self
            .changes
            .partition_point(|change| change.range.start <= range.start);
        let overlaps_previous = index
            .checked_sub(1)
            .and_then(|i| self.changes.get(i))
            .is_some_and(|previous| previous.range.end > range.start);
        let overlaps_next = self
            .changes
            .get(index)
            .is_some_and(|next| range.end > next.range.start);
        if overlaps_previous || overlaps_next {
            return Err(Error::InvalidEdit("changes overlap".to_owned()));
        }
        self.changes.insert(index, Change { range, text });
        Ok(())
    }

    /// The changes in document order.
    pub fn changes(&self) -> &[Change] {
        &self.changes
    }

    /// Whether the transaction changes nothing.
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    /// The number of changes.
    pub fn len(&self) -> usize {
        self.changes.len()
    }

    pub(crate) fn into_changes(self) -> Vec<Change> {
        self.changes
    }
}

/// One changed line span, ready for a line highlighter.
///
/// `first_line` is the first line of the span in the document *after* the edit. The old span
/// covered `removed_lines` lines there and the new one covers `inserted_lines` lines, counting
/// the first line. Applying a document's spans top to bottom with
/// `edit(first_line, removed_lines, inserted_lines)` is correct because every `first_line` is
/// already in post-edit coordinates.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LineEdit {
    /// The first changed line in the post-edit document.
    pub first_line: u32,
    /// The number of old lines in the span.
    pub removed_lines: u32,
    /// The number of new lines in the span.
    pub inserted_lines: u32,
}

/// What a highlighter needs to know about a completed edit.
///
/// `spans` holds one [`LineEdit`] per changed region, in post-edit coordinates and document order.
/// Changes whose old line spans share or touch a line are joined, so cursors on the same line or
/// on neighbouring lines produce one span while far-apart cursors produce several.
///
/// `first_line`, `removed_lines` and `inserted_lines` are the overall span covering every change.
/// They are a cheap coarse range for a fallback, and are zero on a no-op along with an empty
/// `spans`. A no-op leaves the version unchanged.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Applied {
    /// The first line of the overall span, zero-based.
    pub first_line: u32,
    /// How many old lines the overall span covers, counting the first line.
    pub removed_lines: u32,
    /// How many new lines the overall span covers, counting the first line.
    pub inserted_lines: u32,
    /// The precise spans to hand to a highlighter in order.
    pub spans: Vec<LineEdit>,
    /// The document version after the edit.
    pub version: u64,
}

/// One change in byte coordinates, the form the buffer and history use.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Edit {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// Changes sorted by start offset and taken in the coordinates of one document state.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct EditSet {
    edits: Vec<Edit>,
}

impl EditSet {
    pub(crate) fn new(mut edits: Vec<Edit>) -> EditSet {
        edits.retain(|edit| edit.start != edit.end || !edit.text.is_empty());
        edits.sort_by_key(|edit| edit.start);
        EditSet { edits }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.edits.is_empty()
    }

    pub(crate) fn len(&self) -> usize {
        self.edits.len()
    }

    pub(crate) fn edits(&self) -> &[Edit] {
        &self.edits
    }

    pub(crate) fn edits_mut(&mut self) -> &mut [Edit] {
        &mut self.edits
    }

    /// Each change's end in the document after the whole set is applied.
    pub(crate) fn post_ends(&self) -> Vec<usize> {
        let mut delta: isize = 0;
        self.edits
            .iter()
            .map(|edit| {
                let post = shift(edit.start, delta) + edit.text.len();
                delta += edit.text.len() as isize - (edit.end - edit.start) as isize;
                post
            })
            .collect()
    }
}

pub(crate) fn shift(offset: usize, delta: isize) -> usize {
    let shifted = offset as isize + delta;
    if shifted < 0 { 0 } else { shifted as usize }
}
