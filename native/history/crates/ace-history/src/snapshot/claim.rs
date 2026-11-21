// SPDX-License-Identifier: Apache-2.0

//! Claiming a scratch directory so no other reader's sweep can take it from a live owner.
//!
//! Each directory `<name>` has a sibling `<name>.lock` its owner holds locked for as long as it
//! lives; the operating system releases the lock when the owner exits, however it exits. The lock
//! is taken before the directory exists, so a sweepable directory never exists without a held
//! lock, whatever its pid now names (Windows reuses pids quickly).

use std::fs::{File, OpenOptions};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result, io_at};

pub const LOCK_SUFFIX: &str = ".lock";

/// A claimed directory: removed, then unlocked, when dropped.
pub struct Claim {
    pub dir: PathBuf,
    lock_path: PathBuf,
    lock: Option<File>,
}

impl Drop for Claim {
    fn drop(&mut self) {
        // Removed while still locked, so no sweep sees it unowned; the lock file last.
        let _ = std::fs::remove_dir_all(&self.dir);
        let _ = std::fs::remove_file(&self.lock_path);
        drop(self.lock.take());
    }
}

#[cfg(unix)]
fn private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

#[cfg(not(unix))]
fn private_dir(path: &Path) -> std::io::Result<()> {
    std::fs::create_dir(path)
}

/// Claim a new directory named `<prefix><random>` in `root`.
pub fn claim(root: &Path, prefix: &str) -> Result<Claim> {
    for _ in 0..16 {
        let named = tempfile::Builder::new()
            .prefix(prefix)
            .suffix(LOCK_SUFFIX)
            .tempfile_in(root)
            .map_err(|e| io_at(e, root))?;
        let (lock, lock_path) = named.keep().map_err(|e| io_at(e.error, root))?;
        if let Err(error) = lock.try_lock() {
            let _ = std::fs::remove_file(&lock_path);
            return Err(Error::message(format!(
                "Could not lock {}: {error}",
                lock_path.display()
            )));
        }
        let name = lock_path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(LOCK_SUFFIX))
            .unwrap_or_default()
            .to_owned();
        let dir = root.join(name);
        match private_dir(&dir) {
            Ok(()) => {
                return Ok(Claim {
                    dir,
                    lock_path,
                    lock: Some(lock),
                });
            }
            // A leftover directory of that name: try another.
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let _ = std::fs::remove_file(&lock_path);
            }
            Err(error) => {
                let _ = std::fs::remove_file(&lock_path);
                return Err(io_at(error, &dir));
            }
        }
    }
    Err(Error::message("No free scratch directory name"))
}

/// Who holds a directory, as a sweep sees it.
pub enum Holder {
    /// Its lock is held, or could not be checked: keep it.
    Owned,
    /// Its lock was free and is now this sweep's: remove the directory, then drop this.
    Free(Free),
    /// It has no lock file, as a directory made before locks were has not.
    Unknown,
}

/// A lock a sweep took from a dead owner; dropping it removes the lock file.
pub struct Free {
    path: PathBuf,
    _lock: File,
}

impl Drop for Free {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Who holds `dir`. A lock check that itself fails keeps the directory.
pub fn holder(dir: &Path) -> Holder {
    let mut path = dir.as_os_str().to_owned();
    path.push(LOCK_SUFFIX);
    let path = PathBuf::from(path);
    match OpenOptions::new().read(true).write(true).open(&path) {
        Ok(file) => match file.try_lock() {
            Ok(()) => Holder::Free(Free { path, _lock: file }),
            Err(_) => Holder::Owned,
        },
        Err(error) if error.kind() == ErrorKind::NotFound => Holder::Unknown,
        Err(_) => Holder::Owned,
    }
}
