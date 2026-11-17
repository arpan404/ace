// SPDX-License-Identifier: Apache-2.0

//! What a single folder entry is, and the per-entry numbers the panel shows.

use std::fs::{FileType, Metadata};
use std::time::{SystemTime, UNIX_EPOCH};

/// What an entry is, as the Files panel draws it.
///
/// A symlink reports what it points at, but only when that target is inside the root: following a
/// link out of the checkout would show the person files ace cannot open, so it stays unnamed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// A regular file.
    File,
    /// A folder.
    Directory,
    /// A symlink, with its target's kind when the target can be inspected inside the root.
    Symlink { target: Option<Box<Kind>> },
    /// Anything else: sockets, devices, pipes.
    Other,
}

impl Kind {
    /// Whether the entry sorts and behaves as a folder.
    ///
    /// Symlinks that point at a folder count as folders, which is how the panel groups them.
    pub fn is_directory(&self) -> bool {
        match self {
            Kind::Directory => true,
            Kind::Symlink {
                target: Some(target),
            } => target.is_directory(),
            _ => false,
        }
    }
}

/// One entry of a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// Path from the root, `/` separated, as the caller will send it back.
    pub path: String,
    /// The last path segment, which is what the tree labels.
    pub name: String,
    /// What the entry is.
    pub kind: Kind,
    /// Bytes for files, 0 for folders; a symlink reports its own length.
    pub size: u64,
    /// Modification time in milliseconds since the Unix epoch, or 0 when unknown.
    pub mtime_ms: i64,
    /// Whether git's ignore rules apply to this entry. The panel dims these and still lists them.
    pub ignored: bool,
}

/// The kind of a non-symlink file type.
pub(crate) fn kind_of(file_type: &FileType) -> Kind {
    if file_type.is_symlink() {
        Kind::Symlink { target: None }
    } else if file_type.is_dir() {
        Kind::Directory
    } else if file_type.is_file() {
        Kind::File
    } else {
        Kind::Other
    }
}

/// The size the panel shows: folders have none.
pub(crate) fn size_of(metadata: &Metadata, kind: &Kind) -> u64 {
    if *kind == Kind::Directory {
        0
    } else {
        metadata.len()
    }
}

/// Milliseconds since the Unix epoch, negative before it.
pub(crate) fn millis(time: SystemTime) -> i64 {
    match time.duration_since(UNIX_EPOCH) {
        Ok(age) => i64::try_from(age.as_millis()).unwrap_or(i64::MAX),
        Err(before) => -i64::try_from(before.duration().as_millis()).unwrap_or(i64::MAX),
    }
}
