// SPDX-License-Identifier: Apache-2.0
//! The home's small filesystem helpers: private files, a file's mode, the clock.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// A Unix mode on a new file: `0o600` on Unix, nothing on Windows.
#[cfg(unix)]
pub(super) fn mode(options: &mut OpenOptions) -> &mut OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600)
}

#[cfg(not(unix))]
pub(super) fn mode(options: &mut OpenOptions) -> &mut OpenOptions {
    options
}

/// A fresh file's mode as `writeFileSync(..., { mode: 0o600 })` sets it.
pub(crate) fn create_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut file: File = mode(&mut options).open(path)?;
    file.write_all(contents)
}

/// `writeFileSync(path, contents, { mode: 0o600 })`: replaces what is there.
pub(crate) fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    let mut file: File = mode(&mut options).open(path)?;
    file.write_all(contents)
}

/// This process's clock, in milliseconds since the epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}
