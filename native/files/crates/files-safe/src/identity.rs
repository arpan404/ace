// SPDX-License-Identifier: Apache-2.0

//! Whether the folder behind the root handle is still the folder the root path names.
//!
//! The handle is opened once, at `Root::open`. If the folder is later moved away and the path is
//! filled with a link to somewhere else, the handle still points at the original tree while the
//! path leads elsewhere. Comparing the two identities catches that before any lookup.

use std::fs::File;
use std::io;
use std::path::Path;

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
