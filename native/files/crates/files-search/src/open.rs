// SPDX-License-Identifier: Apache-2.0

//! Opens the file a walker saw, through the folder that holds it, and proves it is still in the
//! checkout before a byte of it is read.

use std::ffi::OsStr;

use cap_fs_ext::{FollowSymlinks, OpenOptions, OpenOptionsFollowExt};
use cap_std::fs::{File, Metadata};
use files_safe::Root;
use ignore::DirEntry;

use crate::folders::Folder;

/// What opening one walked file came to.
pub(crate) enum Opened {
    /// The file, with its metadata read once from the open handle.
    File(File, Metadata),
    /// The folder handle no longer answers for the folder at its checkout path: it moved, or
    /// something else took its name. The caller may open the folder again and retry once.
    Moved,
    /// The file cannot be opened, or is not the entry at that name any more: skip it.
    Skip,
}

/// Opens `name` inside `folder` for reading without following a final symlink.
///
/// The open goes through a folder handle that may have been proven a while ago, so the proof is
/// taken again after the open: the folder's checkout path must still name the folder the handle
/// holds (one lookup from the root), and the name inside it must still be the file that was
/// opened (one lookup through the handle). A folder moved out of the checkout between its last
/// proof and this open is caught here, before anything is read from the file.
pub(crate) fn open(root: &Root, folder: &Folder, name: &OsStr, seen: &DirEntry) -> Opened {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let Ok(file) = folder.dir.open_with(name, &options) else {
        return Opened::Skip;
    };
    let Ok(metadata) = file.metadata() else {
        return Opened::Skip;
    };
    if !folder.still_named(root) {
        return Opened::Moved;
    }
    if still_at_name(folder, name, &file, &metadata, seen) {
        Opened::File(file, metadata)
    } else {
        Opened::Skip
    }
}

/// Whether `name` in the proven folder is still the file that was opened.
///
/// The walker's name can be rewritten between the walk and the open, or the file moved away just
/// after it; comparing identities keeps a search from reading a file that is no longer the one at
/// that checkout path.
#[cfg(unix)]
fn still_at_name(
    folder: &Folder,
    name: &OsStr,
    _file: &File,
    opened: &Metadata,
    _seen: &DirEntry,
) -> bool {
    use cap_fs_ext::MetadataExt;

    let Ok(named) = folder.dir.symlink_metadata(name) else {
        return false;
    };
    named.dev() == opened.dev() && named.ino() == opened.ino()
}

/// Windows identifies files by volume and file index rather than device and inode, so the open
/// handle is compared with the walked path.
#[cfg(windows)]
fn still_at_name(
    _folder: &Folder,
    _name: &OsStr,
    file: &File,
    _opened: &Metadata,
    seen: &DirEntry,
) -> bool {
    let Ok(clone) = file.try_clone() else {
        return false;
    };
    let (Ok(opened), Ok(seen)) = (
        same_file::Handle::from_file(clone.into_std()),
        same_file::Handle::from_path(seen.path()),
    ) else {
        return false;
    };
    opened == seen
}

/// Platforms without a file identity cannot tell, so the open alone decides.
#[cfg(not(any(unix, windows)))]
fn still_at_name(
    _folder: &Folder,
    _name: &OsStr,
    _file: &File,
    _opened: &Metadata,
    _seen: &DirEntry,
) -> bool {
    true
}

#[cfg(all(test, unix))]
mod tests {
    use super::{Opened, open};
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

        let Opened::File(_, metadata) = open(&root, folder, entry.file_name(), &entry) else {
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
            open(&root, folder, entry.file_name(), &entry),
            Opened::Skip
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
            open(&root, folder, entry.file_name(), &entry),
            Opened::Moved
        ));
        // Opening the folder again finds nothing at its checkout path.
        folders.forget("d");
        assert!(folders.get(&root, "d").is_none());
    }
}
