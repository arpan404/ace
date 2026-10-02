use crate::protocol::{Fault, Result, internal};
use std::{os::unix::{fs::{FileTypeExt, MetadataExt}, net::UnixStream}, path::Path};

pub fn connect(path: &Path) -> Result<UnixStream> {
    let uid = unsafe { libc::geteuid() };
    let metadata = std::fs::symlink_metadata(path).map_err(internal)?;
    let parent = path.parent().ok_or_else(|| internal("Endpoint requires a parent directory"))?;
    let directory = std::fs::symlink_metadata(parent).map_err(internal)?;
    if !metadata.file_type().is_socket() || metadata.mode() & 0o077 != 0 || metadata.uid() != uid
        || !directory.is_dir() || directory.mode() & 0o077 != 0 || directory.uid() != uid {
        return Err(Fault::new("permission_denied", "Frame endpoint and its directory must be owner-only"));
    }
    let stream = UnixStream::connect(path).map_err(internal)?;
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let mut credential: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let status = unsafe { libc::getsockopt(stream.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED,
            &mut credential as *mut _ as *mut libc::c_void, &mut length) };
        if status != 0 || credential.uid != uid {
            return Err(Fault::new("permission_denied", "Frame endpoint peer must have the same owner"));
        }
    }
    Ok(stream)
}
