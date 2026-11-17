// SPDX-License-Identifier: Apache-2.0

//! Folder versions: `tree:` plus a digest of every entry below a folder, computed exactly as the
//! daemon's `observed` does, so a folder version from either side is accepted by the other.
//!
//! The digest covers the folder's own version and then, in each folder, every entry in
//! JavaScript string order as `path`, NUL, version, NUL. Entries are reported by their lexical
//! path under the folder being versioned, links take their target's version, links that leave
//! the root are skipped, and a link is never walked through even when it names a folder. Upload
//! temporaries are left out. Names that are not UTF-8 cannot be reported and are skipped, as the
//! daemon's decoder skips them.

use std::io::ErrorKind;

use cap_fs_ext::DirExt;
use cap_std::fs::{Dir, File};
use files_safe::Root;
use sha2::{Digest, Sha256};

use crate::Error;
use crate::version;

/// The daemon fails a folder listing past this many names.
const NAMES_PER_FOLDER: usize = 10_000;
/// The daemon fails a tree past this many entries.
const ENTRIES_PER_TREE: usize = 1_000_000;

/// The version of a folder: the daemon's `tree:` digest.
pub(crate) fn version(root: &Root, relative: &str, dir: &Dir) -> Result<String, Error> {
    let mut digest = Sha256::new();
    digest.update(version::version_of(
        own_handle(dir)?.as_ref(),
        &dir.dir_metadata()?,
    )?);
    let mut stack = Vec::new();
    if !temporary(relative) {
        stack.push(Folder {
            path: relative.to_owned(),
            dir: dir.try_clone()?,
            names: names(dir)?,
            next: 0,
        });
    }
    let mut visited = 0usize;
    while let Some(index) = stack.len().checked_sub(1) {
        let Some(name) = stack[index].names.get(stack[index].next).cloned() else {
            stack.pop();
            continue;
        };
        stack[index].next += 1;
        let base = stack[index].path.clone();
        let path = if base.is_empty() {
            name.clone()
        } else {
            format!("{base}/{name}")
        };
        if name.contains('\\') || temporary(&path) {
            continue;
        }
        visited += 1;
        if visited > ENTRIES_PER_TREE {
            return Err(Error::LimitExceeded(format!(
                "{relative} has more than {ENTRIES_PER_TREE} entries"
            )));
        }
        let examined = examine(root, &stack[index].dir, &path, &name)?;
        let Some((entry_version, child)) = examined else {
            continue;
        };
        digest.update(path.as_bytes());
        digest.update([0]);
        digest.update(entry_version.as_bytes());
        digest.update([0]);
        if let Some(child) = child {
            stack.push(Folder {
                path,
                names: names(&child)?,
                dir: child,
                next: 0,
            });
        }
    }
    Ok(format!("tree:{:x}", digest.finalize()))
}

/// One folder waiting to be reported: the path its entries answer to, and their sorted names.
struct Folder {
    path: String,
    dir: Dir,
    names: Vec<String>,
    next: usize,
}

/// What one entry contributes: its version and, when it is a real folder, the handle to walk.
///
/// `None` means the daemon would skip the entry: it vanished, its link leaves the root, or a
/// name it needs cannot be read.
fn examine(
    root: &Root,
    dir: &Dir,
    path: &str,
    name: &str,
) -> Result<Option<(String, Option<Dir>)>, Error> {
    let link = match dir.symlink_metadata(name) {
        Ok(metadata) => metadata,
        Err(error) if skipped(&error) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let is_link = link.file_type().is_symlink();
    let metadata = if is_link {
        // The daemon resolves a link through the confinement walk before taking its target's
        // version; an escaping or dangling one is left out of the digest.
        if let Err(error) = root.resolve(path) {
            let error = Error::Path(error);
            if transient(&error) {
                return Ok(None);
            }
            return Err(error);
        }
        match dir.metadata(name) {
            Ok(metadata) => metadata,
            Err(error) if skipped(&error) || error.kind() == ErrorKind::PermissionDenied => {
                return Ok(None);
            }
            Err(error) => return Err(error.into()),
        }
    } else {
        link
    };
    let entry_version = version::version_of_entry(dir, name, &metadata)?;
    let child = if !is_link && metadata.is_dir() {
        match dir.open_dir_nofollow(name) {
            Ok(child) => Some(child),
            Err(error) if skipped(&error) => None,
            Err(error) => return Err(error.into()),
        }
    } else {
        None
    };
    Ok(Some((entry_version, child)))
}

/// The names in one folder, in the order JavaScript sorts strings: by UTF-16 code unit.
fn names(dir: &Dir) -> Result<Vec<String>, Error> {
    let mut names = Vec::new();
    for entry in dir.entries()? {
        let entry = entry?;
        if let Ok(name) = entry.file_name().into_string() {
            names.push(name);
        }
        if names.len() > NAMES_PER_FOLDER {
            return Err(Error::LimitExceeded(
                "a folder has more than 10,000 entries".to_owned(),
            ));
        }
    }
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(names)
}

/// A folder handle for the Windows version reader; Unix reads the metadata alone.
#[cfg(unix)]
fn own_handle(_dir: &Dir) -> Result<Option<File>, Error> {
    Ok(None)
}

#[cfg(windows)]
fn own_handle(dir: &Dir) -> Result<Option<File>, Error> {
    Ok(Some(crate::handle::dir_handle(dir)?))
}

/// An entry that is not there any more is skipped, as the daemon skips it.
fn skipped(error: &std::io::Error) -> bool {
    matches!(error.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory)
}

/// Failures the daemon skips while walking: an entry that vanished or that leaves the root.
fn transient(error: &Error) -> bool {
    matches!(
        error.code(),
        "NOT_FOUND" | "PATH_ESCAPE" | "PATH_CHANGED" | "NOT_DIRECTORY"
    )
}

/// Upload temporaries are private and never part of a tree version.
fn temporary(path: &str) -> bool {
    let parts = path.split('/');
    if cfg!(windows) {
        parts
            .into_iter()
            .any(|part| part.to_lowercase().starts_with(".ace-upload-"))
    } else {
        parts
            .into_iter()
            .any(|part| part.starts_with(".ace-upload-"))
    }
}
