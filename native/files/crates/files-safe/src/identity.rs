// SPDX-License-Identifier: Apache-2.0

//! What names one folder on its volume, and whether the folder behind the root handle is still
//! the folder the root path names.
//!
//! The root handle is opened once, at `Root::open`. If that folder is later moved away and the path
//! is filled with a link to somewhere else, the handle still points at the original tree while the
//! path leads elsewhere. Comparing the two identities catches that before any lookup.
//!
//! A caller that keeps a folder handle of its own has the same problem on a smaller scale: between
//! two reads the folder can be renamed away and another put in its place. [`Identity`] is what such
//! a caller keeps beside the handle, so [`crate::Root::still_names`] can prove it with one lookup.

use std::fs::File;
use std::io;
use std::path::Path;

use cap_std::fs::{Dir, Metadata};

/// What names one folder on its volume: the device and inode on Unix, the volume and file index on
/// Windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Identity {
    device: u64,
    inode: u64,
}

impl Identity {
    /// The identity `metadata` describes, or none where the platform has no answer.
    #[cfg(any(unix, windows))]
    pub(crate) fn of(metadata: &Metadata) -> Option<Identity> {
        use cap_fs_ext::MetadataExt;

        Some(Identity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }

    /// Platforms without a file identity cannot tell one folder from another, so nothing may be
    /// kept and proved: every lookup walks to the folder again.
    #[cfg(not(any(unix, windows)))]
    pub(crate) fn of(_metadata: &Metadata) -> Option<Identity> {
        None
    }
}

/// The identity the name `rel` below `root` leads to right now, or none when nothing is there.
///
/// On Unix this is one `lstat` of the absolute path: the kernel resolves the whole name in one
/// lookup, which is what makes the proof cheap enough to take before every reuse of a folder
/// handle. Elsewhere it goes through the folder handle, which walks the name one component at a
/// time; the answer is the same, only the number of lookups differs.
#[cfg(unix)]
pub(crate) fn named(root: &Path, _dir: &Dir, rel: &str) -> Option<Identity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = std::fs::symlink_metadata(root.join(rel)).ok()?;
    Some(Identity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(not(unix))]
pub(crate) fn named(_root: &Path, dir: &Dir, rel: &str) -> Option<Identity> {
    Identity::of(&dir.symlink_metadata(rel).ok()?)
}

/// Whether the open folder and the folder the path names are the same entry.
#[cfg(unix)]
pub(crate) fn same_file(handle: File, named: &Path) -> io::Result<bool> {
    use std::os::unix::fs::MetadataExt;

    let handle = handle.metadata()?;
    let named = std::fs::metadata(named)?;
    Ok(handle.dev() == named.dev() && handle.ino() == named.ino())
}

/// Windows reports a volume and file index rather than a device and inode; `same-file` asks for
/// exactly those through `GetFileInformationByHandle`.
#[cfg(windows)]
pub(crate) fn same_file(handle: File, named: &Path) -> io::Result<bool> {
    let handle = same_file::Handle::from_file(handle)?;
    let named = same_file::Handle::from_path(named)?;
    Ok(handle == named)
}

/// Platforms without a file identity cannot tell, so a root that opens and lists keeps working.
#[cfg(not(any(unix, windows)))]
pub(crate) fn same_file(_handle: File, named: &Path) -> io::Result<bool> {
    std::fs::metadata(named)?;
    Ok(true)
}
