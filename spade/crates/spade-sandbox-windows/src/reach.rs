//! What a process can reach outside its own sandbox, beyond files and the network: other
//! processes (to see them, or to end them — Windows' equivalent of signalling them), devices, and
//! named objects. The sandbox tests run these inside an AppContainer to measure what the runner's
//! status may claim (ADR 0167); nothing in Spade's own runs calls them.

use std::os::windows::io::{FromRawHandle, OwnedHandle};

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_GENERIC_READ, FILE_SHARE_READ, FILE_SHARE_WRITE,
    OPEN_EXISTING,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    CreateEventW, OpenEventW, OpenProcess, PROCESS_TERMINATE, SYNCHRONIZATION_SYNCHRONIZE,
};

/// The process ids this process can list.
pub fn visible_processes() -> std::io::Result<Vec<u32>> {
    // SAFETY: a snapshot of every process; the handle is owned just below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }.map_err(crate::io)?;
    // SAFETY: a fresh handle this scope now owns alone.
    let _owned = unsafe { OwnedHandle::from_raw_handle(snapshot.0) };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut pids = Vec::new();
    // SAFETY: `entry` is a live, sized PROCESSENTRY32W; `snapshot` is live.
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        pids.push(entry.th32ProcessID);
        // SAFETY: as above.
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    Ok(pids)
}

/// Whether this process can open process `pid` to end it.
pub fn can_terminate(pid: u32) -> bool {
    // SAFETY: a plain open; a handle that opens is closed at once.
    match unsafe { OpenProcess(PROCESS_TERMINATE, false, pid) } {
        Ok(handle) => {
            // SAFETY: the handle just opened.
            let _ = unsafe { CloseHandle(handle) };
            true
        }
        Err(_) => false,
    }
}

/// Whether this process can open the device `name` (such as `\\.\Beep`) for reading.
pub fn can_open_device(name: &str) -> bool {
    let wide = crate::wide(std::ffi::OsStr::new(name));
    // SAFETY: `wide` is NUL-terminated and outlives the call; a handle that opens is closed.
    match unsafe {
        CreateFileW(
            windows::core::PCWSTR(wide.as_ptr()),
            FILE_GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            None,
        )
    } {
        Ok(handle) => {
            // SAFETY: the handle just opened.
            let _ = unsafe { CloseHandle(handle) };
            true
        }
        Err(_) => false,
    }
}

/// A named event, made here (outside any sandbox), held while the returned handle lives.
pub fn make_event(name: &str) -> std::io::Result<OwnedHandle> {
    let wide = crate::wide(std::ffi::OsStr::new(name));
    // SAFETY: `wide` is NUL-terminated and outlives the call; the handle is owned below.
    let handle: HANDLE =
        unsafe { CreateEventW(None, true, false, windows::core::PCWSTR(wide.as_ptr())) }
            .map_err(crate::io)?;
    // SAFETY: a fresh handle this scope hands over to its owner.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.0) })
}

/// Whether this process can open the named event `name`.
pub fn can_open_event(name: &str) -> bool {
    let wide = crate::wide(std::ffi::OsStr::new(name));
    // SAFETY: `wide` is NUL-terminated and outlives the call; a handle that opens is closed.
    match unsafe {
        OpenEventW(
            SYNCHRONIZATION_SYNCHRONIZE,
            false,
            windows::core::PCWSTR(wide.as_ptr()),
        )
    } {
        Ok(handle) => {
            // SAFETY: the handle just opened.
            let _ = unsafe { CloseHandle(handle) };
            true
        }
        Err(_) => false,
    }
}
