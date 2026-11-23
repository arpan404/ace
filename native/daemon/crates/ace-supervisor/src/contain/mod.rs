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

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::{SystemJobApi, resume_suspended};

#[cfg(test)]
mod tests;
