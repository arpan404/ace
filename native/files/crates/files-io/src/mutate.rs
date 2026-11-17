// SPDX-License-Identifier: Apache-2.0

//! Mutations a file explorer needs: create, rename and remove inside the root.
//!
//! Delete and rename act on the last path segment itself, never through a symlink there: removing
//! a link removes the link, not the file it points at. Reads and writes do follow the link, and
//! `files-safe` refuses one that leaves the root.

use std::io::ErrorKind;
use std::path::PathBuf;

use files_safe::Root;

use crate::Error;
use crate::version::{entry_version, same_entry};

/// Creates a folder. The parent must exist, and nothing may be there already.
pub fn create_dir(root: &Root, path: &str) -> Result<(), Error> {
    let absolute = root.resolve(path)?;
    match std::fs::create_dir(&absolute) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => Err(Error::Conflict {
            path: path.to_owned(),
            current: crate::stat_version(root, path)?,
        }),
        Err(error) => Err(error.into()),
    }
}

/// Moves an entry. A taken destination is `CONFLICT` unless `overwrite` is set.
///
/// On a volume that ignores case, `Notes.md` to `notes.md` finds the destination already there;
/// it names the same entry, so the rename is allowed and only the spelling changes. Moving
/// something into itself or into its own subfolder is `INVALID_ARGUMENT`.
pub fn rename(root: &Root, from: &str, to: &str, overwrite: bool) -> Result<(), Error> {
    let source = leaf(root, from)?;
    let destination = leaf(root, to)?;
    if destination.starts_with(&source) {
        return Err(Error::InvalidArgument(format!("{to} is inside {from}")));
    }
    let source_metadata = std::fs::symlink_metadata(&source)?;
    if !overwrite {
        match std::fs::symlink_metadata(&destination) {
            Ok(metadata) => {
                if !same_entry(&source, &source_metadata, &destination, &metadata)? {
                    return Err(Error::Conflict {
                        path: to.to_owned(),
                        current: Some(entry_version(root, to, &destination, &metadata)?),
                    });
                }
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    std::fs::rename(&source, &destination)?;
    Ok(())
}

/// Deletes a file, a symlink, or a folder with everything inside it.
pub fn remove(root: &Root, path: &str) -> Result<(), Error> {
    let absolute = leaf(root, path)?;
    let metadata = std::fs::symlink_metadata(&absolute)?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&absolute)?;
    } else {
        std::fs::remove_file(&absolute)?;
    }
    Ok(())
}

/// The absolute path of `path` with its parent resolved and its last segment left alone.
///
/// The root itself is refused: it is never renamed or removed.
fn leaf(root: &Root, path: &str) -> Result<PathBuf, Error> {
    let checked = files_safe::Root::check(path)?;
    if checked.is_empty() {
        return Err(Error::InvalidArgument(path.to_owned()));
    }
    let (parent, name) = checked.rsplit_once('/').unwrap_or(("", checked));
    Ok(root.resolve(parent)?.join(name))
}
