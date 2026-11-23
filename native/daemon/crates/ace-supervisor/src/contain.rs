// SPDX-License-Identifier: Apache-2.0
//! Containment for spawned trees: process groups on POSIX (leaders own
//! their group, including grandchildren holding the pipes), Job Objects on
//! Windows (the kernel kills every member when the last handle closes, even
//! after a crash). Ports `process-containment.ts`.

use crate::errors::SupervisorError;

/// Whether a joined tree still runs; `None` when nothing joined the job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobRunning {
    /// A joined job's live member count says so.
    Running(bool),
    /// Nothing joined the job.
    Unjoined,
}

/// Kernel containment for one Windows tree. Optional: any failure leaves the
/// taskkill tree stop in charge.
pub trait WindowsJob: Send + Sync {
    /// Joins `pid` to the job; a failing join never throws.
    fn assign(&mut self, pid: u32);
    /// Whether the joined tree still has members; unjoined or unreadable.
    fn running(&mut self) -> JobRunning;
    /// Ends every joined member now; never throws.
    fn terminate(&mut self);
    /// Closes the job; best effort during process exit.
    fn dispose(&mut self);
}

/// The raw Win32 surface behind a job. Tests inject a fake; production
/// binds kernel32 through windows-sys.
pub trait WindowsJobApi {
    /// Creates the job; a null handle fails creation.
    fn create(&mut self) -> JobHandle;
    /// Arms kill-on-close; false fails setup.
    fn set_kill_on_close(&mut self, job: JobHandle) -> bool;
    /// Clears every limit so members outlive the job's last handle.
    fn clear_limits(&mut self, job: JobHandle) -> bool;
    /// Opens the process with terminate rights; a null handle fails the join.
    fn open_process(&mut self, pid: u32) -> ProcHandle;
    /// Joins the opened process to the job.
    fn assign_process(&mut self, job: JobHandle, target: ProcHandle) -> bool;
    /// Closes either handle; a failed close keeps ownership for a retry.
    fn close(&mut self, handle: CloseHandle) -> Result<(), SupervisorError>;
    /// Unloads the bound library; a failed unload keeps it for a retry.
    fn unload(&mut self) -> Result<(), SupervisorError>;
    /// Live members of the job.
    fn active_count(&mut self, job: JobHandle) -> u32;
    /// Terminates every member.
    fn terminate(&mut self, job: JobHandle);
}

/// An opaque job handle; null fails creation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JobHandle(pub u64);

/// An opaque process handle; null fails the join.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcHandle(pub u64);

/// Either handle, for closing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseHandle {
    Job(JobHandle),
    Process(ProcHandle),
}

/// Required containment: setup, assignment and inspection failures stay
/// visible. Mirrors `createRetainedJob`.
pub struct RetainedJob<A> {
    api: A,
    job: JobHandle,
    handle_closed: bool,
    unloaded: bool,
}

impl<A: WindowsJobApi> RetainedJob<A> {
    /// Creates and arms the job; closes what setup opened on failure.
    pub fn create(mut api: A) -> Result<Self, SupervisorError> {
        let job = api.create();
        if job == JobHandle(0) {
            let _ = api.unload();
            return Err(SupervisorError::Operation(
                "Windows job creation failed".to_owned(),
            ));
        }
        if !api.set_kill_on_close(job) {
            let _ = api.close(CloseHandle::Job(job));
            let _ = api.unload();
            return Err(SupervisorError::Operation(
                "Windows job setup failed".to_owned(),
            ));
        }
        Ok(Self {
            api,
            job,
            handle_closed: false,
            unloaded: false,
        })
    }

    fn open(&self) -> Result<JobHandle, SupervisorError> {
        if self.handle_closed {
            return Err(SupervisorError::Closed);
        }
        Ok(self.job)
    }

    /// Joins `pid` to the job.
    pub fn assign(&mut self, pid: u32) -> Result<(), SupervisorError> {
        let job = self.open()?;
        let target = self.api.open_process(pid);
        if target == ProcHandle(0) {
            return Err(SupervisorError::Operation(
                "Windows job assignment failed".to_owned(),
            ));
        }
        let joined = self.api.assign_process(job, target);
        let _ = self.api.close(CloseHandle::Process(target));
        if !joined {
            return Err(SupervisorError::Operation(
                "Windows job assignment failed".to_owned(),
            ));
        }
        Ok(())
    }

    /// Live members of the job.
    pub fn active_count(&mut self) -> Result<u32, SupervisorError> {
        let job = self.open()?;
        Ok(self.api.active_count(job))
    }

    /// Terminates every member.
    pub fn terminate(&mut self) -> Result<(), SupervisorError> {
        let job = self.open()?;
        self.api.terminate(job);
        Ok(())
    }

    /// Lets the current members outlive the job, as if never joined.
    pub fn release(&mut self) -> Result<(), SupervisorError> {
        let job = self.open()?;
        if !self.api.clear_limits(job) {
            return Err(SupervisorError::Operation(
                "Windows job release failed".to_owned(),
            ));
        }
        let _ = self.dispose();
        Ok(())
    }

    /// Closes the job; a failed close or unload keeps the rest for a retry
    /// without double-closing.
    pub fn dispose(&mut self) -> Result<(), SupervisorError> {
        if !self.handle_closed {
            self.api.close(CloseHandle::Job(self.job))?;
            self.handle_closed = true;
        }
        if !self.unloaded {
            self.api.unload()?;
            self.unloaded = true;
        }
        Ok(())
    }
}

/// Optional containment: any failure leaves the tree stop in charge.
pub struct KillOnCloseJob<A> {
    inner: Option<RetainedJob<A>>,
    joined: bool,
}

impl<A: WindowsJobApi> KillOnCloseJob<A> {
    /// Creates the job; `None` when setup failed.
    pub fn create(api: A) -> Option<Self> {
        RetainedJob::create(api).ok().map(|inner| Self {
            inner: Some(inner),
            joined: false,
        })
    }
}

impl<A: WindowsJobApi + Send + Sync> WindowsJob for KillOnCloseJob<A> {
    fn assign(&mut self, pid: u32) {
        if self
            .inner
            .as_mut()
            .is_some_and(|inner| inner.assign(pid).is_ok())
        {
            self.joined = true;
        }
    }

    fn running(&mut self) -> JobRunning {
        if !self.joined {
            return JobRunning::Unjoined;
        }
        match self.inner.as_mut().map(RetainedJob::active_count) {
            Some(Ok(count)) => JobRunning::Running(count > 0),
            // An unreadable job cannot prove the tree is gone.
            Some(Err(_)) | None => JobRunning::Unjoined,
        }
    }

    fn terminate(&mut self) {
        if self.joined
            && let Some(inner) = self.inner.as_mut()
        {
            let _ = inner.terminate();
        }
    }

    fn dispose(&mut self) {
        if let Some(inner) = &mut self.inner {
            let _ = inner.dispose();
        }
    }
}

/// The real Win32 job surface, through windows-sys. Handles cross the
/// trait as integers and become `HANDLE` pointers only here; every call into
/// Win32 is an `unsafe` block that says why it holds.
#[cfg(windows)]
pub struct SystemJobApi;

#[cfg(windows)]
impl SystemJobApi {
    /// The kernel's job surface; windows-sys links kernel32 at build time.
    pub fn new() -> Self {
        Self
    }
}

#[cfg(windows)]
impl Default for SystemJobApi {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(windows)]
fn win_handle(raw: u64) -> windows_sys::Win32::Foundation::HANDLE {
    raw as usize as windows_sys::Win32::Foundation::HANDLE
}

#[cfg(windows)]
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

#[cfg(windows)]
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
#[cfg(windows)]
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

#[cfg(test)]
mod tests {
    use super::*;

    struct State {
        held: bool,
        process_held: bool,
        loaded: bool,
        members: u32,
        close_fails: bool,
        unload_fails: bool,
    }

    struct FakeApi {
        state: std::sync::Arc<std::sync::Mutex<State>>,
        arm: bool,
        join: bool,
        handle: Option<u64>,
    }

    impl FakeApi {
        fn new() -> (Self, std::sync::Arc<std::sync::Mutex<State>>) {
            let state = std::sync::Arc::new(std::sync::Mutex::new(State {
                held: false,
                process_held: false,
                loaded: true,
                members: 0,
                close_fails: false,
                unload_fails: false,
            }));
            (
                Self {
                    state: std::sync::Arc::clone(&state),
                    arm: true,
                    join: true,
                    handle: Some(7),
                },
                state,
            )
        }

        fn with(
            arm: bool,
            join: bool,
            handle: Option<u64>,
        ) -> (Self, std::sync::Arc<std::sync::Mutex<State>>) {
            let (mut api, state) = Self::new();
            api.arm = arm;
            api.join = join;
            api.handle = handle;
            (api, state)
        }
    }

    impl WindowsJobApi for FakeApi {
        fn create(&mut self) -> JobHandle {
            let handle = self.handle.map(JobHandle).unwrap_or(JobHandle(0));
            self.state.lock().expect("fake state").held = handle != JobHandle(0);
            handle
        }

        fn set_kill_on_close(&mut self, _job: JobHandle) -> bool {
            self.arm
        }

        fn clear_limits(&mut self, _job: JobHandle) -> bool {
            true
        }

        fn open_process(&mut self, _pid: u32) -> ProcHandle {
            self.state.lock().expect("fake state").process_held = true;
            ProcHandle(9)
        }

        fn assign_process(&mut self, _job: JobHandle, _target: ProcHandle) -> bool {
            if self.join {
                self.state.lock().expect("fake state").members += 1;
            }
            self.join
        }

        fn close(&mut self, handle: CloseHandle) -> Result<(), SupervisorError> {
            if self.state.lock().expect("fake state").close_fails {
                return Err(SupervisorError::Operation("close denied".to_owned()));
            }
            match handle {
                CloseHandle::Process(_) => {
                    self.state.lock().expect("fake state").process_held = false;
                }
                CloseHandle::Job(_) => {
                    let mut state = self.state.lock().expect("fake state");
                    state.held = false;
                    state.members = 0;
                }
            }
            Ok(())
        }

        fn unload(&mut self) -> Result<(), SupervisorError> {
            if self.state.lock().expect("fake state").unload_fails {
                return Err(SupervisorError::Operation("unload denied".to_owned()));
            }
            self.state.lock().expect("fake state").loaded = false;
            Ok(())
        }

        fn active_count(&mut self, _job: JobHandle) -> u32 {
            self.state.lock().expect("fake state").members
        }

        fn terminate(&mut self, _job: JobHandle) {
            self.state.lock().expect("fake state").members = 0;
        }
    }

    #[test]
    fn retained_job_owns_descendants_until_termination() {
        let (api, state) = FakeApi::new();
        let mut job = RetainedJob::create(api).expect("job creates");
        job.assign(4242).expect("leader joins");
        // The leader exits; one descendant remains.
        state.lock().expect("fake state").members = 1;
        assert_eq!(job.active_count(), Ok(1));
        assert!(!state.lock().expect("fake state").process_held);
        job.terminate().expect("termination succeeds");
        assert_eq!(job.active_count(), Ok(0));
        job.dispose().expect("dispose succeeds");
        assert!(!state.lock().expect("fake state").held);
        assert!(!state.lock().expect("fake state").loaded);
    }

    #[test]
    fn denied_assignment_is_visible_and_releases_the_process_handle() {
        let (api, state) = FakeApi::with(true, false, Some(7));
        let mut job = RetainedJob::create(api).expect("job creates");
        assert!(job.assign(4242).is_err());
        assert!(!state.lock().expect("fake state").process_held);
        assert_eq!(job.active_count(), Ok(0));
        job.dispose().expect("dispose succeeds");
    }

    #[test]
    fn failed_setup_closes_the_created_handle_and_unloads() {
        let (api, state) = FakeApi::with(false, true, Some(7));
        assert!(RetainedJob::create(api).is_err());
        assert!(!state.lock().expect("fake state").held);
        assert!(!state.lock().expect("fake state").loaded);
    }

    #[test]
    fn null_handle_cannot_masquerade_as_containment() {
        let (api, state) = FakeApi::with(true, true, None);
        assert!(RetainedJob::create(api).is_err());
        assert!(!state.lock().expect("fake state").held);
        assert!(!state.lock().expect("fake state").loaded);
    }

    #[test]
    fn failed_close_keeps_ownership_for_a_shutdown_retry() {
        let (api, state) = FakeApi::new();
        state.lock().expect("fake state").close_fails = true;
        let mut job = RetainedJob::create(api).expect("job creates");
        job.assign(4242).expect("leader joins");
        assert!(job.dispose().is_err());
        assert!(state.lock().expect("fake state").held);
        assert!(state.lock().expect("fake state").loaded);
        assert_eq!(job.active_count(), Ok(1));
        state.lock().expect("fake state").close_fails = false;
        job.dispose().expect("retry succeeds");
        job.dispose().expect("second dispose is a no-op");
        assert!(!state.lock().expect("fake state").held);
        assert!(!state.lock().expect("fake state").loaded);
        assert!(job.assign(4242).is_err());
    }

    #[test]
    fn failed_unload_retries_without_reopening_or_double_closing() {
        let (api, state) = FakeApi::new();
        state.lock().expect("fake state").unload_fails = true;
        let mut job = RetainedJob::create(api).expect("job creates");
        assert!(job.dispose().is_err());
        assert!(!state.lock().expect("fake state").held);
        assert!(state.lock().expect("fake state").loaded);
        assert!(job.active_count().is_err());
        state.lock().expect("fake state").unload_fails = false;
        job.dispose().expect("retry succeeds");
        assert!(!state.lock().expect("fake state").loaded);
    }

    #[test]
    fn optional_containment_keeps_the_tree_fallback() {
        let (failed, failed_state) = FakeApi::with(false, true, Some(7));
        assert!(KillOnCloseJob::create(failed).is_none());
        assert!(!failed_state.lock().expect("fake state").held);
        let (denied, _) = FakeApi::with(true, false, Some(7));
        let mut job = KillOnCloseJob::create(denied).expect("job creates");
        job.assign(4242);
        assert_eq!(job.running(), JobRunning::Unjoined);
        job.dispose();
    }
}
