// SPDX-License-Identifier: Apache-2.0

//! The version string stored with drafts, byte for byte what the TypeScript daemon prints.

use std::fs::Metadata;
use std::io::ErrorKind;

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
        Ok(metadata) => Ok(Some(version_of(&metadata))),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

/// `{dev}:{ino}:{size}:{mtimeMs}:{ctimeMs}`, with every number printed the way JavaScript prints
/// it, because the daemon may compare a version this process printed with one it printed itself.
pub(crate) fn version_of(metadata: &Metadata) -> String {
    let (dev, ino) = identity(metadata);
    let (mtime, ctime) = times(metadata);
    format!(
        "{}:{}:{}:{}:{}",
        js_number(dev as f64),
        js_number(ino as f64),
        js_number(metadata.len() as f64),
        js_number(mtime),
        js_number(ctime)
    )
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
fn identity(metadata: &Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (metadata.dev(), metadata.ino())
}

#[cfg(unix)]
fn times(metadata: &Metadata) -> (f64, f64) {
    use std::os::unix::fs::MetadataExt;
    (
        unix_millis(metadata.mtime(), metadata.mtime_nsec()),
        unix_millis(metadata.ctime(), metadata.ctime_nsec()),
    )
}

#[cfg(windows)]
fn identity(metadata: &Metadata) -> (u64, u64) {
    use std::os::windows::fs::MetadataExt;
    (
        metadata.volume_serial_number().map_or(0, u64::from),
        metadata.file_index().unwrap_or(0),
    )
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
