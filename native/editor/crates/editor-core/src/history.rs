// SPDX-License-Identifier: Apache-2.0

//! Undo and redo: inverse transactions with the selections on both sides.

use crate::selection::Selection;
use crate::transaction::EditSet;

/// One undo step.
///
/// `forward` is in the coordinates of the document before the step and `inverse` in the
/// coordinates after it, so redo and undo can each be applied to exactly the state they expect.
/// The selections let undo restore the carets the person had before the edit.
#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub forward: EditSet,
    pub inverse: EditSet,
    pub before: Vec<Selection>,
    pub after: Vec<Selection>,
}

/// The two stacks plus whether the newest entry is still open to more typing.
#[derive(Debug, Default)]
pub(crate) struct History {
    undo: Vec<Entry>,
    redo: Vec<Entry>,
    open: bool,
}

impl History {
    pub(crate) fn record(&mut self, entry: Entry, typing: bool) {
        self.undo.push(entry);
        self.redo.clear();
        self.open = typing;
    }

    /// Ends the current typing run: the next key starts a new undo step.
    pub(crate) fn close(&mut self) {
        self.open = false;
    }

    /// Adds a keystroke to the open entry when it continues the same typing run.
    ///
    /// Returns false when the entry cannot absorb the keystroke, leaving both the entry and the
    /// history untouched.
    pub(crate) fn absorb_typing(&mut self, edits: &EditSet, after: &[Selection]) -> bool {
        if !self.open {
            return false;
        }
        let Some(entry) = self.undo.last_mut() else {
            return false;
        };
        if entry.forward.len() != edits.len() {
            return false;
        }
        let mut delta: isize = 0;
        for (old, new) in entry.forward.edits().iter().zip(edits.edits()) {
            let after = crate::transaction::shift(old.start, delta) + old.text.len();
            if new.start != new.end || new.start != after {
                return false;
            }
            delta += old.text.len() as isize - (old.end - old.start) as isize;
        }
        let mut extra = 0;
        for ((forward, inverse), new) in entry
            .forward
            .edits_mut()
            .iter_mut()
            .zip(entry.inverse.edits_mut().iter_mut())
            .zip(edits.edits())
        {
            forward.text.push_str(&new.text);
            inverse.start += extra;
            inverse.end += extra + new.text.len();
            extra += new.text.len();
        }
        entry.after = after.to_vec();
        true
    }

    pub(crate) fn take_undo(&mut self) -> Option<Entry> {
        self.open = false;
        self.undo.pop()
    }

    pub(crate) fn take_redo(&mut self) -> Option<Entry> {
        self.open = false;
        self.redo.pop()
    }

    pub(crate) fn push_undo(&mut self, entry: Entry) {
        self.undo.push(entry);
    }

    pub(crate) fn push_redo(&mut self, entry: Entry) {
        self.redo.push(entry);
    }
}
