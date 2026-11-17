// SPDX-License-Identifier: Apache-2.0

//! Gutter marks for ace's editor: how every line of the text on screen differs from the
//! version it is shown against.
//!
//! [`line_marks`] diffs the two texts by line and reports one [`Mark`] per changed line on
//! the current side, in ascending line order. A line carries at most one mark, so the
//! result is exactly what a gutter draws. The diff ports `diffTexts` from
//! `packages/ui-core/src/diff.ts` and the marks are that package's `lineMarks` fold, so
//! the gutter and the diff view always attribute a change to the same line.

mod lines;
mod marks;
mod rows;

pub use marks::{Mark, MarkKind};

/// Gutter marks for `current`, by 1-based line number, from its difference to `original`.
///
/// A replaced block marks [`MarkKind::Modified`] as many lines as both sides have, then
/// [`MarkKind::Added`] for the rest. When the block removed more lines than it added, one
/// [`MarkKind::Removed`] marks the line just below it, or the last line at the end of the
/// file. Text made of the same lines has no marks.
pub fn line_marks(original: &str, current: &str) -> Vec<Mark> {
    marks::marks(original, current)
}
