// SPDX-License-Identifier: Apache-2.0

//! One path's events inside an open window, reduced by the plan's merge rules.
//!
//! Created then deleted drops both, deleted then created is a modification, and repeated
//! events of one kind are one. A path created and deleted inside the window is reported as
//! nothing, so an editor's save dance never reaches the tree.

use crate::batch::{Change, ChangeKind};

/// How far the backend's event kinds can be trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Flavour {
    /// The kinds say what happened.
    Exact,
    /// FSEvents puts a created flag on the events of paths it did not watch being created,
    /// so a created immediately followed by a deleted is that flag, not a creation.
    Fsevents,
}

impl Flavour {
    /// The flavour of the OS backend on this platform.
    #[cfg(target_os = "macos")]
    #[must_use]
    pub(crate) const fn native() -> Flavour {
        Flavour::Fsevents
    }

    /// The flavour of the OS backend on this platform.
    #[cfg(not(target_os = "macos"))]
    #[must_use]
    pub(crate) const fn native() -> Flavour {
        Flavour::Exact
    }
}

/// The reduced state of one path inside the open window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// Created and deleted in this window: nothing to report.
    Gone,
    Created,
    Modified,
    Deleted,
}

/// How many raw events one path may hold before they are folded into their state.
const HISTORY: usize = 32;

/// The events seen for one path in the open window.
#[derive(Debug, Default)]
pub(crate) struct Observed {
    kinds: Vec<ChangeKind>,
    directory: bool,
}

impl Observed {
    /// Adds one event. The first report of a directory decides it for the window, because
    /// removal and rename events can no longer see what the path was.
    pub(crate) fn push(&mut self, kind: ChangeKind, directory: bool, flavour: Flavour) {
        self.directory |= directory;
        if kind == ChangeKind::Modified && self.kinds.last() == Some(&ChangeKind::Modified) {
            return;
        }
        if self.kinds.len() >= HISTORY {
            self.compact(flavour);
        }
        self.kinds.push(kind);
    }

    /// The change this path contributes to the batch, if it contributes one.
    pub(crate) fn change(&self, path: &str, flavour: Flavour) -> Option<Change> {
        let kind = self.reduce(flavour)?;
        Some(Change {
            path: path.to_owned(),
            kind,
            directory: self.directory,
        })
    }

    fn compact(&mut self, flavour: Flavour) {
        match self.reduce(flavour) {
            Some(state) => self.kinds = vec![state],
            None => self.kinds.clear(),
        }
    }

    fn reduce(&self, flavour: Flavour) -> Option<ChangeKind> {
        let mut state = None;
        for (index, kind) in self.kinds.iter().enumerate() {
            if flavour == Flavour::Fsevents
                && *kind == ChangeKind::Created
                && self.kinds.get(index + 1) == Some(&ChangeKind::Deleted)
            {
                continue;
            }
            state = step(state, *kind);
        }
        match state {
            Some(State::Gone) | None => None,
            Some(State::Created) => Some(ChangeKind::Created),
            Some(State::Modified) => Some(ChangeKind::Modified),
            Some(State::Deleted) => Some(ChangeKind::Deleted),
        }
    }
}

fn step(state: Option<State>, kind: ChangeKind) -> Option<State> {
    let state = match (state, kind) {
        (None, ChangeKind::Created) => State::Created,
        (None, ChangeKind::Modified) => State::Modified,
        (None, ChangeKind::Deleted) => State::Deleted,
        (Some(State::Gone), ChangeKind::Created) => State::Created,
        (Some(State::Gone), ChangeKind::Modified | ChangeKind::Deleted) => State::Gone,
        (Some(State::Created), ChangeKind::Created | ChangeKind::Modified) => State::Created,
        (Some(State::Created), ChangeKind::Deleted) => State::Gone,
        (Some(State::Modified), ChangeKind::Created | ChangeKind::Modified) => State::Modified,
        (Some(State::Modified), ChangeKind::Deleted) => State::Deleted,
        (Some(State::Deleted), ChangeKind::Created) => State::Modified,
        (Some(State::Deleted), ChangeKind::Modified | ChangeKind::Deleted) => State::Deleted,
    };
    Some(state)
}

#[cfg(test)]
mod tests {
    use super::{Flavour, Observed};
    use crate::batch::ChangeKind;

    fn observed(flavour: Flavour, kinds: &[ChangeKind]) -> Observed {
        let mut observed = Observed::default();
        for kind in kinds {
            observed.push(*kind, false, flavour);
        }
        observed
    }

    fn kind(flavour: Flavour, kinds: &[ChangeKind]) -> Option<ChangeKind> {
        observed(flavour, kinds)
            .change("a.txt", flavour)
            .map(|change| change.kind)
    }

    const CREATED: ChangeKind = ChangeKind::Created;
    const MODIFIED: ChangeKind = ChangeKind::Modified;
    const DELETED: ChangeKind = ChangeKind::Deleted;

    #[test]
    fn created_then_deleted_in_one_window_reports_nothing() {
        assert_eq!(kind(Flavour::Exact, &[CREATED, DELETED]), None);
    }

    #[test]
    fn deleted_then_created_in_one_window_is_a_modification() {
        assert_eq!(
            kind(Flavour::Exact, &[DELETED, CREATED]),
            Some(ChangeKind::Modified)
        );
    }

    #[test]
    fn repeated_modifications_are_one_change() {
        assert_eq!(
            kind(Flavour::Exact, &[MODIFIED, MODIFIED, MODIFIED]),
            Some(ChangeKind::Modified)
        );
    }

    #[test]
    fn creates_and_modifications_are_one_created_change() {
        assert_eq!(
            kind(Flavour::Exact, &[CREATED, MODIFIED, MODIFIED]),
            Some(ChangeKind::Created)
        );
    }

    #[test]
    fn a_deleted_path_ignores_later_modifications() {
        assert_eq!(
            kind(Flavour::Exact, &[DELETED, MODIFIED]),
            Some(ChangeKind::Deleted)
        );
    }

    #[test]
    fn fsevents_creation_flag_before_a_deletion_is_a_deletion() {
        assert_eq!(
            kind(Flavour::Fsevents, &[CREATED, DELETED, MODIFIED, MODIFIED]),
            Some(ChangeKind::Deleted)
        );
    }

    #[test]
    fn fsevents_creation_then_writes_then_deletion_reports_nothing() {
        assert_eq!(
            kind(
                Flavour::Fsevents,
                &[CREATED, MODIFIED, MODIFIED, CREATED, DELETED, MODIFIED],
            ),
            None
        );
    }

    #[test]
    fn a_directory_change_keeps_its_directory_flag() {
        let mut observed = Observed::default();
        observed.push(ChangeKind::Created, true, Flavour::Fsevents);
        observed.push(ChangeKind::Deleted, false, Flavour::Fsevents);
        let change = observed.change("folder", Flavour::Fsevents).unwrap();
        assert!(change.directory);
    }

    #[test]
    fn a_burst_on_one_path_does_not_grow_the_window_forever() {
        let mut observed = Observed::default();
        for _ in 0..1_000 {
            for kind in [CREATED, MODIFIED, CREATED, MODIFIED] {
                observed.push(kind, false, Flavour::Fsevents);
            }
        }
        assert_eq!(
            observed
                .change("hot.txt", Flavour::Fsevents)
                .map(|c| c.kind),
            Some(ChangeKind::Created)
        );
    }
}
