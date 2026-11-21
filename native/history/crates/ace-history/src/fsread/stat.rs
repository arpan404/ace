// SPDX-License-Identifier: Apache-2.0

//! `fingerprint` from `@ace/native-session`: `dev:ino:size:mtimeMs:ctimeMs`, printed as Node and
//! Bun print them, so an index the TypeScript reader wrote is still current.
//!
//! On Windows the device and inode are the volume serial and file index, and the change time is
//! the handle's `ChangeTime`, all read from a handle (`files_safe::handle_facts`), as libuv reads
//! them; so a fingerprint there is taken from an open file, or from a path opened without
//! following a link.

use std::fs::{File, Metadata};
use std::path::Path;

use history_text::js;

use crate::error::{Result, io_at};

/// `mtimeMs`: seconds times 1000 plus nanoseconds over a million, in floating point as Node.
pub fn mtime_ms(meta: &Metadata) -> f64 {
    let at = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or((0, 0), |d| {
            (d.as_secs() as i64, i64::from(d.subsec_nanos()))
        });
    ms(at.0, at.1)
}

fn ms(seconds: i64, nanos: i64) -> f64 {
    seconds as f64 * 1000.0 + nanos as f64 / 1e6
}

fn print(dev: u64, ino: u64, size: u64, mtime: f64, ctime: f64) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        js::number(dev as f64),
        js::number(ino as f64),
        size,
        js::number(mtime),
        js::number(ctime)
    )
}

/// The fingerprint of what `meta` describes (Unix: `lstat` and `fstat` agree).
#[cfg(unix)]
pub fn fingerprint(meta: &Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    print(
        meta.dev(),
        meta.ino(),
        meta.len(),
        ms(meta.mtime(), meta.mtime_nsec()),
        ms(meta.ctime(), meta.ctime_nsec()),
    )
}

/// The fingerprint of an open file.
#[cfg(unix)]
pub fn fingerprint_of(file: &File) -> Result<String> {
    Ok(fingerprint(&file.metadata()?))
}

/// The fingerprint of the entry at `path`, a link itself never followed.
#[cfg(unix)]
pub fn fingerprint_at(path: &Path) -> Result<String> {
    Ok(fingerprint(
        &std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?,
    ))
}

/// 100 ns ticks since 1601 as Unix milliseconds, as libuv computes them.
#[cfg(windows)]
fn windows_ms(ticks: i64) -> f64 {
    const EPOCH_DIFFERENCE: i64 = 116_444_736_000_000_000;
    const TICKS_PER_SECOND: i64 = 10_000_000;
    let delta = ticks - EPOCH_DIFFERENCE;
    ms(delta / TICKS_PER_SECOND, delta % TICKS_PER_SECOND * 100)
}

#[cfg(windows)]
pub fn fingerprint_of(file: &File) -> Result<String> {
    use std::os::windows::fs::MetadataExt;
    let meta = file.metadata()?;
    let (dev, ino, change) = files_safe::handle_facts(file)?;
    Ok(print(
        dev,
        ino,
        meta.len(),
        windows_ms(meta.last_write_time() as i64),
        windows_ms(change),
    ))
}

/// The entry itself at `path`, opened for its attributes only: a reparse point is not followed,
/// and a folder opens too.
#[cfg(windows)]
fn open_entry(path: &Path) -> Result<File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|e| io_at(e, path))
}

#[cfg(windows)]
pub fn fingerprint_at(path: &Path) -> Result<String> {
    fingerprint_of(&open_entry(path)?)
}

/// Whether `path` still names the file `file` is open on (a link itself never followed).
#[cfg(unix)]
pub fn same_entry(path: &Path, file: &File) -> Result<bool> {
    use std::os::unix::fs::MetadataExt;
    let at = std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?;
    let open = file.metadata()?;
    Ok(at.dev() == open.dev() && at.ino() == open.ino())
}

/// Whether `path` still names the file `file` is open on: the same volume serial and file
/// index, `path` opened without following a link.
#[cfg(windows)]
pub fn same_entry(path: &Path, file: &File) -> Result<bool> {
    let (dev, ino, _) = files_safe::handle_facts(&open_entry(path)?)?;
    let (open_dev, open_ino, _) = files_safe::handle_facts(file)?;
    Ok(dev == open_dev && ino == open_ino)
}

#[cfg(not(any(unix, windows)))]
pub fn same_entry(path: &Path, _file: &File) -> Result<bool> {
    std::fs::symlink_metadata(path).map_err(|e| io_at(e, path))?;
    Ok(true)
}

#[cfg(not(any(unix, windows)))]
pub fn fingerprint_of(file: &File) -> Result<String> {
    let meta = file.metadata()?;
    Ok(print(0, 0, meta.len(), mtime_ms(&meta), mtime_ms(&meta)))
}

#[cfg(not(any(unix, windows)))]
pub fn fingerprint_at(path: &Path) -> Result<String> {
    fingerprint_of(&File::open(path).map_err(|e| io_at(e, path))?)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    #[test]
    fn a_file_replaced_by_one_of_the_same_size_and_time_has_another_fingerprint() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.json");
        std::fs::write(&path, "first").unwrap();
        let first = fingerprint_at(&path).unwrap();
        let open = File::open(&path).unwrap();
        assert_eq!(fingerprint_of(&open).unwrap(), first);
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        // Another file, the same size, its modification time set back to the first's.
        std::fs::write(dir.path().join("b.json"), "other").unwrap();
        let other = File::options()
            .write(true)
            .open(dir.path().join("b.json"))
            .unwrap();
        other.set_modified(modified).unwrap();
        drop(other);
        std::fs::rename(dir.path().join("b.json"), &path).unwrap();
        assert_ne!(fingerprint_at(&path).unwrap(), first);
    }

    #[test]
    fn a_path_is_the_same_entry_until_another_file_takes_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db-wal");
        std::fs::write(&path, "journal").unwrap();
        let open = File::open(&path).unwrap();
        // Growing or truncating it in place keeps it the same file.
        std::fs::write(&path, "journal, longer").unwrap();
        assert!(same_entry(&path, &open).unwrap());
        // Another file renamed over its name is not, even while the first is still held.
        std::fs::write(dir.path().join("other"), "journal").unwrap();
        std::fs::rename(dir.path().join("other"), &path).unwrap();
        assert!(!same_entry(&path, &open).unwrap());
    }
}
