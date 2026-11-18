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

/// Windows renames without replacing through `MoveFileExW` with no flags: the call either moves
/// the entry or leaves the destination alone, in one step. Files and folders alike.
#[cfg(not(unix))]
pub(crate) fn rename_noclobber(
    from_dir: &Dir,
    from: &str,
    to_dir: &Dir,
    to: &str,
) -> Result<Noclobber, Error> {
    windows::move_without_replace(from_dir, from, to_dir, to)
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

/// Makes the folder's own entries durable, so a rename that returned is not lost in a crash.
#[cfg(unix)]
pub(crate) fn sync(dir: &Dir) -> Result<(), Error> {
    // cap-std holds a folder as an `O_PATH` descriptor on Linux, which `fsync` rejects with
    // `EBADF`; reopening it for reading gives a descriptor that can be synced everywhere.
    dir.open(".")?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
pub(crate) fn sync(_dir: &Dir) -> Result<(), Error> {
    Ok(())
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

/// The folder holding `path` and the stored names on the way, with a final link followed.
///
/// Reads use this: the folder chain and the leaf are the names the disk reports, so a policy
/// applied to them covers a link that leads into a protected folder as surely as the spelling
/// that names it directly.
pub(crate) fn target_parent_stored(root: &Root, path: &str) -> Result<files_safe::Parent, Error> {
    let first = root.open_parent_stored(path)?;
    let linked = match first.dir.symlink_metadata(&first.name) {
        Ok(metadata) => metadata.file_type().is_symlink(),
        Err(error) if error.kind() == ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    if !linked {
        return Ok(first);
    }
    let resolved = root.resolve(path)?;
    let inside = root
        .relative(&resolved)
        .ok_or_else(|| files_safe::Error::PathEscape(path.to_owned()))?;
    Ok(root.open_parent_stored(&inside)?)
}

/// A folder handle seen as a file, which is what the Windows version reader needs.
#[cfg(windows)]
pub(crate) fn dir_handle(dir: &Dir) -> Result<File, Error> {
    Ok(File::from_std(dir.try_clone()?.into_std_file()))
}

/// The one place this crate names a path on Windows: `MoveFileExW` takes a path, and a handle's
/// own final path is the only spelling that cannot be redirected between the walk and the call.
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows {
    use std::path::{Path, PathBuf};

    use cap_std::fs::Dir;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    use super::{Error, Noclobber};

    /// Windows reports a taken name as already existing; a cross-volume move is not one this
    /// checkout can make without copying, so it is unsupported rather than a replace.
    const ALREADY_EXISTS: u32 = 183;
    const FILE_EXISTS: u32 = 80;
    const NOT_SAME_DEVICE: u32 = 17;

    pub(super) fn move_without_replace(
        from_dir: &Dir,
        from: &str,
        to_dir: &Dir,
        to: &str,
    ) -> Result<Noclobber, Error> {
        let source = join(&folder_path(from_dir)?, from);
        let destination = join(&folder_path(to_dir)?, to);
        let source = wide(&source);
        let destination = wide(&destination);
        // SAFETY: both arguments are NUL-terminated UTF-16 buffers that outlive the call, and no
        // pointer is kept. Flags 0 never replace an existing destination and never copy across
        // volumes, so a taken name is refused rather than overwritten.
        let moved = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) };
        if moved != 0 {
            return Ok(Noclobber::Done);
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error().map(|code| code as u32) {
            Some(ALREADY_EXISTS | FILE_EXISTS) => Ok(Noclobber::Exists),
            Some(NOT_SAME_DEVICE) => Ok(Noclobber::Unsupported),
            _ => Err(Error::Io(error)),
        }
    }

    /// The final path of an open folder, which is the spelling its entries live under.
    fn folder_path(dir: &Dir) -> Result<PathBuf, Error> {
        let file = dir.try_clone()?.into_std_file();
        Ok(winx::file::get_file_path(&file)?)
    }

    fn join(folder: &Path, name: &str) -> PathBuf {
        folder.join(name)
    }

    /// A path in the `\\?\` form, so the call reaches past MAX_PATH.
    fn wide(path: &Path) -> Vec<u16> {
        use std::os::windows::ffi::OsStrExt;

        let text = path.as_os_str().encode_wide().collect::<Vec<u16>>();
        let prefixed = text.starts_with(&[
            u16::from(b'\\'),
            u16::from(b'\\'),
            u16::from(b'?'),
            u16::from(b'\\'),
        ]);
        let mut wide = if prefixed {
            Vec::new()
        } else if text.starts_with(&[u16::from(b'\\'), u16::from(b'\\')]) {
            "\\\\?\\UNC\\"
                .encode_utf16()
                .chain(text.into_iter().skip(2))
                .collect()
        } else {
            "\\\\?\\".encode_utf16().chain(text).collect()
        };
        wide.push(0);
        wide
    }
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
