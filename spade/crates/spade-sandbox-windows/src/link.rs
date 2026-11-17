//! Hard-link attempts, for proving what a contained run can and can't give a second name. A hard
//! link is another name for the same file data, under the same security descriptor; a run that
//! could link one of the person's files into a folder it controls could reach that data through
//! the name it controls. Both ways to make one are here — the Win32 `CreateHardLink` and the
//! native `NtSetInformationFile(FileLinkInformation)` underneath it — each reporting the stage it
//! stopped at, so tests can tell "couldn't open the source" from "couldn't create the link".

use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::Path;

use windows::Wdk::Storage::FileSystem::{
    FILE_LINK_INFORMATION, FileLinkInformation, NtSetInformationFile,
};
use windows::Win32::Foundation::{HANDLE, RtlNtStatusToDosError};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_ATTRIBUTES, OPEN_EXISTING, SYNCHRONIZE,
};
use windows::Win32::System::IO::IO_STATUS_BLOCK;

/// Where a hard-link attempt stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// The existing file couldn't be opened with the rights a link needs.
    OpenSource,
    /// The source opened, but the new name couldn't be created (the destination refused it).
    CreateLink,
}

/// A hard-link attempt that failed, and at which stage.
#[derive(Debug)]
pub struct LinkError {
    pub stage: Stage,
    pub error: std::io::Error,
}

impl LinkError {
    fn at(stage: Stage) -> impl FnOnce(std::io::Error) -> Self {
        move |error| Self { stage, error }
    }
}

/// Opens `existing` with the rights making a hard link to it needs (write attributes: the link
/// count is an attribute of the file), as the first stage of both attempts below.
fn open_source(existing: &Path) -> std::io::Result<OwnedHandle> {
    let source = crate::wide(existing.as_os_str());
    // SAFETY: `source` is NUL-terminated and outlives the call; the handle is owned just below.
    let handle = unsafe {
        CreateFileW(
            windows::core::PCWSTR(source.as_ptr()),
            FILE_WRITE_ATTRIBUTES.0 | SYNCHRONIZE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .map_err(crate::io)?;
    // SAFETY: a fresh handle this scope now owns alone.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.0) })
}

/// Makes `link` a hard link to `existing` the Win32 way (`CreateHardLinkW`, through `std`), after
/// first opening the source as that call must, so the failing stage is known.
pub fn via_win32(existing: &Path, link: &Path) -> Result<(), LinkError> {
    drop(open_source(existing).map_err(LinkError::at(Stage::OpenSource))?);
    std::fs::hard_link(existing, link).map_err(LinkError::at(Stage::CreateLink))
}

/// Makes `link` a hard link to `existing` the native way: open the source, then
/// `NtSetInformationFile(FileLinkInformation)` naming the new path — the call `CreateHardLinkW`
/// makes underneath, reachable directly by any process that skips the Win32 layer.
pub fn via_nt(existing: &Path, link: &Path) -> Result<(), LinkError> {
    let source = open_source(existing).map_err(LinkError::at(Stage::OpenSource))?;

    // The destination as an NT path (`\??\<full path>`), UTF-16, no trailing NUL.
    let mut target = OsString::from(r"\??\");
    target.push(link.as_os_str());
    let name: Vec<u16> = target.encode_wide().collect();
    let name_bytes = u32::try_from(name.len() * 2).map_err(|_| LinkError {
        stage: Stage::CreateLink,
        error: std::io::Error::other("a link name too long"),
    })?;

    // FILE_LINK_INFORMATION is a fixed header plus a trailing variable-length name. Lay it out in a
    // byte buffer: the zeroed header leaves ReplaceIfExists false and RootDirectory null, which is
    // what we want (never clobber, resolve the name against `\??\`).
    let head = std::mem::offset_of!(FILE_LINK_INFORMATION, FileName);
    let length_at = std::mem::offset_of!(FILE_LINK_INFORMATION, FileNameLength);
    let mut buffer = vec![0u8; head + name.len() * 2];
    buffer[length_at..length_at + 4].copy_from_slice(&name_bytes.to_le_bytes());
    for (index, unit) in name.iter().enumerate() {
        let at = head + index * 2;
        buffer[at..at + 2].copy_from_slice(&unit.to_le_bytes());
    }

    let mut iosb = IO_STATUS_BLOCK::default();
    // SAFETY: `source` is a live handle; `buffer` holds a valid FILE_LINK_INFORMATION whose name is
    // `name_bytes` long, and `iosb` is a live local.
    let status = unsafe {
        NtSetInformationFile(
            HANDLE(source.as_raw_handle()),
            &mut iosb,
            buffer.as_ptr().cast(),
            buffer.len() as u32,
            FileLinkInformation,
        )
    };
    if status.0 < 0 {
        // SAFETY: translating a returned NTSTATUS to a Win32 error code.
        let code = unsafe { RtlNtStatusToDosError(status) };
        return Err(LinkError {
            stage: Stage::CreateLink,
            error: std::io::Error::from_raw_os_error(code as i32),
        });
    }
    Ok(())
}
