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
pub trait WindowsJob {
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

impl<A: WindowsJobApi> WindowsJob for KillOnCloseJob<A> {
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
        if self.joined && let Some(inner) = self.inner.as_mut() {
            let _ = inner.terminate();
        }
    }

    fn dispose(&mut self) {
        if let Some(inner) = &mut self.inner {
            let _ = inner.dispose();
        }
    }
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
        state: std::rc::Rc<std::cell::RefCell<State>>,
        arm: bool,
        join: bool,
        handle: Option<u64>,
    }

    impl FakeApi {
        fn new() -> (Self, std::rc::Rc<std::cell::RefCell<State>>) {
            let state = std::rc::Rc::new(std::cell::RefCell::new(State {
                held: false,
                process_held: false,
                loaded: true,
                members: 0,
                close_fails: false,
                unload_fails: false,
            }));
            (
                Self {
                    state: std::rc::Rc::clone(&state),
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
        ) -> (Self, std::rc::Rc<std::cell::RefCell<State>>) {
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
            self.state.borrow_mut().held = handle != JobHandle(0);
            handle
        }

        fn set_kill_on_close(&mut self, _job: JobHandle) -> bool {
            self.arm
        }

        fn clear_limits(&mut self, _job: JobHandle) -> bool {
            true
        }

        fn open_process(&mut self, _pid: u32) -> ProcHandle {
            self.state.borrow_mut().process_held = true;
            ProcHandle(9)
        }

        fn assign_process(&mut self, _job: JobHandle, _target: ProcHandle) -> bool {
            if self.join {
                self.state.borrow_mut().members += 1;
            }
            self.join
        }

        fn close(&mut self, handle: CloseHandle) -> Result<(), SupervisorError> {
            if self.state.borrow().close_fails {
                return Err(SupervisorError::Operation("close denied".to_owned()));
            }
            match handle {
                CloseHandle::Process(_) => {
                    self.state.borrow_mut().process_held = false;
                }
                CloseHandle::Job(_) => {
                    let mut state = self.state.borrow_mut();
                    state.held = false;
                    state.members = 0;
                }
            }
            Ok(())
        }

        fn unload(&mut self) -> Result<(), SupervisorError> {
            if self.state.borrow().unload_fails {
                return Err(SupervisorError::Operation("unload denied".to_owned()));
            }
            self.state.borrow_mut().loaded = false;
            Ok(())
        }

        fn active_count(&mut self, _job: JobHandle) -> u32 {
            self.state.borrow().members
        }

        fn terminate(&mut self, _job: JobHandle) {
            self.state.borrow_mut().members = 0;
        }
    }

    #[test]
    fn retained_job_owns_descendants_until_termination() {
        let (api, state) = FakeApi::new();
        let mut job = RetainedJob::create(api).expect("job creates");
        job.assign(4242).expect("leader joins");
        // The leader exits; one descendant remains.
        state.borrow_mut().members = 1;
        assert_eq!(job.active_count(), Ok(1));
        assert!(!state.borrow().process_held);
        job.terminate().expect("termination succeeds");
        assert_eq!(job.active_count(), Ok(0));
        job.dispose().expect("dispose succeeds");
        assert!(!state.borrow().held);
        assert!(!state.borrow().loaded);
    }

    #[test]
    fn denied_assignment_is_visible_and_releases_the_process_handle() {
        let (api, state) = FakeApi::with(true, false, Some(7));
        let mut job = RetainedJob::create(api).expect("job creates");
        assert!(job.assign(4242).is_err());
        assert!(!state.borrow().process_held);
        assert_eq!(job.active_count(), Ok(0));
        job.dispose().expect("dispose succeeds");
    }

    #[test]
    fn failed_setup_closes_the_created_handle_and_unloads() {
        let (api, state) = FakeApi::with(false, true, Some(7));
        assert!(RetainedJob::create(api).is_err());
        assert!(!state.borrow().held);
        assert!(!state.borrow().loaded);
    }

    #[test]
    fn null_handle_cannot_masquerade_as_containment() {
        let (api, state) = FakeApi::with(true, true, None);
        assert!(RetainedJob::create(api).is_err());
        assert!(!state.borrow().held);
        assert!(!state.borrow().loaded);
    }

    #[test]
    fn failed_close_keeps_ownership_for_a_shutdown_retry() {
        let (api, state) = FakeApi::new();
        state.borrow_mut().close_fails = true;
        let mut job = RetainedJob::create(api).expect("job creates");
        job.assign(4242).expect("leader joins");
        assert!(job.dispose().is_err());
        assert!(state.borrow().held);
        assert!(state.borrow().loaded);
        assert_eq!(job.active_count(), Ok(1));
        state.borrow_mut().close_fails = false;
        job.dispose().expect("retry succeeds");
        job.dispose().expect("second dispose is a no-op");
        assert!(!state.borrow().held);
        assert!(!state.borrow().loaded);
        assert!(job.assign(4242).is_err());
    }

    #[test]
    fn failed_unload_retries_without_reopening_or_double_closing() {
        let (api, state) = FakeApi::new();
        state.borrow_mut().unload_fails = true;
        let mut job = RetainedJob::create(api).expect("job creates");
        assert!(job.dispose().is_err());
        assert!(!state.borrow().held);
        assert!(state.borrow().loaded);
        assert!(job.active_count().is_err());
        state.borrow_mut().unload_fails = false;
        job.dispose().expect("retry succeeds");
        assert!(!state.borrow().loaded);
    }

    #[test]
    fn optional_containment_keeps_the_tree_fallback() {
        let (failed, failed_state) = FakeApi::with(false, true, Some(7));
        assert!(KillOnCloseJob::create(failed).is_none());
        assert!(!failed_state.borrow().held);
        let (denied, _) = FakeApi::with(true, false, Some(7));
        let mut job = KillOnCloseJob::create(denied).expect("job creates");
        job.assign(4242);
        assert_eq!(job.running(), JobRunning::Unjoined);
        job.dispose();
    }
}
