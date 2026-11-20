// SPDX-License-Identifier: Apache-2.0

//! Opens the file a walker saw, through the folder that holds it.

use std::ffi::OsStr;

use cap_fs_ext::{FollowSymlinks, OpenOptions, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File, Metadata};
use ignore::DirEntry;

use crate::folders::Folder;

/// Opens `name` inside `folder` for reading without following a final symlink, and hands back
/// its metadata with it, read once from the open handle.
///
/// `None` means the file could not be opened, or is no longer the file the walker saw, so it must
/// not be searched.
pub(crate) fn open(folder: &Folder, name: &OsStr, seen: &DirEntry) -> Option<(File, Metadata)> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = folder.dir.open_with(name, &options).ok()?;
    let metadata = file.metadata().ok()?;
    still_the_entry(&file, &metadata, folder.device, seen).then_some((file, metadata))
}

/// The device a folder handle lives on, so a file opened through it can be matched with the
/// entry the walk listed without another lookup.
#[cfg(unix)]
pub(crate) fn device(dir: &Dir) -> Option<u64> {
    use cap_fs_ext::MetadataExt;

    dir.dir_metadata().ok().map(|metadata| metadata.dev())
}

#[cfg(not(unix))]
pub(crate) fn device(_dir: &Dir) -> Option<u64> {
    None
}

/// Whether the opened file is the entry the walker produced.
///
/// The walker's path can be rewritten between the walk and the open; comparing the two entries
/// keeps a search from reading a file that was swapped in after it was listed. The walk read each
/// entry's inode from the folder listing, so a file that carries that inode on the folder's device
/// is the entry the walk saw, with no lookup at all. A file system whose listing reports other
/// numbers than `stat` does (some overlay mounts) falls back to comparing the name's identity
/// now, one `lstat`, which is never weaker than the listing's answer.
#[cfg(unix)]
fn still_the_entry(_file: &File, opened: &Metadata, device: Option<u64>, seen: &DirEntry) -> bool {
    use cap_fs_ext::MetadataExt as CapMetadata;
    use std::os::unix::fs::MetadataExt as StdMetadata;

    let (opened_device, opened_inode) = (CapMetadata::dev(opened), CapMetadata::ino(opened));
    if seen.ino() == Some(opened_inode) && device == Some(opened_device) {
        return true;
    }
    let Ok(seen) = seen.metadata() else {
        return false;
    };
    opened_device == StdMetadata::dev(&seen) && opened_inode == StdMetadata::ino(&seen)
}

/// Windows identifies files by volume and file index rather than device and inode.
#[cfg(windows)]
fn still_the_entry(file: &File, _opened: &Metadata, _device: Option<u64>, seen: &DirEntry) -> bool {
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
fn still_the_entry(
    _file: &File,
    _opened: &Metadata,
    _device: Option<u64>,
    _seen: &DirEntry,
) -> bool {
    true
}

#[cfg(all(test, unix))]
mod tests {
    use super::open;
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

        let (_, metadata) = open(folder, entry.file_name(), &entry).expect("the file opens");
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

        assert!(open(folder, entry.file_name(), &entry).is_none());
    }
}
