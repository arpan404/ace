// SPDX-License-Identifier: Apache-2.0

//! One gutter mark per changed line of the current text, folded from diff rows the way
//! `lineMarks` in `packages/ui-core/src/line-marks.ts` folds them.

use crate::lines;
use crate::rows::{self, Row};

/// How a line of the current text differs from the original.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MarkKind {
    /// The line exists only in the current text.
    Added,
    /// The line stands in for a line of the original.
    Modified,
    /// Lines were removed just above this line, or at the end of the text this is the last line.
    Removed,
}

/// A gutter mark on one line of the current text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Mark {
    /// 1-based line of the current text.
    pub line: u32,
    /// What happened to that line.
    pub kind: MarkKind,
}

pub(super) fn marks(original: &str, current: &str) -> Vec<Mark> {
    let before: Vec<&str> = lines::split(original).collect();
    let after: Vec<&str> = lines::split(current).collect();
    if u32::try_from(before.len()).is_err() || u32::try_from(after.len()).is_err() {
        return Vec::new();
    }
    number(fold(&rows::diff(&before, &after))).unwrap_or_default()
}

/// Marks a run of removals and additions: the two pair up as modifications for as long as
/// both have a line, the rest of the additions are additions, and removals left over mark
/// the line below them (or the last line at the end of the text).
///
/// Marks come in ascending line order, so only the last mark can already sit on a line.
fn fold(rows: &[Row]) -> Vec<(usize, MarkKind)> {
    let mut marks: Vec<(usize, MarkKind)> = Vec::new();
    let mut removed = 0;
    let mut last_new = 0;
    for row in rows {
        match *row {
            Row::Del => removed += 1,
            Row::Add { new } => {
                let kind = if removed > 0 {
                    removed -= 1;
                    MarkKind::Modified
                } else {
                    MarkKind::Added
                };
                marks.push((new, kind));
                last_new = new;
            }
            Row::Context { new } => {
                if removed > 0 && marks.last().is_none_or(|(line, _)| *line != new) {
                    marks.push((new, MarkKind::Removed));
                }
                removed = 0;
                last_new = new;
            }
        }
    }
    if removed > 0 && last_new > 0 && marks.last().is_none_or(|(line, _)| *line != last_new) {
        marks.push((last_new, MarkKind::Removed));
    }
    marks
}

/// `None` when a line number does not fit [`Mark::line`], which the length check in
/// [`marks`] makes unreachable.
fn number(found: Vec<(usize, MarkKind)>) -> Option<Vec<Mark>> {
    let mut marks = Vec::with_capacity(found.len());
    for (line, kind) in found {
        marks.push(Mark {
            line: u32::try_from(line).ok()?,
            kind,
        });
    }
    Some(marks)
}
