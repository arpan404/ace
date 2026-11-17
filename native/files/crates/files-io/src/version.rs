// SPDX-License-Identifier: Apache-2.0

//! The version string stored with drafts, byte for byte what the TypeScript daemon prints.

use std::fs::Metadata;
use std::io::ErrorKind;
use std::path::Path;

use files_safe::Root;

use crate::Error;

/// The version of the entry at `path`, or `None` when there is nothing there.
///
/// Directories have versions too, so a caller can guard a later change to either kind of entry.
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
    let (dev, ino) = identity(absolute, metadata)?;
    let (mtime, ctime) = times(metadata);
    Ok(format!(
        "{}:{}:{}:{}:{}",
        js_number(dev as f64),
        js_number(ino as f64),
        js_number(metadata.len() as f64),
        js_number(mtime),
        js_number(ctime)
    ))
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
fn identity(_absolute: &Path, metadata: &Metadata) -> Result<(u64, u64), Error> {
    use std::os::unix::fs::MetadataExt;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(unix)]
fn times(metadata: &Metadata) -> (f64, f64) {
    use std::os::unix::fs::MetadataExt;
    (
        unix_millis(metadata.mtime(), metadata.mtime_nsec()),
        unix_millis(metadata.ctime(), metadata.ctime_nsec()),
    )
}

/// Windows has no `dev`/`ino`: the volume serial and the file index stand in for them, and only
/// a handle can report them.
#[cfg(windows)]
fn identity(absolute: &Path, _metadata: &Metadata) -> Result<(u64, u64), Error> {
    use std::os::windows::fs::OpenOptionsExt;

    /// `FILE_FLAG_BACKUP_SEMANTICS`: a folder opens as a handle, which a plain open refuses.
    const BACKUP_SEMANTICS: u32 = 0x0200_0000;
    /// `FILE_FLAG_OPEN_REPARSE_POINT`: a link reports its own identity, like the metadata
    /// beside it.
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    /// `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`: never block another writer.
    const SHARE_ALL: u32 = 0x0000_0007;

    let file = std::fs::OpenOptions::new()
        .access_mode(0)
        .share_mode(SHARE_ALL)
        .custom_flags(BACKUP_SEMANTICS | OPEN_REPARSE_POINT)
        .open(absolute)?;
    let information = winapi_util::file::information(&file)?;
    Ok((information.volume_serial_number(), information.file_index()))
}

#[cfg(windows)]
fn times(metadata: &Metadata) -> (f64, f64) {
    use std::os::windows::fs::MetadataExt;
    (
        windows_millis(metadata.last_write_time()),
        windows_millis(metadata.creation_time()),
    )
}

/// Node reports Windows times as Unix milliseconds: libuv turns the 100 ns ticks since 1601 into
/// seconds and nanoseconds first, so doing the same here keeps the printed digits identical.
#[cfg(windows)]
fn windows_millis(filetime: u64) -> f64 {
    const EPOCH_DIFFERENCE: u64 = 116_444_736_000_000_000;
    const TICKS_PER_SECOND: u64 = 10_000_000;
    let ticks = filetime.saturating_sub(EPOCH_DIFFERENCE);
    unix_millis(
        (ticks / TICKS_PER_SECOND) as i64,
        ((ticks % TICKS_PER_SECOND) * 100) as i64,
    )
}

/// Milliseconds since the Unix epoch, as the double Node computes from a timespec.
#[cfg(any(unix, windows))]
fn unix_millis(seconds: i64, nanoseconds: i64) -> f64 {
    seconds as f64 * 1000.0 + nanoseconds as f64 / 1e6
}
