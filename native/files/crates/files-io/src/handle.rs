// SPDX-License-Identifier: Apache-2.0

//! Handle-level primitives: staging a complete copy in a folder, publishing it atomically, and
//! the small folder operations the rest of the crate builds on.
//!
//! Every name here is relative to a `cap_std::fs::Dir` the caller already holds, so no path
//! string ever reaches the filesystem and nothing outside the walked folder can be reached.

use std::io::ErrorKind;
use std::io::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};

use cap_std::fs::{Dir, File, OpenOptions, Permissions};
use files_safe::Root;

use crate::Error;

/// The prefix the daemon gives a file that is still being written. Staging files use it too, so
/// a folder version and a listing leave them out while they exist.
const TEMPORARY: &str = ".ace-upload-";

/// What an atomic no-clobber publish found at the destination.
pub(crate) enum Noclobber {
    Done,
    Exists,
    /// The operating system or filesystem cannot rename without replacing.
    Unsupported,
}

/// A complete copy waiting to be published beside its target.
///
/// The copy has a name from the moment it exists, so it can be exchanged with the target in one
/// step; dropping it removes that name unless the copy was published or handed on.
pub(crate) struct Staged {
    dir: Dir,
    name: Option<String>,
    file: Option<File>,
}

impl Staged {
    /// Writes `bytes` into a new file in `dir` and syncs it, so a crash never leaves a partial
    /// copy under a name anyone reads.
    pub(crate) fn new(
        dir: &Dir,
        bytes: &[u8],
        permissions: Option<Permissions>,
    ) -> Result<Staged, Error> {
        let (name, mut file) = create_unique(dir)?;
        file.write_all(bytes)?;
        if let Some(permissions) = permissions {
            file.set_permissions(permissions)?;
        }
        file.sync_all()?;
        Ok(Staged {
            dir: dir.try_clone()?,
            name: Some(name),
            file: Some(file),
        })
    }

    pub(crate) fn name(&self) -> &str {
        self.name.as_deref().unwrap_or_default()
    }

    /// Closes the writing handle: a Windows rename cannot replace a file that is still open, and
    /// nothing below reads through it again.
    pub(crate) fn close(&mut self) {
        self.file = None;
    }

    /// Gives up the staging name, which now holds something the caller owns.
    pub(crate) fn release(&mut self) -> String {
        self.name.take().unwrap_or_default()
    }
}

impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(name) = self.name.take() {
            let _ = self.dir.remove_file(name);
        }
    }
}

/// A suffix no other staging file of this process uses, even across a reused name.
pub(crate) fn unique_suffix() -> String {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let sequence = SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("{}-{sequence}", std::process::id())
}

fn create_unique(dir: &Dir) -> Result<(String, File), Error> {
    for _ in 0..32 {
        let name = format!("{TEMPORARY}{}", unique_suffix());
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match dir.open_with(&name, &options) {
            Ok(file) => return Ok((name, file)),
            Err(error) if error.kind() == ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(Error::Io(std::io::Error::new(
        ErrorKind::AlreadyExists,
        "no free name for a staging file",
    )))
}

/// Renames `from` to `to` in `dir` only while `to` does not exist.
#[cfg(unix)]
pub(crate) fn rename_noclobber(
    from_dir: &Dir,
    from: &str,
    to_dir: &Dir,
    to: &str,
) -> Result<Noclobber, Error> {
    use rustix::fs::{RenameFlags, renameat_with};

    match renameat_with(from_dir, from, to_dir, to, RenameFlags::NOREPLACE) {
        Ok(()) => Ok(Noclobber::Done),
        Err(error) if error == rustix::io::Errno::EXIST => Ok(Noclobber::Exists),
        Err(error) if unsupported(error) => Ok(Noclobber::Unsupported),
        Err(error) => Err(io_error(error)),
    }
}

/// Windows has no rename-without-replace: a hard link is the atomic no-clobber step for a file,
/// and Windows itself refuses to replace a folder.
#[cfg(not(unix))]
pub(crate) fn rename_noclobber(
    from_dir: &Dir,
    from: &str,
    to_dir: &Dir,
    to: &str,
) -> Result<Noclobber, Error> {
    if from_dir.symlink_metadata(from)?.is_file() {
        return match from_dir.hard_link(from, to_dir, to) {
            Ok(()) => {
                from_dir.remove_file(from)?;
                Ok(Noclobber::Done)
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => Ok(Noclobber::Exists),
            Err(error) => Err(error.into()),
        };
    }
    // Windows refuses to replace an existing folder, so a checked rename is the caller's job.
    Ok(Noclobber::Unsupported)
}

/// Swaps two names in `dir` in one step, so neither ever stops existing. Returns false where the
/// operating system or filesystem has no atomic exchange.
#[cfg(unix)]
pub(crate) fn exchange(dir: &Dir, first: &str, second: &str) -> Result<bool, Error> {
    use rustix::fs::{RenameFlags, renameat_with};

    match renameat_with(dir, first, dir, second, RenameFlags::EXCHANGE) {
        Ok(()) => Ok(true),
        Err(error) if unsupported(error) => Ok(false),
        Err(error) => Err(io_error(error)),
    }
}

/// A syscall failure in the crate's own error shape.
#[cfg(unix)]
fn io_error(error: rustix::io::Errno) -> Error {
    Error::Io(std::io::Error::from_raw_os_error(error.raw_os_error()))
}

#[cfg(unix)]
fn unsupported(error: rustix::io::Errno) -> bool {
    matches!(
        error,
        rustix::io::Errno::NOSYS | rustix::io::Errno::OPNOTSUPP | rustix::io::Errno::INVAL
    )
}

/// Renames over the destination, replacing whatever is at `to`.
pub(crate) fn replace(dir: &Dir, from: &str, to: &str) -> Result<(), Error> {
    dir.rename(from, dir, to)?;
    Ok(())
}

/// A folder descriptor that can be synced once a change to its entries is published.
///
/// The descriptor is opened before the change: opening it needs read permission the folder may
/// not have, and a save must not discover that after it has already replaced the file.
pub(crate) struct Syncable {
    #[cfg(unix)]
    file: cap_std::fs::File,
}

/// Opens the folder in a form that `fsync` accepts, before the change that must be durable.
#[cfg(unix)]
pub(crate) fn syncable(dir: &Dir) -> Result<Syncable, Error> {
    // cap-std holds a folder as an `O_PATH` descriptor on Linux, which `fsync` rejects with
    // `EBADF`; reopening it for reading gives a descriptor that can be synced everywhere.
    Ok(Syncable {
        file: dir.open(".")?,
    })
}

#[cfg(not(unix))]
pub(crate) fn syncable(_dir: &Dir) -> Result<Syncable, Error> {
    Ok(Syncable {})
}

impl Syncable {
    /// Makes the folder's own entries durable, so a rename that returned is not lost in a crash.
    pub(crate) fn sync(self) -> Result<(), Error> {
        #[cfg(unix)]
        self.file.sync_all()?;
        Ok(())
    }
}

/// Makes the folder's own entries durable after a change that is already published.
pub(crate) fn sync(dir: &Dir) -> Result<(), Error> {
    syncable(dir)?.sync()
}

/// The folder holding `path` and the stored name of the entry itself, with a final symlink
/// followed so the caller works on what the link points at.
///
/// `files-safe` proves the link stays inside the root; an escaping one is `PATH_ESCAPE`. A
/// dangling link is returned as its own name, so reading it reports `NOT_FOUND` and writing it
/// replaces the link, exactly as the daemon does.
pub(crate) fn target_parent(root: &Root, path: &str) -> Result<(Dir, String), Error> {
    let (dir, name) = root.open_parent(path)?;
    let linked = match dir.symlink_metadata(&name) {
        Ok(metadata) => metadata.file_type().is_symlink(),
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if !linked {
        return Ok((dir, name));
    }
    let resolved = root.resolve(path)?;
    let inside = root
        .relative(&resolved)
        .ok_or_else(|| files_safe::Error::PathEscape(path.to_owned()))?;
    Ok(root.open_parent(&inside)?)
}

/// A folder handle seen as a file, which is what the Windows version reader needs.
#[cfg(windows)]
pub(crate) fn dir_handle(dir: &Dir) -> Result<File, Error> {
    Ok(File::from_std(dir.try_clone()?.into_std_file()))
}

/// A handle that carries an entry's identity without asking for read or write access, so even a
/// file the caller may not read can be versioned.
#[cfg(windows)]
pub(crate) fn attribute_handle(dir: &Dir, name: &str) -> Result<File, Error> {
    use cap_std::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.read(false).write(false).access_mode(0);
    Ok(dir.open_with(name, &options)?)
}
