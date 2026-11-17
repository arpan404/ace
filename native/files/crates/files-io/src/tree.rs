// SPDX-License-Identifier: Apache-2.0

//! Folder versions: `tree:` plus a digest of every entry below a folder, computed exactly as the
//! daemon's `observed` does, so a folder version from either side is accepted by the other.
//!
//! The digest covers the folder's own version and then, in each folder, every entry in
//! JavaScript string order as `path`, NUL, version, NUL. Entries are reported by their lexical
//! path under the folder being versioned, symlinks are followed (an entry takes its target's
//! version, and a link to a folder is walked through), links that leave the root are skipped,
//! and upload temporaries are left out. Names that are not UTF-8 cannot be reported and are
//! skipped, as the daemon's decoder skips them.

use std::fs::Metadata;
use std::path::Path;

use files_safe::Root;
use sha2::{Digest, Sha256};

use crate::Error;
use crate::version::version_of;

/// The daemon fails a folder listing past this many names.
const NAMES_PER_FOLDER: usize = 10_000;
/// The daemon fails a tree past this many entries.
const ENTRIES_PER_TREE: usize = 1_000_000;

/// The version of a folder: the daemon's `tree:` digest.
pub(crate) fn version(
    root: &Root,
    relative: &str,
    absolute: &Path,
    metadata: &Metadata,
) -> Result<String, Error> {
    let mut digest = Sha256::new();
    digest.update(version_of(absolute, metadata)?);
    let mut stack = Vec::new();
    if let Some(first) = folder(root, relative.to_owned(), absolute)? {
        stack.push(first);
    }
    let mut visited = 0usize;
    while let Some(current) = stack.last_mut() {
        let Some(name) = current.names.get(current.next).cloned() else {
            stack.pop();
            continue;
        };
        current.next += 1;
        let path = if current.path.is_empty() {
            name
        } else {
            format!("{}/{}", current.path, name)
        };
        if path.contains('\\') || temporary(&path) {
            continue;
        }
        visited += 1;
        if visited > ENTRIES_PER_TREE {
            return Err(Error::LimitExceeded(format!(
                "{relative} has more than {ENTRIES_PER_TREE} entries"
            )));
        }
        let (resolved, entry_metadata, link) = match entry(root, &path) {
            Ok(found) => found,
            Err(error) if transient(&error) => continue,
            Err(error) => return Err(error),
        };
        digest.update(path.as_bytes());
        digest.update([0]);
        digest.update(version_of(&resolved, &entry_metadata)?.as_bytes());
        digest.update([0]);
        // A link to a folder reports the folder's version but is never walked through, so a
        // link cycle cannot repeat a subtree.
        if !link
            && entry_metadata.is_dir()
            && let Some(child) = folder(root, path, &resolved)?
        {
            stack.push(child);
        }
    }
    Ok(format!("tree:{:x}", digest.finalize()))
}

/// One folder waiting to be reported: the path its entries answer to, and their sorted names.
struct Folder {
    path: String,
    names: Vec<String>,
    next: usize,
}

fn folder(root: &Root, path: String, absolute: &Path) -> Result<Option<Folder>, Error> {
    if root
        .relative(absolute)
        .is_some_and(|actual| temporary(&actual))
    {
        return Ok(None);
    }
    Ok(Some(Folder {
        path,
        names: names(absolute)?,
        next: 0,
    }))
}

/// The names in one folder, in the order JavaScript sorts strings: by UTF-16 code unit.
fn names(absolute: &Path) -> Result<Vec<String>, Error> {
    let mut names = Vec::new();
    for entry in std::fs::read_dir(absolute)? {
        let entry = entry?;
        if let Some(name) = entry.file_name().to_str() {
            names.push(name.to_owned());
        }
        if names.len() > NAMES_PER_FOLDER {
            return Err(Error::LimitExceeded(absolute.display().to_string()));
        }
    }
    names.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    Ok(names)
}

/// The entry at `path` with its links followed, which is what the daemon reports a version of,
/// and whether the path itself is a link.
fn entry(root: &Root, path: &str) -> Result<(std::path::PathBuf, Metadata, bool), Error> {
    let link = std::fs::symlink_metadata(root.path().join(path))?
        .file_type()
        .is_symlink();
    let absolute = root.resolve(path)?;
    let metadata = std::fs::metadata(&absolute)?;
    Ok((absolute, metadata, link))
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
