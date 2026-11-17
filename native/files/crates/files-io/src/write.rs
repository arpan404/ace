// SPDX-License-Identifier: Apache-2.0

//! Writes: a temp file beside the target, fsynced, then renamed over it, so a crash leaves either
//! the old bytes or the new ones and never a half-written file.

use std::fs::Metadata;
use std::io::ErrorKind;
use std::io::Write as _;
use std::path::Path;

use files_safe::Root;

use crate::Error;
use crate::version::{entry_version, version_of};

/// Replaces a file's contents, refusing when the version the caller worked from is no longer
/// current.
///
/// `expected` is a version from `stat_version` or an earlier `read`; `None` means the file must
/// not exist yet. Returns the version the saved file now has.
///
/// The save writes a complete copy beside the file and renames it into place, carrying the
/// original's permission bits. Ownership, extended attributes, ACLs and other hard links to the
/// old file are not carried over, which is also what the daemon's temp-and-rename save does. A
/// file that did not exist yet keeps the private mode of the staging file.
pub fn write(
    root: &Root,
    path: &str,
    bytes: &[u8],
    expected: Option<&str>,
) -> Result<String, Error> {
    let absolute = root.resolve(path)?;
    let original = guard(root, &absolute, path, expected)?;
    let temp = staged(&absolute, bytes, original.as_ref())?;
    // The temp copy is complete and synced; check once more so a save that lost a race with
    // another writer never lands on top of it.
    let _ = guard(root, &absolute, path, expected)?;
    publish(temp, &absolute, original.as_ref())?;
    version_of(&absolute, &std::fs::metadata(&absolute)?)
}

/// Creates a file that must not exist yet and returns its version.
pub fn create_file(root: &Root, path: &str, bytes: &[u8]) -> Result<String, Error> {
    write(root, path, bytes, None)
}

/// The metadata of the file the caller expects, or `CONFLICT` when the disk has moved on.
fn guard(
    root: &Root,
    absolute: &Path,
    path: &str,
    expected: Option<&str>,
) -> Result<Option<Metadata>, Error> {
    let found = match std::fs::symlink_metadata(absolute) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    match (expected, found) {
        (Some(expected), Some(metadata)) => {
            let current = entry_version(root, path, absolute, &metadata)?;
            if current != expected {
                return Err(Error::Conflict {
                    path: path.to_owned(),
                    current: Some(current),
                });
            }
            if metadata.is_dir() {
                return Err(Error::NotFile(path.to_owned()));
            }
            Ok(Some(metadata))
        }
        (Some(_), None) => Err(Error::Conflict {
            path: path.to_owned(),
            current: None,
        }),
        (None, Some(metadata)) => Err(Error::Conflict {
            path: path.to_owned(),
            current: Some(entry_version(root, path, absolute, &metadata)?),
        }),
        (None, None) => Ok(None),
    }
}

/// A complete copy of the new contents in the target's folder, carrying the original's mode.
fn staged(
    absolute: &Path,
    bytes: &[u8],
    original: Option<&Metadata>,
) -> Result<tempfile::NamedTempFile, Error> {
    let parent = absolute
        .parent()
        .ok_or_else(|| Error::InvalidArgument(absolute.display().to_string()))?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.as_file_mut().write_all(bytes)?;
    if let Some(metadata) = original {
        temp.as_file()
            .set_permissions(copied_permissions(metadata))?;
    }
    temp.as_file().sync_all()?;
    Ok(temp)
}

/// The original's permission bits. The setuid, setgid and sticky bits are deliberately dropped:
/// a save must never hand a file more privilege than the caller asked for.
#[cfg(unix)]
fn copied_permissions(metadata: &Metadata) -> std::fs::Permissions {
    use std::os::unix::fs::PermissionsExt;
    std::fs::Permissions::from_mode(metadata.permissions().mode() & 0o777)
}

#[cfg(windows)]
fn copied_permissions(metadata: &Metadata) -> std::fs::Permissions {
    metadata.permissions()
}

/// Renames the complete copy into place, then syncs the folder so the entry itself is durable
/// and not only the bytes it points at.
#[cfg(unix)]
fn publish(
    temp: tempfile::NamedTempFile,
    absolute: &Path,
    _original: Option<&Metadata>,
) -> Result<(), Error> {
    temp.persist(absolute)
        .map_err(|error| Error::Io(error.error))?;
    if let Some(parent) = absolute.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

/// Windows refuses to replace a read-only file, so the attribute comes off first. The incoming
/// copy already carries it, and a failed rename puts it back on the file that stayed.
#[cfg(windows)]
fn publish(
    temp: tempfile::NamedTempFile,
    absolute: &Path,
    original: Option<&Metadata>,
) -> Result<(), Error> {
    let readonly = original.is_some_and(|metadata| metadata.permissions().readonly());
    if readonly {
        set_readonly(absolute, false)?;
    }
    match temp.persist(absolute) {
        Ok(_) => Ok(()),
        Err(error) => {
            if readonly {
                let _ = set_readonly(absolute, true);
            }
            Err(Error::Io(error.error))
        }
    }
}

#[cfg(windows)]
fn set_readonly(path: &Path, readonly: bool) -> Result<(), Error> {
    let mut permissions = std::fs::metadata(path)?.permissions();
    permissions.set_readonly(readonly);
    std::fs::set_permissions(path, permissions)?;
    Ok(())
}
