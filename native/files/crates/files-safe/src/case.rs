// SPDX-License-Identifier: Apache-2.0

//! Whether a folder folds name case.
//!
//! A folder that folds case answers a name it stores under any case, so a caller that reports the
//! spelling on disk has to ask what is really stored. One that keeps case gives back exactly the
//! spelling it was given, which is why a watcher can skip that question there. The question is
//! asked per folder - one checkout can hold a casefolded folder beside case-sensitive ones, and a
//! mount point can bring a different volume in - by looking one of the folder's own entries up
//! under a spelling that differs only in case.

#[cfg(unix)]
use std::ffi::OsStr;
#[cfg(unix)]
use std::io;

use cap_std::fs::Dir;

/// Whether the folder `dir` folds name case.
///
/// A folder with no name to ask about, or one the probe could not read, is taken to fold: asking
/// for the stored spelling there costs a reading, while guessing that it does not would keep an old
/// spelling indexed beside a renamed one. Being wrong in that direction is slower, never wrong.
pub(crate) fn folds(dir: &Dir) -> bool {
    probing(dir).unwrap_or(true)
}

/// Whether a toggled-case spelling of one of the folder's own entries answers with that entry.
#[cfg(unix)]
fn probing(dir: &Dir) -> Option<bool> {
    use std::os::unix::ffi::OsStrExt;

    /// How many entries to look at before giving up: names without a letter say nothing, and a
    /// folder full of them is not worth walking.
    const EXAMINED: usize = 256;
    for entry in dir.entries().ok()?.flatten().take(EXAMINED) {
        let name = entry.file_name();
        let Some(toggled) = toggled(&name) else {
            continue;
        };
        let Ok(stored) = dir.symlink_metadata(&name) else {
            continue;
        };
        return match dir.symlink_metadata(OsStr::from_bytes(toggled.as_slice())) {
            Ok(asked) => Some(same_identity(&stored, &asked)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Some(false),
            Err(_) => continue,
        };
    }
    None
}

/// Windows keeps names folded unless a folder opts out, which is rare enough that the stored-name
/// work is always worth doing there.
#[cfg(not(unix))]
fn probing(_dir: &Dir) -> Option<bool> {
    None
}

/// The name with the case of its first ASCII letter swapped.
#[cfg(unix)]
fn toggled(name: &OsStr) -> Option<Vec<u8>> {
    use std::os::unix::ffi::OsStrExt;

    let mut bytes = name.as_bytes().to_vec();
    for byte in &mut bytes {
        match byte {
            b'a'..=b'z' => {
                *byte = byte.to_ascii_uppercase();
                return Some(bytes);
            }
            b'A'..=b'Z' => {
                *byte = byte.to_ascii_lowercase();
                return Some(bytes);
            }
            _ => {}
        }
    }
    None
}

/// Whether two readings describe the same entry.
#[cfg(unix)]
fn same_identity(left: &cap_std::fs::Metadata, right: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt;

    left.dev() == right.dev() && left.ino() == right.ino()
}
