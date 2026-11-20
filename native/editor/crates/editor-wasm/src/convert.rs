// SPDX-License-Identifier: Apache-2.0

//! Conversions between the flat arrays JavaScript passes and the core's types.

use editor_core::{Position, Range, Selection, Transaction};

use crate::error::Failure;

/// Reads `(anchor line, anchor column, head line, head column)` quads.
pub(crate) fn selections(flat: &[u32]) -> Result<Vec<Selection>, Failure> {
    if !flat.len().is_multiple_of(4) {
        return Err(Failure::invalid(
            "selections need four numbers each: anchor line, anchor column, head line, head column",
        ));
    }
    Ok(flat
        .as_chunks::<4>()
        .0
        .iter()
        .map(|quad| match quad {
            [anchor_line, anchor_column, head_line, head_column] => Selection::new(
                Position::new(*anchor_line, *anchor_column),
                Position::new(*head_line, *head_column),
            ),
        })
        .collect())
}

/// Writes selections as quads.
pub(crate) fn flatten_selections(selections: &[Selection]) -> Vec<u32> {
    let mut flat = Vec::with_capacity(selections.len() * 4);
    for selection in selections {
        flat.push(selection.anchor.line);
        flat.push(selection.anchor.column);
        flat.push(selection.head.line);
        flat.push(selection.head.column);
    }
    flat
}

/// Writes ranges as `(start line, start column, end line, end column)` quads.
pub(crate) fn flatten_ranges(ranges: &[Range]) -> Vec<u32> {
    let mut flat = Vec::with_capacity(ranges.len() * 4);
    for range in ranges {
        flat.push(range.start.line);
        flat.push(range.start.column);
        flat.push(range.end.line);
        flat.push(range.end.column);
    }
    flat
}

/// Reads `(start line, start column, end line, end column)` quads.
pub(crate) fn ranges(flat: &[u32]) -> Result<Vec<Range>, Failure> {
    if !flat.len().is_multiple_of(4) {
        return Err(Failure::invalid(
            "ranges need four numbers each: start line, start column, end line, end column",
        ));
    }
    Ok(flat
        .as_chunks::<4>()
        .0
        .iter()
        .map(|quad| match quad {
            [start_line, start_column, end_line, end_column] => Range::new(
                Position::new(*start_line, *start_column),
                Position::new(*end_line, *end_column),
            ),
        })
        .collect())
}

/// Reads exactly one range quad.
pub(crate) fn range(flat: &[u32]) -> Result<Range, Failure> {
    match ranges(flat)?.as_slice() {
        [one] => Ok(*one),
        _ => Err(Failure::invalid("a range needs exactly four numbers")),
    }
}

/// Reads range quads and the replacement text of each, in the same order.
pub(crate) fn transaction(flat: &[u32], texts: Vec<String>) -> Result<Transaction, Failure> {
    if !flat.len().is_multiple_of(4) {
        return Err(Failure::invalid(
            "a transaction needs four numbers per change: start line, start column, end line, end column",
        ));
    }
    let changes = flat.len() / 4;
    if texts.len() != changes {
        return Err(Failure::invalid(format!(
            "a transaction needs one text per change: {changes} ranges, {} texts",
            texts.len()
        )));
    }
    let mut transaction = Transaction::new();
    for (quad, text) in flat.as_chunks::<4>().0.iter().zip(texts) {
        let range = match quad {
            [start_line, start_column, end_line, end_column] => Range::new(
                Position::new(*start_line, *start_column),
                Position::new(*end_line, *end_column),
            ),
        };
        transaction.push(range, text).map_err(Failure::from_core)?;
    }
    Ok(transaction)
}
