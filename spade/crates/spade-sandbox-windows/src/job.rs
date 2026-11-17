//! A job object holding a run's whole process tree (ADR 0167 decision 1). Closing the last
//! handle kills everything in it, so a dropped run leaves nothing behind. The UI restrictions
//! keep a sandboxed command from driving other windows: no reading the clipboard, no switching
//! desktops, no global atoms, no system-wide settings.

use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
    JOBOBJECT_BASIC_LIMIT_INFORMATION, JOBOBJECT_BASIC_UI_RESTRICTIONS,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectBasicUIRestrictions,
    JobObjectExtendedLimitInformation, SetInformationJobObject,
};

/// What a job holds its tree to.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Most processes alive at once in the tree.
    pub active_processes: u32,
    /// The whole tree's memory ceiling, in bytes.
    pub memory_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            active_processes: 512,
            memory_bytes: 8 * 1024 * 1024 * 1024,
        }
    }
}

/// An unnamed job object. Dropping it (closing the last handle) ends every process in it.
pub struct Job(OwnedHandle);

impl Job {
    /// A fresh job that kills its tree on close, with `limits` and the UI restrictions above.
    pub fn create(limits: Limits) -> std::io::Result<Self> {
        // SAFETY: an unnamed job with default attributes; the handle is owned below.
        let handle =
            unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null()) }.map_err(crate::io)?;
        // SAFETY: a fresh handle this job now owns alone.
        let job = Self(unsafe { OwnedHandle::from_raw_handle(handle.0) });

        let info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT(
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.0
                        | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION.0
                        | JOB_OBJECT_LIMIT_ACTIVE_PROCESS.0
                        | JOB_OBJECT_LIMIT_JOB_MEMORY.0,
                ),
                ActiveProcessLimit: limits.active_processes,
                ..Default::default()
            },
            JobMemoryLimit: limits.memory_bytes,
            ..Default::default()
        };
        // SAFETY: `info` is a live local of the matching class and size.
        unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&info).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(crate::io)?;

        let ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
            UIRestrictionsClass: JOB_OBJECT_UILIMIT(
                JOB_OBJECT_UILIMIT_READCLIPBOARD.0
                    | JOB_OBJECT_UILIMIT_WRITECLIPBOARD.0
                    | JOB_OBJECT_UILIMIT_DESKTOP.0
                    | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS.0
                    | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS.0
                    | JOB_OBJECT_UILIMIT_GLOBALATOMS.0
                    | JOB_OBJECT_UILIMIT_EXITWINDOWS.0
                    | JOB_OBJECT_UILIMIT_HANDLES.0,
            ),
        };
        // SAFETY: `ui` is a live local of the matching class and size.
        unsafe {
            SetInformationJobObject(
                job.raw(),
                JobObjectBasicUIRestrictions,
                std::ptr::from_ref(&ui).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
            )
        }
        .map_err(crate::io)?;
        Ok(job)
    }

    /// Puts the process with handle `process` (and everything it goes on to start) in this job.
    pub fn assign(&self, process: std::os::windows::io::RawHandle) -> std::io::Result<()> {
        // SAFETY: both are live handles; the process isn't yet in any job.
        unsafe { AssignProcessToJobObject(self.raw(), HANDLE(process)) }.map_err(crate::io)
    }

    pub(crate) fn raw(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }

    /// The job handle, kept alive for as long as the run is held.
    pub fn into_handle(self) -> OwnedHandle {
        self.0
    }
}
