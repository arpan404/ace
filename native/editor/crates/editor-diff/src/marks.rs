// SPDX-License-Identifier: Apache-2.0

//! Turning a line diff into one mark per changed line of the current text.

use imara_diff::{Algorithm, Diff, InternedInput};

use crate::lines;

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
    let (prefix, suffix) = lines::shared_ends(&before, &after);
    let before_middle = &before[prefix..before.len() - suffix];
    let after_middle = &after[prefix..after.len() - suffix];

    let mut input: InternedInput<&str> = InternedInput::default();
    input.reserve(before_middle.len() as u32, after_middle.len() as u32);
    input.update_before(before_middle.iter().copied());
    input.update_after(after_middle.iter().copied());

    let mut diff = Diff::compute(Algorithm::Histogram, &input);
    diff.postprocess_lines(&input);

    let mut marks = Vec::new();
    for hunk in diff.hunks() {
        push_hunk_marks(&hunk, prefix, after.len(), &mut marks);
    }
    marks
}

/// Marks one changed block: its lines pair up as modifications for as long as both sides
/// have one, the rest are additions, and left-over removals land on the line below.
///
/// The diff only covered the lines between the shared ends, so `prefix` moves a block's
/// position in that middle to a line of the whole text.
fn push_hunk_marks(
    hunk: &imara_diff::Hunk,
    prefix: usize,
    line_count: usize,
    marks: &mut Vec<Mark>,
) {
    let removed = (hunk.before.end - hunk.before.start) as usize;
    let added = (hunk.after.end - hunk.after.start) as usize;
    let start = prefix + hunk.after.start as usize;
    for offset in 0..added {
        let kind = if offset < removed {
            MarkKind::Modified
        } else {
            MarkKind::Added
        };
        marks.push(Mark {
            line: line_number(start + offset),
            kind,
        });
    }
    if removed > added {
        mark_removal_below(start + added, line_count, marks);
    }
}

/// The line a removal shows on: the one below it, or the last line when it is at the end.
/// A line that already carries a mark keeps it, so a block that ends in modified lines does
/// not read as a removal as well.
fn mark_removal_below(below: usize, line_count: usize, marks: &mut Vec<Mark>) {
    let Some(last) = line_count.checked_sub(1) else {
        return;
    };
    let line = line_number(below.min(last));
    if marks.last().is_none_or(|mark| mark.line != line) {
        marks.push(Mark {
            line,
            kind: MarkKind::Removed,
        });
    }
}

/// 1-based line number from a 0-based index. imara-diff rejects texts over `i32::MAX` lines,
/// so the cast cannot truncate.
fn line_number(index: usize) -> u32 {
    index as u32 + 1
}
