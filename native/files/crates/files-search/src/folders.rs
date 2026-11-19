// SPDX-License-Identifier: Apache-2.0

//! The folders one walker thread is already authorized to read.
//!
//! The parallel walk visits a folder's files together, so opening each file through
//! [`files_safe::Root::open_parent`] walks the same names from the root again for every file: each
//! segment costs a lookup and a folder handle, and on a volume that cannot name an open handle it
//! costs a listing of the folder as well. One walk per folder is enough. The handle is opened
//! through [`files_safe::Root::open_dir`], which applies the same checks a per-file walk applies
//! (the root is still ours, every segment is stepped through a handle, links are followed only
//! while they stay inside), and the files opened relative to it keep the checks a read needs: the
//! leaf is opened with no link following, and its identity is compared with the entry that was
//! walked.

use std::collections::VecDeque;

use files_safe::Root;

/// Folder handles one walker thread keeps. The walk hands over a folder's files together, so a
/// second slot already covers a walk that interleaves two folders; the rest is slack, and each
/// handle is one descriptor.
const KEPT: usize = 8;

/// Recently used folder handles, most recent first, keyed by the relative folder path.
#[derive(Default)]
pub(crate) struct Folders {
    open: VecDeque<(String, cap_std::fs::Dir)>,
}

impl Folders {
    /// The authorized handle for `folder`, an empty string for the root.
    ///
    /// `None` when the folder cannot be opened as the folder it was seen as: it is gone, is not a
    /// folder any more, or a link on the way left the root. The caller skips that file, as it skips
    /// one whose open fails.
    pub(crate) fn get(&mut self, root: &Root, folder: &str) -> Option<&cap_std::fs::Dir> {
        if let Some(index) = self.open.iter().position(|(held, _)| held == folder) {
            let slot = self.open.remove(index)?;
            self.open.push_front(slot);
        } else {
            let dir = root.open_dir(folder).ok()?;
            while self.open.len() >= KEPT {
                self.open.pop_back();
            }
            self.open.push_front((folder.to_owned(), dir));
        }
        self.open.front().map(|(_, dir)| dir)
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
                folder.read_to_string("one.txt").expect("the file is there"),
                "one"
            );
        }
        let root_folder = folders.get(&root, "").expect("the root opens");
        assert!(root_folder.open_dir("a").is_ok());
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
}
