// SPDX-License-Identifier: Apache-2.0

//! Positions in a document and the ranges between them.

/// A caret or endpoint in a document.
///
/// Lines and columns are zero-based. Columns count UTF-16 code units, the unit the DOM and the
/// clients report, so a position survives a round trip through JavaScript unchanged.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Position {
    /// The zero-based line.
    pub line: u32,
    /// The zero-based column in UTF-16 code units.
    pub column: u32,
}

impl Position {
    /// A position at `line` and `column`.
    pub const fn new(line: u32, column: u32) -> Position {
        Position { line, column }
    }
}

/// An ordered span between two positions.
///
/// `start` is never after `end`; an empty range is a caret. The end is exclusive, so replacing an
/// empty range inserts and replacing `start..end` covers exactly the characters in between.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Range {
    /// The first position in the range.
    pub start: Position,
    /// The position after the last character in the range.
    pub end: Position,
}

impl Range {
    /// A range between two positions, put in document order.
    pub fn new(a: Position, b: Position) -> Range {
        if a <= b {
            Range { start: a, end: b }
        } else {
            Range { start: b, end: a }
        }
    }

    /// The empty range at one position.
    pub const fn empty(at: Position) -> Range {
        Range { start: at, end: at }
    }

    /// Whether the range covers no text.
    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }

    /// Whether a position lies in `start..end`.
    pub fn contains(&self, position: Position) -> bool {
        self.start <= position && position < self.end
    }
}
