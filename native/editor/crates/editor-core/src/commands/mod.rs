// SPDX-License-Identifier: Apache-2.0

//! Commands that build a transaction from the current selections and apply it.

mod comment;
mod line_edit;
mod lines;
mod select;
mod typing;

use crate::buffer::Buffer;
use crate::position::Position;
use crate::selection::Selection;
use crate::transaction::{Edit, EditSet};

/// Joins overlapping deletion ranges, so two carets inside one word or grapheme delete it once.
pub(crate) fn deletion_set(edits: Vec<Edit>) -> EditSet {
    let mut edits = edits;
    edits.sort_by_key(|edit| edit.start);
    let mut merged: Vec<Edit> = Vec::with_capacity(edits.len());
    for edit in edits {
        match merged.last_mut() {
            Some(last) if edit.start < last.end => last.end = last.end.max(edit.end),
            _ => merged.push(edit),
        }
    }
    EditSet::new(merged)
}

/// The lines a selection touches, as a half-open range.
///
/// A selection that ends at column zero of the next line does not include that line, so selecting
/// two whole lines by dragging to the start of the third comments or indents only the first two.
pub(crate) fn line_span(buffer: &Buffer, selection: Selection) -> (usize, usize) {
    let last = buffer.len_lines() - 1;
    let range = selection.range();
    let start = (range.start.line as usize).min(last);
    let mut end = (range.end.line as usize + 1).min(buffer.len_lines());
    if range.end.column == 0 && end > start + 1 {
        end -= 1;
    }
    (start, end.max(start + 1))
}

/// The distinct line spans of every selection, with overlapping and adjacent spans joined.
pub(crate) fn merged_line_spans(buffer: &Buffer, selections: &[Selection]) -> Vec<(usize, usize)> {
    let mut spans: Vec<(usize, usize)> = selections
        .iter()
        .map(|selection| line_span(buffer, *selection))
        .collect();
    spans.sort_unstable();
    let mut out: Vec<(usize, usize)> = Vec::new();
    for (start, end) in spans {
        match out.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out
}

/// Moves every selection endpoint on a line in the map by that line's delta.
pub(crate) fn shift_selection_lines(selection: Selection, shifts: &[(u32, i64)]) -> Selection {
    Selection::new(
        shift_point_line(selection.anchor, shifts),
        shift_point_line(selection.head, shifts),
    )
}

fn shift_point_line(point: Position, shifts: &[(u32, i64)]) -> Position {
    match shifts.binary_search_by_key(&point.line, |entry| entry.0) {
        Ok(index) => {
            let line = (point.line as i64 + shifts[index].1).max(0) as u32;
            Position::new(line, point.column)
        }
        Err(_) => point,
    }
}

/// Moves every selection endpoint on an edited line by that line's column delta.
pub(crate) fn adjust_selection_columns(
    selection: Selection,
    columns: &[(u32, u32, i64)],
) -> Selection {
    Selection::new(
        adjust_point_column(selection.anchor, columns),
        adjust_point_column(selection.head, columns),
    )
}

fn adjust_point_column(point: Position, columns: &[(u32, u32, i64)]) -> Position {
    let Ok(index) = columns.binary_search_by_key(&point.line, |entry| entry.0) else {
        return point;
    };
    let (_, edited_at, delta) = columns[index];
    if delta > 0 {
        if point.column >= edited_at {
            let column = point.column as i64 + delta;
            return Position::new(point.line, column.min(u32::MAX as i64) as u32);
        }
    } else if delta < 0 {
        let removed = (-delta) as u32;
        if point.column >= edited_at + removed {
            return Position::new(point.line, point.column - removed);
        }
        if point.column > edited_at {
            return Position::new(point.line, edited_at);
        }
    }
    point
}

/// Adjusts a selection after indentation: whole-line selections keep a column-zero start, while a
/// plain caret at column zero moves with the text it is about to type.
pub(crate) fn adjust_selection_for_indent(
    selection: Selection,
    columns: &[(u32, u32, i64)],
) -> Selection {
    let adjust = |point: Position| {
        let Ok(index) = columns.binary_search_by_key(&point.line, |entry| entry.0) else {
            return point;
        };
        let (_, edited_at, delta) = columns[index];
        let moves = point.column > edited_at || (point.column == 0 && selection.is_empty());
        if moves {
            Position::new(point.line, (point.column as i64 + delta).max(0) as u32)
        } else {
            point
        }
    };
    Selection::new(adjust(selection.anchor), adjust(selection.head))
}

/// Adjusts a selection after outdenting: endpoints left of the removed text clamp to the line start.
pub(crate) fn adjust_selection_for_outdent(
    selection: Selection,
    columns: &[(u32, u32, i64)],
) -> Selection {
    let adjust = |point: Position| {
        let Ok(index) = columns.binary_search_by_key(&point.line, |entry| entry.0) else {
            return point;
        };
        let (_, _, delta) = columns[index];
        let removed = (-delta) as u32;
        if point.column > 0 {
            Position::new(point.line, point.column.saturating_sub(removed))
        } else {
            point
        }
    };
    Selection::new(adjust(selection.anchor), adjust(selection.head))
}
