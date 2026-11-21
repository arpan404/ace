// SPDX-License-Identifier: Apache-2.0

//! What names a file on Windows and when it last changed, read from its handle.
//!
//! Stable Rust exposes neither `volume_serial_number`/`file_index` on `Metadata` (still unstable
//! as `windows_by_handle`) nor the change time (`windows_change_time`), and no safe wrapper is
//! available for `GetFileInformationByHandleEx`. Every crate that needs a Windows file identity
//! (ace-files' versions, ace-history's fingerprints) reads it here.

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::io::AsRawHandle;

use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, FILE_BASIC_INFO, FileBasicInfo, GetFileInformationByHandle,
    GetFileInformationByHandleEx,
};

/// The volume serial, the file index and the change time (100 ns ticks since 1601) of the file
/// behind `file`, as libuv reports them for `dev`, `ino` and `ctimeMs`.
#[allow(unsafe_code)]
pub fn handle_facts(file: &impl AsRawHandle) -> std::io::Result<(u64, u64, i64)> {
    let handle = file.as_raw_handle() as HANDLE;
    // SAFETY: both calls only write into zeroed structures of the size they are given, and the
    // handle stays open for the calls because `file` is borrowed for their duration.
    unsafe {
        let mut information: BY_HANDLE_FILE_INFORMATION = zeroed();
        if GetFileInformationByHandle(handle, &mut information) == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut basic: FILE_BASIC_INFO = zeroed();
        if GetFileInformationByHandleEx(
            handle,
            FileBasicInfo,
            std::ptr::from_mut(&mut basic).cast::<c_void>(),
            size_of::<FILE_BASIC_INFO>() as u32,
        ) == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        let index =
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
        Ok((
            u64::from(information.dwVolumeSerialNumber),
            index,
            basic.ChangeTime,
        ))
    }
}
