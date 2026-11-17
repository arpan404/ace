// SPDX-License-Identifier: Apache-2.0

//! Opens a resolved file for reading without following a symlink in its last component.

use std::fs::{File, OpenOptions};
use std::io;
use std::path::Path;

/// Opens `path` read-only, refusing a symlink as the last component.
///
/// `files_safe::Root::resolve` has already confirmed the path is inside the root; refusing the
/// last symlink keeps a link swapped in afterwards from redirecting the read elsewhere.
pub(crate) fn open(path: &Path) -> io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    no_follow(&mut options);
    options.open(path)
}

#[cfg(unix)]
fn no_follow(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW);
}

#[cfg(windows)]
fn no_follow(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    /// `FILE_FLAG_OPEN_REPARSE_POINT`: open the link itself, never its target.
    const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    options.custom_flags(OPEN_REPARSE_POINT);
}

#[cfg(not(any(unix, windows)))]
fn no_follow(_options: &mut OpenOptions) {}
