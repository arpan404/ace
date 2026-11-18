// SPDX-License-Identifier: Apache-2.0

//! One path's events inside an open window, judged against the filesystem at the end of it.
//!
//! Backends do not agree on why a path changed, and FSEvents splits one set of flags into
//! created, removed, renamed and modified events in a fixed order, so the sequence says little
//! on its own: `rm x; echo > x` arrives as create, remove, modify while `x` exists throughout.
//! What the window keeps is therefore a handful of facts, and the kind is decided by asking
//! the filesystem what is there now.

use crate::batch::{Change, ChangeKind};

/// The facts about one path in the open window.
#[derive(Debug, Default)]
pub(crate) struct Observed {
    directory: bool,
    first: Option<ChangeKind>,
    created_while_present: bool,
    saw_create: bool,
    saw_delete: bool,
    saw_modify: bool,
    saw_rename: bool,
}

impl Observed {
    /// Records one event. `rename` marks an event the backend described as a rename, and
    /// `present` is whether the path existed when the event was translated.
    pub(crate) fn push(
        &mut self,
        kind: ChangeKind,
        directory: bool,
        rename: bool,
        present: Option<bool>,
    ) {
        self.directory |= directory;
        self.first.get_or_insert(kind);
        self.saw_rename |= rename;
        match kind {
            ChangeKind::Created => {
                self.saw_create = true;
                self.created_while_present |= present.is_some();
            }
            ChangeKind::Deleted => self.saw_delete = true,
            ChangeKind::Modified => self.saw_modify = true,
        }
    }

    /// Records that something else lives at this path, which makes it a folder.
    pub(crate) fn mark_directory(&mut self) {
        self.directory = true;
    }

    /// The change this path contributes, or `None` when the window's news cancels out.
    ///
    /// `look` answers whether the path exists now, and whether it is a directory.
    pub(crate) fn resolve(
        &self,
        path: &str,
        look: &dyn Fn(&str) -> Option<bool>,
    ) -> Option<Change> {
        match look(path) {
            Some(directory) => {
                // New: seen on disk, first heard of as a creation, never removed, and not a
                // rename over an existing path (which arrives as a rename plus a write).
                let created = self.first == Some(ChangeKind::Created)
                    && self.created_while_present
                    && !self.saw_delete
                    && !(self.saw_rename && self.saw_modify);
                Some(Change {
                    path: path.to_owned(),
                    kind: if created {
                        ChangeKind::Created
                    } else {
                        ChangeKind::Modified
                    },
                    directory,
                })
            }
            None => {
                // Gone, and created inside the window: the pair cancels out. A creation that
                // was never on disk when an event was translated is the backend's flag on the
                // deletion of a path that was already there.
                if self.saw_create && self.created_while_present {
                    None
                } else {
                    Some(Change {
                        path: path.to_owned(),
                        kind: ChangeKind::Deleted,
                        directory: self.directory,
                    })
                }
            }
        }
    }

    /// The folder a rescan has to cover for this path: a directory names itself, anything
    /// else names the folder holding it.
    pub(crate) fn scope<'a>(&self, path: &'a str) -> &'a str {
        if self.directory && !self.saw_delete {
            path
        } else {
            parent(path)
        }
    }
}

/// The folder holding `path`, or `""` for a path at the root.
pub(crate) fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(folder, _)| folder)
}

#[cfg(test)]
mod tests {
    use super::Observed;
    use crate::batch::ChangeKind;

    fn resolve(
        kinds: &[(ChangeKind, bool, Option<bool>)],
        exists: Option<bool>,
    ) -> Option<(ChangeKind, bool)> {
        let mut observed = Observed::default();
        for (kind, rename, present) in kinds {
            observed.push(*kind, false, *rename, *present);
        }
        let look = |_: &str| exists;
        observed
            .resolve("x", &look)
            .map(|change| (change.kind, change.directory))
    }

    const CREATED: ChangeKind = ChangeKind::Created;
    const MODIFIED: ChangeKind = ChangeKind::Modified;
    const DELETED: ChangeKind = ChangeKind::Deleted;

    #[test]
    fn a_file_that_is_there_is_a_creation_only_when_it_was_never_removed() {
        assert_eq!(
            resolve(&[(CREATED, false, Some(false))], Some(false)),
            Some((ChangeKind::Created, false))
        );
        assert_eq!(
            resolve(
                &[
                    (CREATED, false, Some(false)),
                    (DELETED, false, None),
                    (MODIFIED, false, Some(false)),
                ],
                Some(false)
            ),
            Some((ChangeKind::Modified, false)),
            "unlink and recreate leaves the path in place"
        );
    }

    #[test]
    fn a_rename_onto_a_path_is_a_modification_but_a_plain_rename_is_a_creation() {
        assert_eq!(
            resolve(
                &[(CREATED, true, Some(false)), (MODIFIED, false, Some(false))],
                Some(false)
            ),
            Some((ChangeKind::Modified, false))
        );
        assert_eq!(
            resolve(&[(CREATED, true, Some(false))], Some(false)),
            Some((ChangeKind::Created, false))
        );
    }

    #[test]
    fn a_creation_and_deletion_in_one_window_cancels_out() {
        assert_eq!(
            resolve(
                &[(CREATED, false, Some(false)), (DELETED, false, None)],
                None
            ),
            None
        );
    }

    #[test]
    fn a_deletion_of_a_path_that_was_already_there_is_a_deletion() {
        assert_eq!(
            resolve(&[(CREATED, false, None), (DELETED, false, None)], None),
            Some((ChangeKind::Deleted, false))
        );
    }

    #[test]
    fn a_modified_path_that_is_gone_is_a_deletion() {
        assert_eq!(
            resolve(&[(MODIFIED, false, Some(false))], None),
            Some((ChangeKind::Deleted, false))
        );
    }

    #[test]
    fn a_directory_names_itself_for_a_rescan() {
        let mut observed = Observed::default();
        observed.push(CREATED, true, false, Some(true));
        assert_eq!(observed.scope("a/b"), "a/b");
        let mut deleted = Observed::default();
        deleted.push(DELETED, true, false, None);
        assert_eq!(deleted.scope("a/b"), "a");
    }
}
