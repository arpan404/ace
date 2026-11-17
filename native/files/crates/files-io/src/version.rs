// SPDX-License-Identifier: Apache-2.0

//! The version string stored with drafts, byte for byte what the TypeScript daemon prints.

use std::fs::Metadata;
use std::io::ErrorKind;
use std::path::Path;

use files_safe::Root;

use crate::Error;

/// The version of the entry at `path`, or `None` when there is nothing there.
///
/// Files carry their identity and times. Folders carry a digest of their whole tree, so a
/// caller can guard a later change to either kind of entry the way the daemon does.
pub fn stat_version(root: &Root, path: &str) -> Result<Option<String>, Error> {
    let absolute = match root.resolve(path) {
        Ok(absolute) => absolute,
        Err(files_safe::Error::Io(error)) if error.kind() == ErrorKind::NotFound => {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    match std::fs::symlink_metadata(&absolute) {
        Ok(metadata) => Ok(Some(entry_version(root, path, &absolute, &metadata)?)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// The version of any entry: a file's own, or a folder's tree digest, which is what the daemon
/// compares a caller's expected version against.
pub(crate) fn entry_version(
    root: &Root,
    path: &str,
    absolute: &Path,
    metadata: &Metadata,
) -> Result<String, Error> {
    if metadata.is_dir() {
        crate::tree::version(root, path, absolute, metadata)
    } else {
        version_of(absolute, metadata)
    }
}

/// `{dev}:{ino}:{size}:{mtimeMs}:{ctimeMs}`, with every number printed the way JavaScript prints
/// it, because the daemon may compare a version this process printed with one it printed itself.
pub(crate) fn version_of(absolute: &Path, metadata: &Metadata) -> Result<String, Error> {
    Ok(text(metadata, facts(absolute, metadata)?))
}

/// The version of bytes read through an open file. Its own handle, not the path, decides the
/// identity and times, so a file swapped at the path cannot lend its version to older bytes.
pub(crate) fn version_of_handle(
    file: &std::fs::File,
    metadata: &Metadata,
) -> Result<String, Error> {
    Ok(text(metadata, facts_of_handle(file, metadata)?))
}

fn text(metadata: &Metadata, facts: Facts) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        js_number(facts.dev as f64),
        js_number(facts.ino as f64),
        js_number(metadata.len() as f64),
        js_number(facts.mtime),
        js_number(facts.ctime)
    )
}

/// Whether two paths name the same entry. A case-only rename on a case-insensitive volume finds
/// the destination already "there" and must still be allowed.
pub(crate) fn same_entry(
    left_path: &Path,
    left: &Metadata,
    right_path: &Path,
    right: &Metadata,
) -> Result<bool, Error> {
    let left = facts(left_path, left)?;
    let right = facts(right_path, right)?;
    Ok(left.dev == right.dev && left.ino == right.ino)
}

/// The identity and times a version is made of.
struct Facts {
    dev: u64,
    ino: u64,
    mtime: f64,
    ctime: f64,
}

/// A JavaScript number in string form.
///
/// A version component is a non-negative integer or a millisecond timestamp, so it stays inside
/// the range where ECMAScript and Rust both print plain decimal digits (1e-6 up to 1e21).
/// Outside it JavaScript switches to exponent form, which is reproduced for completeness.
fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".to_owned();
    }
    let magnitude = value.abs();
    if !(1e-6..1e21).contains(&magnitude) {
        let mut text = format!("{value:e}");
        if let Some(exponent) = text.find('e') {
            if !text[exponent + 1..].starts_with('-') {
                text.insert(exponent + 1, '+');
            }
        }
        return text;
    }
    format!("{value}")
}

#[cfg(unix)]
fn facts(_absolute: &Path, metadata: &Metadata) -> Result<Facts, Error> {
    Ok(facts_of_metadata(metadata))
}

#[cfg(unix)]
fn facts_of_handle(_file: &std::fs::File, metadata: &Metadata) -> Result<Facts, Error> {
    Ok(facts_of_metadata(metadata))
}

#[cfg(unix)]
fn facts_of_metadata(metadata: &Metadata) -> Facts {
    use std::os::unix::fs::MetadataExt;
    Facts {
        dev: metadata.dev(),
        ino: metadata.ino(),
        mtime: unix_millis(metadata.mtime(), metadata.mtime_nsec()),
        ctime: unix_millis(metadata.ctime(), metadata.ctime_nsec()),
    }
}

/// Windows has no `dev`/`ino`: the volume serial and the file index stand in for them, and only
/// a handle can report them. The handle also carries the change time, which is what libuv puts
/// in `ctimeMs`; the write time comes from the metadata beside it.
#[cfg(windows)]
fn facts(absolute: &Path, metadata: &Metadata) -> Result<Facts, Error> {
    facts_of_handle(&open_attributes(absolute)?, metadata)
}

#[cfg(windows)]
fn facts_of_handle(file: &std::fs::File, metadata: &Metadata) -> Result<Facts, Error> {
    use std::os::windows::fs::MetadataExt;

    let (dev, ino, change) = windows::handle_facts(file)?;
    Ok(Facts {
        dev,
        ino,
        mtime: windows_millis(metadata.last_write_time() as i64),
        ctime: windows_millis(change),
    })
}

/// An attribute-only handle: no read or write access is requested, so a file the caller may not
/// read still has a version. A folder needs `FILE_FLAG_BACKUP_SEMANTICS`; a reparse point is
/// opened itself so its own identity is reported, and every share bit is set so no writer is
/// blocked.
#[cfg(windows)]
fn open_attributes(absolute: &Path) -> Result<std::fs::File, Error> {
    use std::os::windows::fs::OpenOptionsExt;

    /// `FILE_FLAG_BACKUP_SEMANTICS`: a folder opens as a handle, which a plain open refuses.
    const BACKUP_SEMANTICS: u32 = 0x0200_0000;
    /// `FILE_FLAG_OPEN_REPARSE_POINT`: a link reports its own identity, like the metadata
    /// beside it.
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    /// `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`: never block another writer.
    const SHARE_ALL: u32 = 0x0000_0007;

    Ok(std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(SHARE_ALL)
        .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
        .open(absolute)?)
}

/// The two calls that read a handle's identity and change time.
///
/// Stable Rust exposes neither `volume_serial_number`/`file_index` on `Metadata` (still
/// unstable as `windows_by_handle`) nor the change time (`windows_change_time`), and no safe
/// wrapper is available for `GetFileInformationByHandleEx`. This is the one place in the crate
/// that calls Windows directly.
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows {
    use std::ffi::c_void;
    use std::fs::File;
    use std::mem::{size_of, zeroed};
    use std::os::windows::io::AsRawHandle;

    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandle,
        GetFileInformationByHandleEx,
    };

    /// The volume serial, the file index and the change time, in 100 ns ticks since 1601.
    pub(super) fn handle_facts(file: &File) -> std::io::Result<(u64, u64, i64)> {
        let handle = file.as_raw_handle() as HANDLE;
        // SAFETY: both calls only write into zeroed structures of the size they are given, and
        // the handle stays open for the calls because `file` is borrowed for their duration.
        unsafe {
            let mut information: BY_HANDLE_FILE_INFORMATION = zeroed();
            if GetFileInformationByHandle(handle, &mut information) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let mut basic: FILE_BASIC_INFO = zeroed();
            if GetFileInformationByHandleEx(
                handle,
                FileBasicInfo,
                std::ptr::from_mut(&mut basic).cast::<c_void>(),
                size_of::<FILE_BASIC_INFO>() as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            let index = (u64::from(information.nFileIndexHigh) << 32)
                | u64::from(information.nFileIndexLow);
            Ok((
                u64::from(information.dwVolumeSerialNumber),
                index,
                basic.ChangeTime,
            ))
        }
    }
}

/// Milliseconds since the Unix epoch, as the double Node computes from a timespec.
#[cfg(any(unix, windows))]
fn unix_millis(seconds: i64, nanoseconds: i64) -> f64 {
    seconds as f64 * 1000.0 + nanoseconds as f64 / 1e6
}

/// Node reports Windows times as Unix milliseconds: libuv turns the 100 ns ticks since 1601 into
/// seconds and nanoseconds first, keeping the sign, so doing the same keeps the printed digits
/// identical for files older than 1970.
#[cfg(windows)]
fn windows_millis(ticks: i64) -> f64 {
    const EPOCH_DIFFERENCE: i64 = 116_444_736_000_000_000;
    const TICKS_PER_SECOND: i64 = 10_000_000;
    let delta = ticks - EPOCH_DIFFERENCE;
    unix_millis(delta / TICKS_PER_SECOND, delta % TICKS_PER_SECOND * 100)
}
