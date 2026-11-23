// SPDX-License-Identifier: Apache-2.0

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
