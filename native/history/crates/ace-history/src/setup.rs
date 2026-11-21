// SPDX-License-Identifier: Apache-2.0

//! Starting a reader: the index path's checks (`index-path.ts`), its file and directory modes.

use std::path::{Path, PathBuf};

use crate::error::{Error, Result, io_at};
use crate::options::Home;
use crate::paths::contains;

/// Resolve missing descendants through their nearest existing parent, as `realpath` would.
fn prospective(path: &Path) -> Result<PathBuf> {
    match path.canonicalize() {
        Ok(real) => Ok(real),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let (Some(parent), Some(name)) = (path.parent(), path.file_name()) else {
                return Err(io_at(error, path));
            };
            Ok(prospective(parent)?.join(name))
        }
        Err(error) => Err(io_at(error, path)),
    }
}

/// The index must be a regular file outside every provider home.
pub fn validate_index_path(path: &Path, homes: &[Home]) -> Result<()> {
    let parent = prospective(path.parent().unwrap_or(Path::new("/")))?;
    for home in homes {
        if contains(&prospective(&home.home_dir)?, &parent) {
            return Err(Error::message("ace index must be outside provider homes"));
        }
    }
    match std::fs::symlink_metadata(path) {
        Ok(info) if !info.is_file() || info.file_type().is_symlink() => {
            Err(Error::message("ace index must be a regular file"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_at(error, path)),
    }
}

/// Create the index's directory (0700) and file (0600) if they are missing.
pub fn prepare_index(path: &Path) -> Result<()> {
    let parent = path.parent().unwrap_or(Path::new("/"));
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(parent).map_err(|e| io_at(e, parent))?;
    let mut options = std::fs::OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    drop(options.open(path).map_err(|e| io_at(e, path))?);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| io_at(e, path))?;
    }
    Ok(())
}

/// Whether a process with this pid is running.
#[cfg(unix)]
pub fn process_alive(pid: i32) -> bool {
    match rustix::process::Pid::from_raw(pid) {
        Some(pid) => match rustix::process::test_kill_process(pid) {
            Ok(()) => true,
            Err(error) => error == rustix::io::Errno::PERM,
        },
        None => false,
    }
}

/// Whether a process with this pid is running: it opens, and has not exited. A process this one
/// may not query is running.
#[cfg(windows)]
#[allow(unsafe_code)]
pub fn process_alive(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let Ok(pid) = u32::try_from(pid) else {
        return false;
    };
    // SAFETY: plain Win32 calls on a handle this function opens and closes itself.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

#[cfg(not(any(unix, windows)))]
pub fn process_alive(_pid: i32) -> bool {
    true
}

/// Milliseconds since the epoch, as `Date.now()`.
pub fn now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0.0, |d| d.as_millis() as f64)
        + crate::hooks::clock_shift()
}
