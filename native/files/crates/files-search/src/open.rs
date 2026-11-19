// SPDX-License-Identifier: Apache-2.0

//! Opens the file a walker saw, through the folder that holds it.

use std::ffi::OsStr;

use cap_fs_ext::{FollowSymlinks, OpenOptions, OpenOptionsFollowExt};
use cap_std::fs::{Dir, File};
use ignore::DirEntry;

/// Opens `name` inside `folder` for reading without following a final symlink.
///
/// `None` means the file could not be opened, or is no longer the file the walker saw, so it must
/// not be searched.
pub(crate) fn open(folder: &Dir, name: &OsStr, seen: &DirEntry) -> Option<File> {
    let mut options = OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    let file = folder.open_with(name, &options).ok()?;
    still_the_entry(&file, seen).then_some(file)
}

/// Whether the opened file is the entry the walker produced.
///
/// The walker's path can be rewritten between the walk and the open; comparing the two entries
/// keeps a search from reading a file that was swapped in after it was listed.
#[cfg(unix)]
fn still_the_entry(file: &File, seen: &DirEntry) -> bool {
    use cap_fs_ext::OsMetadataExt as CapMetadata;
    use std::os::unix::fs::MetadataExt as StdMetadata;

    let (Ok(opened), Ok(seen)) = (file.metadata(), seen.metadata()) else {
        return false;
    };
    opened.dev() == seen.dev() && opened.ino() == seen.ino()
}

/// Windows identifies files by volume and file index rather than device and inode.
#[cfg(windows)]
fn still_the_entry(file: &File, seen: &DirEntry) -> bool {
    let Ok(clone) = file.try_clone() else {
        return false;
    };
    let (Ok(opened), Ok(seen)) = (
        same_file::Handle::from_file(clone.into_std_file()),
        same_file::Handle::from_path(seen.path()),
    ) else {
        return false;
    };
    opened == seen
}

/// Platforms without a file identity cannot tell, so the open alone decides.
#[cfg(not(any(unix, windows)))]
fn still_the_entry(_file: &File, _seen: &DirEntry) -> bool {
    true
}
