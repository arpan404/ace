// SPDX-License-Identifier: Apache-2.0

//! The version string stored with drafts, byte for byte what the TypeScript daemon prints.
//!
//! Versions come from the handle the bytes were read through, never from a path: on Unix the
//! metadata carries the device, inode and both times, and on Windows the open handle is asked
//! for the volume serial, file index and change time libuv reports.

use cap_std::fs::{Dir, File, Metadata, MetadataExt};
use files_safe::Root;

use crate::Error;

/// The version of the entry at `path`, or `None` when there is nothing there.
///
/// Files carry their identity and times. Folders carry a digest of their whole tree, so a
/// caller can guard a later change to either kind of entry the way the daemon does.
pub fn stat_version(root: &Root, path: &str) -> Result<Option<String>, Error> {
    let (dir, name) = match crate::handle::target_parent(root, path) {
        Ok(found) => found,
        Err(error) if error.code() == "NOT_FOUND" => return Ok(None),
        Err(error) => return Err(error),
    };
    entry_version(root, &dir, &name, path)
}

/// The version of `name` in `dir`, or `None` when nothing is there. `path` is the caller's
/// spelling, which names the entries a folder version digests and labels its errors.
pub(crate) fn entry_version(
    root: &Root,
    dir: &Dir,
    name: &str,
    path: &str,
) -> Result<Option<String>, Error> {
    let metadata = match dir.symlink_metadata(name) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.is_dir() {
        let folder = dir.open_dir(name)?;
        return Ok(Some(crate::tree::version(root, path, &folder)?));
    }
    Ok(Some(version_of(
        entry_handle(dir, name, &metadata)?.as_ref(),
        &metadata,
    )?))
}

/// The version of `name` in `dir` from metadata the caller already read, with the handle Windows
/// needs opened only there.
pub(crate) fn version_of_entry(
    dir: &Dir,
    name: &str,
    metadata: &Metadata,
) -> Result<String, Error> {
    version_of(entry_handle(dir, name, metadata)?.as_ref(), metadata)
}

/// The version of an entry from its metadata and, on Windows, a handle to it.
pub(crate) fn version_of(handle: Option<&File>, metadata: &Metadata) -> Result<String, Error> {
    let facts = facts(handle, metadata)?;
    Ok(format!(
        "{}:{}:{}:{}:{}",
        js_number(facts.dev as f64),
        js_number(facts.ino as f64),
        js_number(metadata.len() as f64),
        js_number(facts.mtime),
        js_number(facts.ctime)
    ))
}

/// Whether `name` in `dir` still has the identity recorded in `metadata`.
#[cfg(unix)]
pub(crate) fn still(dir: &Dir, name: &str, metadata: &Metadata) -> Result<bool, Error> {
    let again = dir.symlink_metadata(name)?;
    Ok(identity(metadata) == identity(&again))
}

/// The identity a version is anchored on.
#[cfg(unix)]
pub(crate) fn identity(metadata: &Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

/// Whether two entries in their folders are the same entry, which a case-only rename on a
/// case-insensitive volume needs. A link is compared as itself, never followed.
pub(crate) fn same_entry(
    left_dir: &Dir,
    left_name: &str,
    right_dir: &Dir,
    right_name: &str,
) -> Result<bool, Error> {
    let left = left_dir.symlink_metadata(left_name)?;
    let right = right_dir.symlink_metadata(right_name)?;
    let left = facts(entry_handle(left_dir, left_name, &left)?.as_ref(), &left)?;
    let right = facts(
        entry_handle(right_dir, right_name, &right)?.as_ref(),
        &right,
    )?;
    Ok(left.dev == right.dev && left.ino == right.ino)
}

/// A version with its last field removed: a rename changes the change time and nothing else a
/// version records, so the daemon compares versions this way when it swaps a save into place.
#[cfg(unix)]
pub(crate) fn without_change_time(version: &str) -> &str {
    version.rsplit_once(':').map_or(version, |(rest, _)| rest)
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
            let positive = !text[exponent + 1..].starts_with('-');
            if positive {
                text.insert(exponent + 1, '+');
            }
        }
        return text;
    }
    format!("{value}")
}

#[cfg(unix)]
fn facts(_handle: Option<&File>, metadata: &Metadata) -> Result<Facts, Error> {
    Ok(Facts {
        dev: metadata.dev(),
        ino: metadata.ino(),
        mtime: unix_millis(metadata.mtime(), metadata.mtime_nsec()),
        ctime: unix_millis(metadata.ctime(), metadata.ctime_nsec()),
    })
}

/// The handle an entry's version needs on Windows; Unix reads everything from the metadata.
#[cfg(unix)]
fn entry_handle(_dir: &Dir, _name: &str, _metadata: &Metadata) -> Result<Option<File>, Error> {
    Ok(None)
}

/// Windows has no `dev`/`ino`: the volume serial and the file index stand in for them, and only
/// a handle can report them. The handle also carries the change time, which is what libuv puts
/// in `ctimeMs`; the write time comes from the metadata beside it.
#[cfg(windows)]
fn facts(handle: Option<&File>, metadata: &Metadata) -> Result<Facts, Error> {
    let handle = handle.ok_or_else(|| {
        Error::Io(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "a Windows version needs the entry's handle",
        ))
    })?;
    let (dev, ino, change) = windows::handle_facts(handle)?;
    Ok(Facts {
        dev,
        ino,
        mtime: windows_millis(metadata.last_write_time() as i64),
        ctime: windows_millis(change),
    })
}

#[cfg(windows)]
fn entry_handle(dir: &Dir, name: &str, metadata: &Metadata) -> Result<Option<File>, Error> {
    use cap_fs_ext::DirExt;

    if metadata.is_dir() {
        return Ok(Some(crate::handle::dir_handle(
            &dir.open_dir_nofollow(name)?,
        )?));
    }
    Ok(Some(crate::handle::attribute_handle(dir, name)?))
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

    use cap_std::fs::File;
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
