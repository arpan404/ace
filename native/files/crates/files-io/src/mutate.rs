// SPDX-License-Identifier: Apache-2.0

//! Mutations a file explorer needs: create, rename and remove inside the root.
//!
//! Every mutation is made through the handle of the folder that holds the entry, by name. The
//! leaf is never followed: removing a link removes the link, not the file it points at, and
//! renaming a link renames the link.

use std::io::ErrorKind;

use files_safe::Root;

use crate::Error;
use crate::describe::Walks;
use crate::handle::{self, Noclobber};
use crate::version;

/// Creates a folder. The parent must exist, and nothing may be there already.
pub fn create_dir(root: &Root, path: &str) -> Result<(), Error> {
    refuse_root(path)?;
    let (dir, name) = root.open_parent(path)?;
    match dir.create_dir(&name) {
        Ok(()) => {
            handle::sync(&dir)?;
            Ok(())
        }
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
    refuse_root(from)?;
    refuse_root(to)?;
    if to == from
        || to
            .strip_prefix(from)
            .is_some_and(|rest| rest.starts_with('/'))
    {
        return Err(Error::InvalidArgument(format!("{to} is inside {from}")));
    }
    let (from_dir, from_name) = root.open_parent(from)?;
    let (to_dir, _) = root.open_parent(to)?;
    // The name to move to is the caller's spelling, not the one on disk: on a volume that
    // ignores case the two differ only in case, and the caller wants the new spelling stored.
    let to_name = leaf_name(to);
    // The entry being moved has to exist; the destination must not, unless asked.
    from_dir.symlink_metadata(&from_name)?;
    if overwrite {
        from_dir.rename(&from_name, &to_dir, &to_name)?;
        handle::sync(&from_dir)?;
        handle::sync(&to_dir)?;
        return Ok(());
    }
    match handle::rename_noclobber(&from_dir, &from_name, &to_dir, &to_name)? {
        Noclobber::Done => {
            handle::sync(&from_dir)?;
            handle::sync(&to_dir)?;
            Ok(())
        }
        Noclobber::Exists => {
            if version::same_entry(&from_dir, &from_name, &to_dir, &to_name)? {
                // One entry under two spellings on a case-insensitive volume: rename it so the
                // spelling on disk changes.
                from_dir.rename(&from_name, &to_dir, &to_name)?;
                handle::sync(&from_dir)?;
                return Ok(());
            }
            Err(Error::Conflict {
                path: to.to_owned(),
                current: version_of(root, &to_dir, &to_name, to)?,
            })
        }
        Noclobber::Unsupported => {
            // Without an atomic no-replace rename the check and the move cannot be one step.
            match to_dir.symlink_metadata(&to_name) {
                Ok(_) => Err(Error::Conflict {
                    path: to.to_owned(),
                    current: version_of(root, &to_dir, &to_name, to)?,
                }),
                Err(error) if error.kind() == ErrorKind::NotFound => {
                    from_dir.rename(&from_name, &to_dir, &to_name)?;
                    handle::sync(&from_dir)?;
                    handle::sync(&to_dir)?;
                    Ok(())
                }
                Err(error) => Err(error.into()),
            }
        }
    }
}

/// The version a conflict reports for the destination, without walking a folder for a digest.
fn version_of(
    root: &Root,
    dir: &cap_std::fs::Dir,
    name: &str,
    path: &str,
) -> Result<Option<String>, Error> {
    Ok(
        crate::version::entry_version(root, dir, name, path, &Walks::unbounded())?
            .map(|found| found.version),
    )
}

/// The root itself is never created, renamed or removed.
fn refuse_root(path: &str) -> Result<(), Error> {
    if path.is_empty() {
        Err(Error::InvalidArgument(path.to_owned()))
    } else {
        Ok(())
    }
}

/// The last segment of a checked relative path.
fn leaf_name(path: &str) -> String {
    path.rsplit_once('/')
        .map_or_else(|| path.to_owned(), |(_, name)| name.to_owned())
}

/// Deletes a file, a symlink, or a folder with everything inside it.
pub fn remove(root: &Root, path: &str) -> Result<(), Error> {
    refuse_root(path)?;
    let (dir, name) = root.open_parent(path)?;
    let metadata = dir.symlink_metadata(&name)?;
    if metadata.is_dir() {
        dir.remove_dir_all(&name)?;
    } else {
        dir.remove_file(&name)?;
    }
    handle::sync(&dir)?;
    Ok(())
}
