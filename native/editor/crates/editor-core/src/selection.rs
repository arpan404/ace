// SPDX-License-Identifier: Apache-2.0

//! A selection: where the caret started and where it is now.

use crate::position::{Position, Range};

/// One cursor in a multi-cursor editor.
///
/// `anchor` is where the selection began and `head` is the moving end. They are equal for a plain
/// caret; otherwise the selected text is the range between them, whichever direction it runs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Selection {
    /// The fixed end of the selection.
    pub anchor: Position,
    /// The moving end, where typing happens.
    pub head: Position,
}

impl Selection {
    /// A selection between two positions, keeping their order.
    pub const fn new(anchor: Position, head: Position) -> Selection {
        Selection { anchor, head }
    }

    /// A plain caret with no selected text.
    pub const fn caret(at: Position) -> Selection {
        Selection {
            anchor: at,
            head: at,
        }
    }

    /// The selected text as an ordered range.
    pub fn range(&self) -> Range {
        Range::new(self.anchor, self.head)
    }

    /// Whether the selection covers no text.
    pub fn is_empty(&self) -> bool {
        self.anchor == self.head
    }
}
