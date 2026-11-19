// SPDX-License-Identifier: Apache-2.0

//! Range reads: the bytes an editor asks for, plus what it needs to decode and display them.
//!
//! The file is opened from its parent's handle and never from a path, so a link cannot be
//! swapped between the check and the read. A final link is followed only where `files-safe`
//! proves it stays inside the root.

use std::io::{Read as _, Seek as _, SeekFrom};

use files_safe::Root;

use crate::Error;
use cap_std::fs::{Dir, File};

use crate::encoding::{self, SAMPLE_BYTES};
use crate::version;

/// The slice of a file to return: `length` bytes starting at `offset`.
#[derive(Debug, Clone, Copy)]
pub struct ReadRange {
    pub offset: u64,
    pub length: u64,
    /// When the file is larger than this, return no bytes at all, so the caller can show a
    /// warning instead of opening a huge file.
    pub max_size: Option<u64>,
}

/// A file slice with everything an editor needs to decide how to show it.
#[derive(Debug, Clone)]
pub struct Read {
    /// The file's full size, not the size of `bytes`.
    pub size: u64,
    /// The version of the file that was read, for a later guarded write.
    pub version: String,
    pub bytes: Vec<u8>,
    /// The first 8 KiB contain a NUL byte.
    pub binary: bool,
    /// `encoding_rs`'s canonical name for the detected encoding.
    pub encoding: &'static str,
    /// The file starts with a byte-order mark.
    pub bom: bool,
    /// `bytes` reaches the end of the file.
    pub eof: bool,
}

/// Reads one slice of a file.
///
/// A file that changes while it is being read is a `CONFLICT`, not a mix of old and new bytes:
/// the caller re-reads from the version in the error, as a download does.
pub fn read(root: &Root, path: &str, range: ReadRange) -> Result<Read, Error> {
    let parent = crate::policy::authorized_target(root, path)?;
    let (dir, name) = (parent.dir, parent.name);
    // The walk already followed a final link that stays inside the root, so the name the read
    // opens is the target's. Opening it without following proves the file that answers is the
    // one the policy authorized, even if a link is put at that name in between.
    let mut file = open_nofollow(&dir, &name)?;
    let opened = file.metadata()?;
    if !opened.is_file() {
        return Err(Error::NotFile(path.to_owned()));
    }
    let size = opened.len();
    let version = version::version_of(Some(&file), &opened)?;
    let head = head(&mut file)?;
    let detection = encoding::detect(&head, size > head.len() as u64);
    let oversized = range.max_size.is_some_and(|max| size > max);
    if !oversized && range.offset > size {
        return Err(conflict(path, Some(version)));
    }
    let bytes = if oversized {
        Vec::new()
    } else {
        slice(&mut file, size, range)?
    };
    if version::version_of(Some(&file), &file.metadata()?)? != version {
        return Err(conflict(path, Some(version)));
    }
    let current = current_version(root, path)?;
    if current.as_deref() != Some(version.as_str()) {
        return Err(conflict(path, current));
    }
    let eof = !oversized && range.offset.saturating_add(bytes.len() as u64) >= size;
    Ok(Read {
        size,
        version,
        bytes,
        binary: detection.binary,
        encoding: detection.encoding,
        bom: detection.bom,
        eof,
    })
}

/// Opens a file in a folder without following a link at its name.
///
/// The name comes from a walk that already resolved any final link inside the root, so a link
/// here is one that appeared afterwards and is refused rather than followed.
pub(crate) fn open_nofollow(dir: &Dir, name: &str) -> Result<File, Error> {
    use cap_fs_ext::{FollowSymlinks, OpenOptionsFollowExt};

    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true).follow(FollowSymlinks::No);
    Ok(dir.open_with(name, &options)?)
}

/// The version the path names now, or `None` when the path no longer names a file.
pub(crate) fn current_version(root: &Root, path: &str) -> Result<Option<String>, Error> {
    let parent = match crate::handle::target_parent_stored(root, path) {
        Ok(found) => found,
        Err(error) if error.code() == "NOT_FOUND" => return Ok(None),
        Err(error) => return Err(error),
    };
    crate::policy::refuse_components(&parent.folders, &parent.name, path)?;
    match parent.dir.symlink_metadata(&parent.name) {
        Ok(metadata) if metadata.is_file() => Ok(Some(version::version_of_entry(
            &parent.dir,
            &parent.name,
            &metadata,
        )?)),
        Ok(_) => Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn conflict(path: &str, current: Option<String>) -> Error {
    Error::Conflict {
        path: path.to_owned(),
        current,
    }
}

/// The first 8 KiB, which decide encoding and binary-ness for every range of the file.
fn head(file: &mut File) -> Result<Vec<u8>, Error> {
    file.seek(SeekFrom::Start(0))?;
    let mut head = Vec::with_capacity(SAMPLE_BYTES as usize);
    file.by_ref().take(SAMPLE_BYTES).read_to_end(&mut head)?;
    Ok(head)
}

fn slice(file: &mut File, size: u64, range: ReadRange) -> Result<Vec<u8>, Error> {
    if range.offset >= size || range.length == 0 {
        return Ok(Vec::new());
    }
    file.seek(SeekFrom::Start(range.offset))?;
    let wanted = range.length.min(size - range.offset);
    let mut bytes = Vec::with_capacity(wanted.min(SAMPLE_BYTES) as usize);
    file.by_ref().take(wanted).read_to_end(&mut bytes)?;
    Ok(bytes)
}
