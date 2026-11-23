// SPDX-License-Identifier: Apache-2.0
//! The kernel side of Windows containment: the Job Object calls behind
//! `WindowsJobApi`, and resuming a child that joined its job suspended.

use super::{CloseHandle, JobHandle, ProcHandle, WindowsJobApi};
use crate::errors::SupervisorError;

/// The real Win32 job surface, through windows-sys. Handles cross the
/// trait as integers and become `HANDLE` pointers only here; every call into
/// Win32 is an `unsafe` block that says why it holds.
pub struct SystemJobApi;

impl SystemJobApi {
    /// The kernel's job surface; windows-sys links kernel32 at build time.
    pub fn new() -> Self {
        Self
    }
}

impl Default for SystemJobApi {
    fn default() -> Self {
        Self::new()
    }
}

fn win_handle(raw: u64) -> windows_sys::Win32::Foundation::HANDLE {
    raw as usize as windows_sys::Win32::Foundation::HANDLE
}

fn set_limits(job: JobHandle, flags: u32) -> bool {
    use windows_sys::Win32::System::JobObjects::{
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    };
    // SAFETY: JOBOBJECT_EXTENDED_LIMIT_INFORMATION is plain data; all
    // zeroes is "no limits".
    #[allow(unsafe_code)]
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    info.BasicLimitInformation.LimitFlags = flags;
    // SAFETY: `job` is a live job handle; `info` is an owned struct of
    // exactly the size passed, which the call only reads.
    #[allow(unsafe_code)]
    let set = unsafe {
        SetInformationJobObject(
            win_handle(job.0),
            JobObjectExtendedLimitInformation,
            (&raw const info).cast::<core::ffi::c_void>(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    set != 0
}

#[allow(unsafe_code)]
impl WindowsJobApi for SystemJobApi {
    fn create(&mut self) -> JobHandle {
        use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
        // SAFETY: no security attributes and no name; the call returns a
        // new handle or null, and a non-null one is closed through `close`.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        JobHandle(job as usize as u64)
    }

    fn set_kill_on_close(&mut self, job: JobHandle) -> bool {
        use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        set_limits(job, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)
    }

    fn clear_limits(&mut self, job: JobHandle) -> bool {
        set_limits(job, 0)
    }

    fn open_process(&mut self, pid: u32) -> ProcHandle {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        // SAFETY: plain values in, a handle or null out; a non-null one is
        // closed through `close` right after the assignment.
        let opened = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        ProcHandle(opened as usize as u64)
    }

    fn assign_process(&mut self, job: JobHandle, target: ProcHandle) -> bool {
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        // SAFETY: both handles are live: the job from `create`, the process
        // from `open_process` with PROCESS_SET_QUOTA | PROCESS_TERMINATE.
        unsafe { AssignProcessToJobObject(win_handle(job.0), win_handle(target.0)) != 0 }
    }

    fn close(&mut self, handle: CloseHandle) -> Result<(), SupervisorError> {
        let raw = match handle {
            CloseHandle::Job(job) => job.0,
            CloseHandle::Process(process) => process.0,
        };
        // SAFETY: `raw` is a handle this API opened, and callers close each
        // one once (`RetainedJob` tracks `handle_closed`).
        if unsafe { windows_sys::Win32::Foundation::CloseHandle(win_handle(raw)) } == 0 {
            return Err(SupervisorError::Operation(
                "Windows handle close failed".to_owned(),
            ));
        }
        Ok(())
    }

    fn unload(&mut self) -> Result<(), SupervisorError> {
        Ok(())
    }

    fn active_count(&mut self, job: JobHandle) -> u32 {
        use windows_sys::Win32::System::JobObjects::{
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JobObjectBasicAccountingInformation,
            QueryInformationJobObject,
        };
        // SAFETY: plain data; the call overwrites it.
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: `job` is a live job handle; `info` is an owned struct of
        // exactly the size passed, and no returned length is asked for.
        let read = unsafe {
            QueryInformationJobObject(
                win_handle(job.0),
                JobObjectBasicAccountingInformation,
                (&raw mut info).cast::<core::ffi::c_void>(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                std::ptr::null_mut(),
            )
        };
        if read == 0 {
            return 0;
        }
        info.ActiveProcesses
    }

    fn terminate(&mut self, job: JobHandle) {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: `job` is a live job handle; the call ends its members.
        unsafe {
            TerminateJobObject(win_handle(job.0), 1);
        }
    }
}

/// Resumes every thread of a process created suspended, once it is in its
/// job: it runs no instruction outside containment. Toolhelp lists the
/// threads, since the spawn hands back no thread handle.
#[allow(unsafe_code)]
pub fn resume_suspended(pid: u32) -> Result<(), SupervisorError> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    let failed = || SupervisorError::Operation(format!("could not resume process {pid}"));
    // SAFETY: plain values in, a snapshot handle or INVALID_HANDLE_VALUE
    // out; a valid one is closed once below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
        return Err(failed());
    }
    // SAFETY: plain data; dwSize is set before the walk reads it.
    let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
    let mut resumed = 0u32;
    let mut broken = false;
    // SAFETY: `snapshot` is live; `entry` is an owned THREADENTRY32 with
    // dwSize set, which each call overwrites.
    let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
    while ok != 0 {
        if entry.th32OwnerProcessID == pid {
            // SAFETY: plain values in, a handle or null out; a non-null one
            // is closed right after the resume.
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                broken = true;
            } else {
                // SAFETY: `thread` is live with THREAD_SUSPEND_RESUME.
                if unsafe { ResumeThread(thread) } == u32::MAX {
                    broken = true;
                } else {
                    resumed += 1;
                }
                // SAFETY: `thread` came from OpenThread and is closed once.
                unsafe {
                    CloseHandle(thread);
                }
            }
        }
        // SAFETY: as for Thread32First.
        ok = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    // SAFETY: `snapshot` came from CreateToolhelp32Snapshot; closed once.
    unsafe {
        CloseHandle(snapshot);
    }
    if broken || resumed == 0 {
        return Err(failed());
    }
    Ok(())
}
