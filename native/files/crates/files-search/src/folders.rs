// SPDX-License-Identifier: Apache-2.0

//! The folders one walker thread is already authorized to read.
//!
//! The parallel walk visits a folder's files together, so opening each file through
//! [`files_safe::Root::open_parent`] walks the same names from the root again for every file: each
//! segment costs a lookup and a folder handle, and on a volume that cannot name an open handle it
//! costs a listing of the folder as well. One walk per folder is enough.
//!
//! A handle is never trusted on its own word. Between two files of a folder the folder can be
//! renamed away and another one, or a link out of the root, put in its place, and the handle would
//! still read the folder it was opened on. So after every open through a handle, before anything
//! is read, one lookup through the root's handle proves that the folder's name still leads to the
//! same identity ([`Folder::still_named`], called by [`crate::open::open`]); when it does not,
//! the folder is opened again through [`files_safe::Root::open_dir_unstored`], which walks it step
//! by step and follows no link out of the root. Its names come from the walker's own listing, so
//! they are already the spellings the disk stores and none is looked up again. The files themselves keep the checks a read needs: the leaf
//! is opened with no link following, and its identity is compared with the entry that was walked.

use std::collections::VecDeque;

use files_safe::{Identity, Root};

/// Folder handles one walker thread keeps. The walk hands over a folder's files together, so a
/// second slot already covers a walk that interleaves two folders; the rest is slack, and each
/// handle is one descriptor.
const KEPT: usize = 8;

/// Recently used folder handles, most recent first, keyed by the relative folder path.
#[derive(Default)]
pub(crate) struct Folders {
    open: VecDeque<Folder>,
}

/// One authorized folder handle.
pub(crate) struct Folder {
    path: String,
    pub(crate) dir: cap_std::fs::Dir,
    /// What names this folder, kept so the handle can be proven with one lookup.
    identity: Option<Identity>,
}

impl Folder {
    /// Whether the folder's checkout path still names the folder this handle holds, asked with one
    /// lookup. A file opened through the handle is read only after this answers `true`.
    pub(crate) fn still_named(&self, root: &Root) -> bool {
        root.still_names(&self.path, self.identity)
    }
}

impl Folders {
    /// The handle for `folder`, an empty string for the root: the one already held, or one opened
    /// now by walking the folder from the root.
    ///
    /// A held handle is handed back unproven; whoever opens a file through it proves it with
    /// [`Folder::still_named`] before reading, and calls [`Folders::forget`] when that fails.
    /// `None` when the folder cannot be opened as the folder it was seen as: it is gone, is not a
    /// folder any more, or a link on the way left the root. The caller skips that file, as it skips
    /// one whose open fails.
    pub(crate) fn get(&mut self, root: &Root, folder: &str) -> Option<&Folder> {
        if let Some(index) = self.open.iter().position(|held| held.path == folder) {
            if index > 0
                && let Some(held) = self.open.remove(index)
            {
                self.open.push_front(held);
            }
        } else {
            let dir = root.open_dir_unstored(folder).ok()?;
            let identity = root.folder_identity(&dir);
            while self.open.len() >= KEPT {
                self.open.pop_back();
            }
            self.open.push_front(Folder {
                path: folder.to_owned(),
                dir,
                identity,
            });
        }
        self.open.front()
    }

    /// Drops the handle for `folder`, whose checkout path no longer names it.
    pub(crate) fn forget(&mut self, folder: &str) {
        self.open.retain(|held| held.path != folder);
    }
}

#[cfg(test)]
mod tests {
    use super::Folders;
    use files_safe::Root;

    #[test]
    fn hands_back_the_folder_it_was_asked_for() {
        let dir = tempfile::tempdir().expect("a temp dir");
        std::fs::create_dir_all(dir.path().join("a/b")).expect("folders");
        std::fs::write(dir.path().join("a/b/one.txt"), "one").expect("a file");
        let root = Root::open(dir.path()).expect("the root opens");
        let mut folders = Folders::default();

        for _ in 0..3 {
            let folder = folders.get(&root, "a/b").expect("the folder opens");
            assert_eq!(
                folder
                    .dir
                    .read_to_string("one.txt")
                    .expect("the file is there"),
                "one"
            );
        }
        let root_folder = folders.get(&root, "").expect("the root opens");
        assert!(root_folder.dir.open_dir("a").is_ok());
        assert!(folders.get(&root, "a/missing").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_is_a_link_out_of_the_root_is_never_handed_out() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let outside = tempfile::tempdir().expect("another temp dir");
        std::fs::write(outside.path().join("secret.txt"), "secret").expect("a file");
        std::os::unix::fs::symlink(outside.path(), dir.path().join("away")).expect("a link out");
        let root = Root::open(dir.path()).expect("the root opens");
        let mut folders = Folders::default();

        assert!(
            folders.get(&root, "away").is_none(),
            "a folder that leaves the root must not answer a search"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_cached_before_it_left_the_root_is_refused_after() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let outside = tempfile::tempdir().expect("another temp dir");
        std::fs::create_dir_all(dir.path().join("d")).expect("a folder");
        std::fs::write(dir.path().join("d/one.txt"), "one").expect("a file");
        let root = Root::open(dir.path()).expect("the root opens");
        let mut folders = Folders::default();
        assert!(
            folders.get(&root, "d").is_some(),
            "the folder is inside the root while it is cached"
        );

        // The folder moves out of the root and a link to where it went takes its name.
        std::fs::rename(dir.path().join("d"), outside.path().join("d")).expect("the move");
        std::os::unix::fs::symlink(outside.path().join("d"), dir.path().join("d"))
            .expect("a link out");

        let held = folders.get(&root, "d").expect("the handle is still held");
        assert!(
            !held.still_named(&root),
            "the held handle must not prove itself for a folder that left the root"
        );
        folders.forget("d");
        assert!(
            folders.get(&root, "d").is_none(),
            "opening the folder again must not follow the link out"
        );
    }
}
