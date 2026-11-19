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

    /// The version of the copy this save wrote, read through the handle it still holds.
    ///
    /// The handle follows the copy to the name it was published under, so the version is the one
    /// of the bytes this save wrote: a name another writer takes after the commit never lends its
    /// version to this save. Read after publication, because a rename changes the change time.
    pub(crate) fn published_version(&self) -> Result<String, Error> {
        let file = self.file.as_ref().ok_or_else(|| {
            Error::Io(std::io::Error::other(
                "the staging handle was closed before its version was read",
            ))
        })?;
        let metadata = file.metadata()?;
        crate::version::version_of(Some(file), &metadata)
    }

    /// Gives up the staging name, which now holds something the caller owns.
    pub(crate) fn release(&mut self) -> String {
        self.name.take().unwrap_or_default()
    }

    /// Removes the staging name after the copy was published, retrying once so a transient
    /// sharing violation does not leave the name behind.
    ///
    /// A name that still cannot be removed is left for a later cleanup; the caller reports it
    /// as a warning, because the file itself was already published.
    pub(crate) fn cleanup(&mut self) -> Option<crate::SaveWarning> {
        let name = self.name.take()?;
        match remove_staging(&self.dir, &name) {
            Ok(()) => None,
            Err(error) => Some(crate::SaveWarning::NotCleanedUp(format!("{name}: {error}"))),
        }
    }
}

/// Removes one staging name, treating one that is already gone as done and retrying a real
/// failure once.
fn remove_staging(dir: &Dir, name: &str) -> Result<(), std::io::Error> {
    match dir.remove_file(name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(first) => match dir.remove_file(name) {
            Ok(()) => Ok(()),
            Err(second) if second.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err(first),
        },
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

    if crate::hooks::reports_taken(from, to) {
        return Ok(Noclobber::Exists);
    }
    match renameat_with(from_dir, from, to_dir, to, RenameFlags::NOREPLACE) {
        Ok(()) => Ok(Noclobber::Done),
        Err(error) if error == rustix::io::Errno::EXIST => Ok(Noclobber::Exists),
        Err(error) if unsupported(error) => Ok(Noclobber::Unsupported),
        Err(error) => Err(io_error(error)),
    }
}

/// Windows renames without replacing through a handle to the entry itself: the destination folder
/// is given as a handle and the new name relative to it, so no path string can be redirected
/// between the walk and the call. The call either moves the entry or leaves the destination alone.
#[cfg(not(unix))]
pub(crate) fn rename_noclobber(
    from_dir: &Dir,
    from: &str,
    to_dir: &Dir,
    to: &str,
) -> Result<Noclobber, Error> {
    windows::move_without_replace(from_dir, from, to_dir, to)
}

/// A name a move parks an entry under while it travels between two names.
///
/// The prefix is the daemon's own, so a folder version and a listing leave the staging entry out
/// while it exists, and the client policy refuses it as a path. A move that cannot finish leaves
/// the entry here, where it is whole and can be put back by hand.
pub(crate) fn moving_name() -> String {
    format!("{TEMPORARY}move-{}", unique_suffix())
}

/// The name a version of an entry that could not be put back is preserved under, beside it.
///
/// `notes.md` keeps another version as `notes.conflict-<id>.md`. The name is one a person can see
/// and open, so a preserved copy is never invisible to the person whose bytes it holds. A name
/// near the platform's limit keeps its id suffix and as much of the stem as fits, so the recovery
/// name is always one the volume accepts.
pub(crate) fn recovery_name(name: &str) -> String {
    let suffix = format!(".conflict-{}", unique_suffix());
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && extension.len() <= MAX_EXTENSION => {
            (stem, Some(extension))
        }
        _ => (name, None),
    };
    let tail = match extension {
        Some(extension) => format!("{suffix}.{extension}"),
        None => suffix,
    };
    let room = MAX_NAME_LEN.saturating_sub(tail.len()).max(1);
    let stem = &stem[..floor_boundary(stem, room)];
    format!("{stem}{tail}")
}

/// The longest name a component can have, in bytes; a name is never cut in the middle of a
/// character.
const MAX_NAME_LEN: usize = 255;

/// The longest extension a recovery name keeps; a longer one is treated as part of the stem.
const MAX_EXTENSION: usize = 32;

/// The largest byte index at or below `limit` that does not split a character.
fn floor_boundary(text: &str, limit: usize) -> usize {
    if text.len() <= limit {
        return text.len();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    end
}

/// Swaps two names in `dir` in one step, so neither ever stops existing. Returns false where the
/// operating system or filesystem has no atomic exchange.
#[cfg(unix)]
pub(crate) fn exchange(dir: &Dir, first: &str, second: &str) -> Result<bool, Error> {
    use rustix::fs::{RenameFlags, renameat_with};

    if !crate::hooks::may_exchange(second) {
        return Ok(false);
    }
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

/// The one place this crate talks to Windows directly.
///
/// Every name here is relative to a folder the caller already holds and every move is made
/// through a handle to the entry itself (`NtSetInformationFile` with `FileRenameInformationEx` and
/// the destination folder as `RootDirectory`), so no path string ever reaches the filesystem: a
/// name rewritten between the walk and the call cannot redirect the move, and there is no verbatim
/// path to encode wrongly.
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows {
    use std::ffi::c_void;
    use std::mem::size_of;
    use std::os::windows::io::AsRawHandle;

    use cap_std::fs::OpenOptionsExt;
    use cap_std::fs::{Dir, File, OpenOptions};
    use windows_sys::Wdk::Storage::FileSystem::{FileRenameInformationEx, NtSetInformationFile};
    use windows_sys::Win32::Foundation::{HANDLE, NTSTATUS, RtlNtStatusToDosError};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_BASIC_INFO, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FileBasicInfo, FileDispositionInfo,
        GetFileInformationByHandleEx, SetFileInformationByHandle,
    };
    use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

    use super::{Error, Noclobber};

    /// Windows reports a taken name as already existing; a cross-volume move is not one this
    /// checkout can make without copying, so it is unsupported rather than a replace.
    const ALREADY_EXISTS: u32 = 183;
    const FILE_EXISTS: u32 = 80;
    const NOT_SAME_DEVICE: u32 = 17;
    const NOT_SUPPORTED: u32 = 50;
    const INVALID_PARAMETER: u32 = 87;
    /// Another program holds the entry in a way that excludes the access this call needs.
    const SHARING_VIOLATION: u32 = 32;

    /// `DELETE`, which a rename needs on the entry being moved.
    const DELETE: u32 = 0x0001_0000;
    /// Reading an entry's attributes and identity.
    const FILE_READ_ATTRIBUTES: u32 = 0x0000_0080;
    /// Clearing the read-only attribute, which a replace of such a file needs.
    const FILE_WRITE_ATTRIBUTES: u32 = 0x0000_0100;
    /// Files and folders that share a name with an incoming move of the same name.
    const SHARE_ALL: u32 = 0x0000_0007;
    /// Readers and deleters share the destination; a writer never does, so no write can land
    /// between the version check and the commit.
    const SHARE_READ_DELETE: u32 = 0x0000_0005;
    /// The attributes a read-only file carries, which a rename over it needs cleared.
    const READONLY: u32 = 0x0000_0001;

    /// Renames a handle's entry to a name in another folder, without replacing a name unless
    /// `replace` asks for it.
    ///
    /// An entry that is already open can be renamed by its handle, so the name the call moves is
    /// the entry the caller walked and not whatever a path spells by then. The destination folder
    /// arrives as a handle too, so only a leaf name is ever handed to the kernel.
    pub(super) fn rename(
        file: &File,
        to_dir: &Dir,
        to: &str,
        replace: bool,
    ) -> Result<Noclobber, Error> {
        let folder = to_dir.try_clone()?.into_std_file();
        let name: Vec<u16> = to.encode_utf16().collect();
        if name.is_empty() || name.len() >= MAX_NAME {
            return Err(Error::InvalidArgument(format!(
                "{to} is not a Windows name"
            )));
        }
        let mut information = RenameInfo {
            flags: if replace { REPLACE_IF_EXISTS } else { 0 },
            root: folder.as_raw_handle() as HANDLE,
            name_length: (name.len() * size_of::<u16>()) as u32,
            name: [0; MAX_NAME],
        };
        information.name[..name.len()].copy_from_slice(&name);
        let mut status = IO_STATUS_BLOCK::default();
        let length = size_of::<RenameInfo>() as u32;
        // SAFETY: the handle stays open for the call because `file` is borrowed for its duration,
        // the folder handle stays open because `folder` owns it until the call returns, and the
        // information buffer is a live, correctly aligned `RenameInfo` whose `name_length` counts
        // the UTF-16 units copied into it, so nothing outside the buffer is read.
        let result = unsafe {
            NtSetInformationFile(
                file.as_raw_handle() as HANDLE,
                &mut status,
                std::ptr::from_ref(&information).cast::<c_void>(),
                length,
                FileRenameInformationEx,
            )
        };
        if result >= 0 {
            return Ok(Noclobber::Done);
        }
        let error = nt_error(result);
        match error.raw_os_error().map(|code| code as u32) {
            Some(ALREADY_EXISTS | FILE_EXISTS) => Ok(Noclobber::Exists),
            Some(NOT_SAME_DEVICE | NOT_SUPPORTED | INVALID_PARAMETER) => Ok(Noclobber::Unsupported),
            Some(SHARING_VIOLATION) => Err(busy(to, error)),
            _ => Err(Error::Io(error)),
        }
    }

    pub(super) fn move_without_replace(
        from_dir: &Dir,
        from: &str,
        to_dir: &Dir,
        to: &str,
    ) -> Result<Noclobber, Error> {
        let source = open_for_delete(from_dir, from)?;
        rename(&source, to_dir, to, false)
    }

    /// Opens an entry with the access a rename needs and nothing else, so a file the caller may
    /// not read can still be moved. The entry itself is opened, never a link it names, and the
    /// handle may share delete and write with the staging handle the caller still holds.
    pub(super) fn open_for_delete(dir: &Dir, name: &str) -> Result<File, Error> {
        let mut options = OpenOptions::new();
        options
            .access_mode(DELETE | FILE_READ_ATTRIBUTES)
            .share_mode(SHARE_ALL)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
        dir.open_with(name, &options)
            .map_err(|error| match error.raw_os_error() {
                Some(code) if code as u32 == SHARING_VIOLATION => busy(name, error),
                _ => Error::Io(error),
            })
    }

    /// Opens the destination of a guarded publish: a handle to the entry itself, with a share mode
    /// that excludes writers for as long as it is held, so no write can land between the version
    /// check and the commit. The attribute access clears a read-only target through the very
    /// handle that was verified.
    pub(super) fn open_for_publish(dir: &Dir, name: &str) -> Result<File, Error> {
        let flags = FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT;
        let mut options = OpenOptions::new();
        options
            .access_mode(DELETE | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES)
            .share_mode(SHARE_READ_DELETE)
            .custom_flags(flags);
        match dir.open_with(name, &options) {
            Ok(file) => Ok(file),
            // An entry whose ACL allows deleting it but not rewriting its attributes is still
            // replaceable; the read-only clear then reports its own refusal.
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                let mut minimal = OpenOptions::new();
                minimal
                    .access_mode(DELETE | FILE_READ_ATTRIBUTES)
                    .share_mode(SHARE_READ_DELETE)
                    .custom_flags(flags);
                dir.open_with(name, &minimal)
                    .map_err(|error| open_error(name, error))
            }
            Err(error) => Err(open_error(name, error)),
        }
    }

    /// Marks the handle's entry for deletion, so the delete follows the entry and never a name.
    pub(super) fn delete_by_handle(file: &File) -> Result<(), Error> {
        let information = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: the handle stays open for the call because `file` is borrowed, and the
        // information buffer is a live, correctly aligned `FILE_DISPOSITION_INFO` of the size
        // passed, so the call reads only the buffer it was given.
        let written = unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as HANDLE,
                FileDispositionInfo,
                std::ptr::from_ref(&information).cast::<c_void>(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        if written == 0 {
            return Err(Error::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    /// A failed open as the crate's error shape, naming an entry another program is using.
    fn open_error(name: &str, error: std::io::Error) -> Error {
        match error.raw_os_error() {
            Some(code) if code as u32 == SHARING_VIOLATION => busy(name, error),
            _ => Error::Io(error),
        }
    }

    /// Another program holds the entry in a way that refuses this access.
    fn busy(name: &str, error: std::io::Error) -> Error {
        Error::Busy(format!(
            "another program has {name} open in a way that refuses this change: {error}"
        ))
    }

    /// Clears or sets the read-only attribute through an open handle, never through a name: the
    /// entry the caller guarded is the entry whose attributes change.
    pub(super) fn set_readonly(file: &File, readonly: bool) -> Result<(), Error> {
        let mut information = FILE_BASIC_INFO::default();
        // SAFETY: the handle stays open for the call because `file` is borrowed, and the
        // information buffer is a live, correctly aligned `FILE_BASIC_INFO` of the size passed.
        let read = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle() as HANDLE,
                FileBasicInfo,
                std::ptr::from_mut(&mut information).cast::<c_void>(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
        if read == 0 {
            return Err(Error::Io(std::io::Error::last_os_error()));
        }
        information.FileAttributes = if readonly {
            information.FileAttributes | READONLY
        } else {
            information.FileAttributes & !READONLY
        };
        // SAFETY: the same live handle and a live `FILE_BASIC_INFO` whose size is passed, so the
        // call reads only the buffer it was given.
        let written = unsafe {
            SetFileInformationByHandle(
                file.as_raw_handle() as HANDLE,
                FileBasicInfo,
                std::ptr::from_ref(&information).cast::<c_void>(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
        if written == 0 {
            return Err(Error::Io(std::io::Error::last_os_error()));
        }
        Ok(())
    }

    /// `FILE_RENAME_INFORMATION` for `FileRenameInformationEx`: the flag word, the folder the new
    /// name is relative to, and the name itself. The array holds the longest name a component can
    /// have, and the kernel reads only the `name_length` bytes.
    #[repr(C)]
    struct RenameInfo {
        flags: u32,
        root: HANDLE,
        name_length: u32,
        name: [u16; MAX_NAME],
    }

    /// The longest a single Windows name can be, in UTF-16 units.
    const MAX_NAME: usize = 256;

    /// `FILE_RENAME_FLAG_REPLACE_IF_EXISTS`.
    const REPLACE_IF_EXISTS: u32 = 1;

    /// An `NTSTATUS` failure as the Win32 error the rest of the crate matches on.
    fn nt_error(status: NTSTATUS) -> std::io::Error {
        // SAFETY: the call maps a status value to an error code and touches no memory.
        let code = unsafe { RtlNtStatusToDosError(status) };
        std::io::Error::from_raw_os_error(code as i32)
    }
}

/// Renames an open entry to a name in `to_dir` without replacing one.
#[cfg(windows)]
pub(crate) fn rename_handle_noclobber(
    file: &File,
    to_dir: &Dir,
    to: &str,
) -> Result<Noclobber, Error> {
    windows::rename(file, to_dir, to, false)
}

/// Opens an entry for a guarded save: the handle a rename moves aside, holding a share mode that
/// excludes writers for as long as the publish runs.
#[cfg(windows)]
pub(crate) fn publish_handle(dir: &Dir, name: &str) -> Result<File, Error> {
    windows::open_for_publish(dir, name)
}

/// Marks the handle's own entry for deletion, never a name that may have been repointed since.
#[cfg(windows)]
pub(crate) fn delete_by_handle(file: &File) -> Result<(), Error> {
    windows::delete_by_handle(file)
}

/// Reads or clears the read-only attribute through an open handle.
#[cfg(windows)]
pub(crate) fn set_readonly(file: &File, readonly: bool) -> Result<(), Error> {
    windows::set_readonly(file, readonly)
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
