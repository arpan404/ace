// SPDX-License-Identifier: Apache-2.0

//! Gutter marks for the original and current text.

use editor_diff::MarkKind;
use wasm_bindgen::prelude::*;

/// Gutter marks for `current`, by 1-based line number, as `(line, kind)` pairs.
///
/// `kind` is `0` for a line only the current text has, `1` for a line standing in for a line of
/// the original, and `2` for lines removed just above this one (or the last line at the end).
/// Pairs are ascending and a line carries at most one mark: exactly what a gutter draws.
#[wasm_bindgen(js_name = lineMarks)]
pub fn line_marks(original: &str, current: &str) -> Vec<u32> {
    let marks = editor_diff::line_marks(original, current);
    let mut flat = Vec::with_capacity(marks.len() * 2);
    for mark in marks {
        flat.push(mark.line);
        flat.push(kind(mark.kind));
    }
    flat
}

fn kind(kind: MarkKind) -> u32 {
    match kind {
        MarkKind::Added => 0,
        MarkKind::Modified => 1,
        MarkKind::Removed => 2,
    }
}
