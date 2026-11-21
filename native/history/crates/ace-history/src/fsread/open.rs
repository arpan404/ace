// SPDX-License-Identifier: Apache-2.0

//! `safeOpen`: a session file is opened only inside its registered home, through no symlink, as
//! a regular file.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use crate::error::{Error, Result, io_at};
use crate::paths::contains;

const ESCAPED: &str = "Session path escaped its registered home";

pub fn safe_open(home: &Path, path: &Path) -> Result<File> {
    if !contains(home, path) {
        return Err(Error::message(ESCAPED));
    }
    let canonical_home = home.canonicalize().map_err(|e| io_at(e, home))?;
    let canonical_path = path.canonicalize().map_err(|e| io_at(e, path))?;
    if !contains(&canonical_home, &canonical_path) {
        return Err(Error::message(ESCAPED));
    }
    let relative = path
        .strip_prefix(home)
        .map_err(|_| Error::message(ESCAPED))?;
    let parts: Vec<_> = relative.components().collect();
    if parts.len() > 32 {
        return Err(Error::message("Session path depth limit exceeded"));
    }
    let mut current = PathBuf::from(home);
    for part in parts {
        current.push(part);
        let info = std::fs::symlink_metadata(&current).map_err(|e| io_at(e, &current))?;
        if info.file_type().is_symlink() {
            return Err(Error::message("Session path contains a symlink"));
        }
    }
    let file = open_no_follow(path).map_err(|e| io_at(e, path))?;
    if !file.metadata()?.is_file() {
        return Err(Error::message("Session source is not a regular file"));
    }
    Ok(file)
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_no_follow(path: &Path) -> std::io::Result<File> {
    OpenOptions::new().read(true).open(path)
}
