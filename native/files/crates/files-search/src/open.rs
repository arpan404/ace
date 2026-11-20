// SPDX-License-Identifier: Apache-2.0

//! Opens the file a walker saw, through the folder that holds it, and proves it is still at its
//! checkout path before a byte of it is read.

use std::ffi::OsStr;

use cap_fs_ext::{FollowSymlinks, OpenOptions, OpenOptionsFollowExt};
use cap_std::fs::{File, Metadata};
use files_safe::Root;

use crate::folders::Folder;

/// What opening one walked file came to.
pub(crate) enum Opened {
    /// The file, with its metadata read once from the open handle.
    File(File, Metadata),
    /// The file could not be opened through this handle. A handle held from an earlier file may
    /// be stale: the caller opens the folder again and retries once.
    Failed,
    /// The checkout path no longer leads to the file that was opened. A handle held from an
    /// earlier file may be stale: the caller opens the folder again and retries once.
    Refused,
}

/// Opens `name` inside `folder` for reading without following a final symlink, then proves that
/// the checkout path leads to the file that was opened.
///
/// The handle may have been opened a while ago, and between then and now any folder above the
/// file can be moved out of the checkout or replaced by a link to somewhere else; the handle and
/// the file opened through it would still answer. So after the open, the file's folder is walked
/// again from the root with [`Root::open_dir_unstored`], which follows a link only while it stays
/// inside the root and refuses one that leaves it, and the name is looked up there without
/// following it. The file is accepted only when that entry is the open file.
pub(crate) fn open(root: &Root, folder: &Folder, name: &OsStr) -> Opened {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let Ok(file) = folder.dir.open_with(name, &options) else {
        return Opened::Failed;
    };
    let Ok(metadata) = file.metadata() else {
        return Opened::Failed;
    };
    #[cfg(test)]
    race::run();
    if at_checkout_path(root, folder.path(), name, &file, &metadata) {
        Opened::File(file, metadata)
    } else {
        Opened::Refused
    }
}

/// Whether `folder/name`, walked from the root right now, is the open file.
#[cfg(unix)]
fn at_checkout_path(
    root: &Root,
    folder: &str,
    name: &OsStr,
    _file: &File,
    opened: &Metadata,
) -> bool {
    use cap_fs_ext::MetadataExt;

    let Ok(dir) = root.open_dir_unstored(folder) else {
        return false;
    };
    let Ok(named) = dir.symlink_metadata(name) else {
        return false;
    };
    named.dev() == opened.dev() && named.ino() == opened.ino()
}

/// Windows identifies files by volume and file index rather than device and inode, so the entry
/// at the checkout path is opened, never following a link, and the two handles compared.
#[cfg(windows)]
fn at_checkout_path(
    root: &Root,
    folder: &str,
    name: &OsStr,
    file: &File,
    _opened: &Metadata,
) -> bool {
    let Ok(dir) = root.open_dir_unstored(folder) else {
        return false;
    };
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let (Ok(named), Ok(clone)) = (dir.open_with(name, &options), file.try_clone()) else {
        return false;
    };
    let (Ok(named), Ok(opened)) = (
        same_file::Handle::from_file(named.into_std()),
        same_file::Handle::from_file(clone.into_std()),
    ) else {
        return false;
    };
    named == opened
}

/// Platforms without a file identity cannot tell, so the walk alone decides.
#[cfg(not(any(unix, windows)))]
fn at_checkout_path(
    root: &Root,
    folder: &str,
    name: &OsStr,
    _file: &File,
    _opened: &Metadata,
) -> bool {
    root.open_dir_unstored(folder)
        .is_ok_and(|dir| dir.symlink_metadata(name).is_ok())
}

/// Test-only: a step that runs while a file is open but not yet accepted, so a test can change the
/// tree exactly there, the way a racing process would.
#[cfg(test)]
pub(crate) mod race {
    use std::cell::RefCell;

    thread_local! {
        static STEP: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
    }

    /// Runs `step` the next time a file opened on this thread is about to be accepted.
    pub(crate) fn before_accepting(step: impl FnOnce() + 'static) {
        STEP.with(|slot| *slot.borrow_mut() = Some(Box::new(step)));
    }

    pub(super) fn run() {
        if let Some(step) = STEP.with(|slot| slot.borrow_mut().take()) {
            step();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::{Opened, open, race};
    use crate::folders::Folders;
    use files_safe::Root;
    use ignore::{DirEntry, WalkBuilder};

    fn walked(root: &std::path::Path, name: &str) -> Option<DirEntry> {
        WalkBuilder::new(root)
            .hidden(false)
            .build()
            .filter_map(Result::ok)
            .find(|entry| entry.file_name() == name)
    }

    #[test]
    fn opens_the_file_the_walk_listed_with_its_size() {
        let dir = tempfile::tempdir().expect("a temp dir");
        std::fs::write(dir.path().join("one.txt"), "twelve bytes").expect("a file");
        let root = Root::open(dir.path()).expect("the root opens");
        let entry = walked(root.path(), "one.txt").expect("the walk lists the file");
        let mut folders = Folders::default();
        let folder = folders.get(&root, "").expect("the root folder");

        let Opened::File(_, metadata) = open(&root, folder, entry.file_name()) else {
            panic!("the file opens");
        };
        assert_eq!(metadata.len(), 12);
    }

    #[test]
    fn a_file_replaced_by_a_link_out_of_the_root_after_the_walk_is_not_read() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let outside = tempfile::tempdir().expect("another temp dir");
        std::fs::write(dir.path().join("one.txt"), "inside").expect("a file");
        std::fs::write(outside.path().join("secret.txt"), "secret").expect("a file");
        let root = Root::open(dir.path()).expect("the root opens");
        let entry = walked(root.path(), "one.txt").expect("the walk lists the file");

        std::fs::remove_file(dir.path().join("one.txt")).expect("the file goes");
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            dir.path().join("one.txt"),
        )
        .expect("a link out takes its name");
        let mut folders = Folders::default();
        let folder = folders.get(&root, "").expect("the root folder");

        assert!(matches!(
            open(&root, folder, entry.file_name()),
            Opened::Failed
        ));
    }

    #[test]
    fn a_folder_moved_out_of_the_root_after_its_handle_was_proven_is_not_read() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let outside = tempfile::tempdir().expect("another temp dir");
        std::fs::create_dir_all(dir.path().join("d")).expect("a folder");
        std::fs::write(dir.path().join("d/one.txt"), "moves out").expect("a file");
        let root = Root::open(dir.path()).expect("the root opens");
        let entry = walked(root.path(), "one.txt").expect("the walk lists the file");
        let mut folders = Folders::default();
        let folder = folders
            .get(&root, "d")
            .expect("the folder is inside while it is proven");

        // Between the proof and the open, the folder leaves the checkout.
        std::fs::rename(dir.path().join("d"), outside.path().join("d")).expect("the move");

        assert!(matches!(
            open(&root, folder, entry.file_name()),
            Opened::Refused
        ));
        // Opening the folder again finds nothing at its checkout path.
        folders.forget("d");
        assert!(folders.get(&root, "d").is_none());
    }

    /// A checkout `a/d/one.txt` with its folder handle held, and a folder outside it.
    // A broken fixture should fail the test loudly.
    #[allow(clippy::expect_used)]
    fn raced() -> (
        tempfile::TempDir,
        tempfile::TempDir,
        Root,
        DirEntry,
        Folders,
    ) {
        let dir = tempfile::tempdir().expect("a temp dir");
        let outside = tempfile::tempdir().expect("another temp dir");
        std::fs::create_dir_all(dir.path().join("a/d")).expect("folders");
        std::fs::write(dir.path().join("a/d/one.txt"), "inside").expect("a file");
        std::fs::write(outside.path().join("secret.txt"), "outside").expect("a file");
        let root = Root::open(dir.path()).expect("the root opens");
        let entry = walked(root.path(), "one.txt").expect("the walk lists the file");
        let mut folders = Folders::default();
        assert!(
            folders.get(&root, "a/d").is_some(),
            "the folder opens while inside"
        );
        (dir, outside, root, entry, folders)
    }

    #[allow(clippy::expect_used)]
    fn accepted(root: &Root, folders: &mut Folders, entry: &DirEntry) -> bool {
        let folder = folders.get(root, "a/d").expect("the held handle");
        matches!(open(root, folder, entry.file_name()), Opened::File(..))
    }

    #[test]
    fn an_ancestor_moved_out_between_the_proof_and_the_read_is_not_read() {
        let (dir, outside, root, entry, mut folders) = raced();
        let (from, to) = (dir.path().join("a"), outside.path().join("a"));
        race::before_accepting(move || std::fs::rename(from, to).expect("the move"));

        assert!(!accepted(&root, &mut folders, &entry));
    }

    #[test]
    fn an_ancestor_replaced_by_a_link_out_between_the_proof_and_the_read_is_not_read() {
        let (dir, outside, root, entry, mut folders) = raced();
        let (from, to) = (dir.path().join("a"), outside.path().join("a"));
        race::before_accepting(move || {
            std::fs::rename(&from, &to).expect("the move");
            std::os::unix::fs::symlink(&to, &from).expect("a link out takes its name");
        });

        assert!(!accepted(&root, &mut folders, &entry));
    }

    #[test]
    fn a_leaf_swapped_for_a_link_out_between_the_proof_and_the_read_is_not_read() {
        let (dir, outside, root, entry, mut folders) = raced();
        let leaf = dir.path().join("a/d/one.txt");
        let target = outside.path().join("secret.txt");
        race::before_accepting(move || {
            std::fs::remove_file(&leaf).expect("the file goes");
            std::os::unix::fs::symlink(&target, &leaf).expect("a link out takes its name");
        });

        assert!(!accepted(&root, &mut folders, &entry));
    }

    #[test]
    fn a_held_folder_whose_ancestor_became_a_link_out_is_not_read_through() {
        let (dir, outside, root, entry, mut folders) = raced();
        // Before the held handle is used again, its ancestor moves out and a link to where it went
        // takes its name, so the folder's path still reaches the same folder, through a link out.
        std::fs::rename(dir.path().join("a"), outside.path().join("a")).expect("the move");
        std::os::unix::fs::symlink(outside.path().join("a"), dir.path().join("a"))
            .expect("a link out takes its name");

        assert!(!accepted(&root, &mut folders, &entry));
    }
}
