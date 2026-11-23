// SPDX-License-Identifier: Apache-2.0
//! The kernel side of Windows trees: one Toolhelp snapshot, per-pid
//! identity reads, and ending one proven member.

use super::{
    WindowsIdentified, WindowsLink, WindowsRecord, WindowsSnapshot, WindowsTerminate,
    WindowsTreeOps, WindowsTreeState, windows_tree_state,
};
use crate::errors::SupervisorError;

/// The real Windows tree runtime: one Toolhelp snapshot, then per-PID reads.
pub struct SystemWindowsTree;

impl SystemWindowsTree {
    /// The kernel's tree runtime; windows-sys links kernel32 at build time.
    pub fn new() -> Self {
        Self
    }
}

impl Default for SystemWindowsTree {
    fn default() -> Self {
        Self::new()
    }
}

fn unavailable() -> SupervisorError {
    SupervisorError::Unavailable("kernel process identity unavailable".to_owned())
}

impl WindowsTreeOps for SystemWindowsTree {
    fn state(&self, recorded: &[WindowsRecord]) -> Result<WindowsTreeState, SupervisorError> {
        let snapshot = snapshot_processes()?;
        Ok(windows_tree_state(recorded, &snapshot, &identify_pid))
    }

    #[allow(unsafe_code)]
    fn terminate(&self, member: &WindowsRecord) -> Result<WindowsTerminate, SupervisorError> {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, GetLastError};
        use windows_sys::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE, TerminateProcess, WaitForSingleObject,
        };
        const WAIT_OBJECT_0: u32 = 0;
        // SAFETY: OpenProcess takes plain values and returns a handle or
        // null; a non-null handle is closed exactly once below.
        let handle = unsafe {
            OpenProcess(
                PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                member.pid,
            )
        };
        if handle.is_null() {
            // SAFETY: GetLastError only reads this thread's error slot,
            // right after the call that failed.
            let error = unsafe { GetLastError() };
            return if error == crate::identity::ERROR_INVALID_PARAMETER {
                Ok(WindowsTerminate::Gone)
            } else {
                Err(unavailable())
            };
        }
        let outcome = (|| {
            // Any open handle keeps an exited process openable.
            // SAFETY: `handle` is the live process handle opened above.
            if unsafe { WaitForSingleObject(handle, 0) } == WAIT_OBJECT_0 {
                return Ok(WindowsTerminate::Gone);
            }
            let zero = FILETIME {
                dwLowDateTime: 0,
                dwHighDateTime: 0,
            };
            let (mut creation, mut exit, mut kernel, mut user) = (zero, zero, zero, zero);
            // SAFETY: `handle` has query rights; the FILETIMEs are owned
            // locals the call fills.
            if unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) }
                == 0
            {
                return Err(unavailable());
            }
            let start =
                (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
            // The pid now names another process: the member itself is gone.
            if start.to_string() != member.start {
                return Ok(WindowsTerminate::Gone);
            }
            // SAFETY: `handle` has terminate rights and names the proven member.
            if unsafe { TerminateProcess(handle, 1) } != 0 {
                return Ok(WindowsTerminate::Ended);
            }
            // A process already exiting refuses termination; wait for it.
            // SAFETY: `handle` is still the live handle opened above.
            if unsafe { WaitForSingleObject(handle, 2_000) } == WAIT_OBJECT_0 {
                return Ok(WindowsTerminate::Gone);
            }
            Err(unavailable())
        })();
        // SAFETY: `handle` came from OpenProcess above and is closed once.
        unsafe {
            CloseHandle(handle);
        }
        outcome
    }
}

fn identify_pid(pid: u32) -> WindowsIdentified {
    use crate::identity::{WindowsApi, read_windows_identity};
    let api = match WindowsApi::load() {
        Ok(api) => api,
        Err(_) => return WindowsIdentified::Unknown,
    };
    match read_windows_identity(pid, &api) {
        Ok(Some(identity)) => WindowsIdentified::Found {
            start: identity.start,
            uid: identity.owner,
        },
        Ok(None) => WindowsIdentified::Gone,
        // Unreadable is not absent: a protected process stays unproven.
        Err(_) => WindowsIdentified::Unknown,
    }
}

#[allow(unsafe_code)]
fn snapshot_processes() -> Result<WindowsSnapshot, SupervisorError> {
    use windows_sys::Win32::Foundation::{
        CloseHandle, ERROR_NO_MORE_FILES, FILETIME, GetLastError, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;
    let failed = || SupervisorError::Unavailable("Windows tree snapshot unavailable".to_owned());
    // The precise clock: the coarse one lags by a tick, and a child created
    // just before the snapshot would look created after it.
    let mut clock = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    // SAFETY: the call only writes the owned FILETIME.
    unsafe { GetSystemTimePreciseAsFileTime(&mut clock) };
    let taken =
        ((u64::from(clock.dwHighDateTime) << 32) | u64::from(clock.dwLowDateTime)).to_string();
    // SAFETY: plain values in, a snapshot handle or INVALID_HANDLE_VALUE
    // out; a valid one is closed exactly once below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
        return Err(failed());
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        cntUsage: 0,
        th32ProcessID: 0,
        th32DefaultHeapID: 0,
        th32ModuleID: 0,
        cntThreads: 0,
        th32ParentProcessID: 0,
        pcPriClassBase: 0,
        dwFlags: 0,
        szExeFile: [0; 260],
    };
    let mut processes = Vec::new();
    // SAFETY: `snapshot` is the live snapshot above; `entry` is an owned
    // PROCESSENTRY32W with dwSize set, which each call overwrites.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        processes.push(WindowsLink {
            pid: entry.th32ProcessID,
            parent: entry.th32ParentProcessID,
        });
        // SAFETY: as for Process32FirstW.
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    // SAFETY: read right after the call that ended the walk.
    let last = unsafe { GetLastError() };
    // SAFETY: `snapshot` came from CreateToolhelp32Snapshot and is closed once.
    unsafe {
        CloseHandle(snapshot);
    }
    if last != ERROR_NO_MORE_FILES {
        return Err(failed());
    }
    Ok(WindowsSnapshot { taken, processes })
}
