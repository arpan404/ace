// SPDX-License-Identifier: Apache-2.0
//! Windows Job Object containment for Git calls (G2a).
//! Ported from `packages/git/src/git-job.ts`. Platform branches stay inside this shared module.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};

use crate::core::error::CleanupResult;

const POLL_MS: u64 = 50;
/// How long a stop waits for the job to empty before its receipt stays unconfirmed.
const STOP_WAIT_MS: u64 = 10_000;
const SWEEP_ROUNDS: usize = 5;

/// Injectable timer callback used by `GitJob::stop`.
pub type ScheduleFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Delay scheduler port for job stop polling (no global timers).
pub trait JobScheduler: Send + Sync {
    fn sleep(&self, milliseconds: u64) -> ScheduleFuture;
}

/// Process identity recorded for a Windows tree member.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsProcessRecord {
    pub pid: u32,
    pub start: String,
    pub uid: String,
}

/// Result of walking a Windows process tree.
#[derive(Debug, Clone, Default)]
pub struct WindowsTreeState {
    pub live: Vec<WindowsProcessRecord>,
    pub discovered: Vec<WindowsProcessRecord>,
}

/// Injectable Windows Job Object handle (`RetainedJob`).
pub trait RetainedJob: Send + Sync {
    fn assign(&self, pid: u32) -> Result<(), String>;
    fn terminate(&self) -> Result<(), String>;
    fn active_count(&self) -> Result<u32, String>;
    fn release(&self) -> Result<(), String>;
    fn dispose(&self) -> Result<(), String>;
}

/// Injectable Windows process-tree runtime (`WindowsTreeRuntime`).
pub trait WindowsTreeRuntime: Send + Sync {
    fn state(&self, recorded: &[WindowsProcessRecord]) -> Result<WindowsTreeState, String>;
    fn terminate(&self, member: &WindowsProcessRecord) -> Result<(), String>;
    fn identify(&self, pid: u32) -> Option<(String, String)>;
}

/// Injectable native edges for `prepare_job`.
pub trait GitJobPorts: Send + Sync {
    fn create_job(&self) -> Result<Arc<dyn RetainedJob>, String>;
    fn tree(&self) -> Arc<dyn WindowsTreeRuntime>;
}

struct StoppedCall {
    job: Arc<dyn RetainedJob>,
    tree_runtime: Arc<dyn WindowsTreeRuntime>,
    tree: Option<WindowsProcessRecord>,
    recorded: Mutex<Vec<WindowsProcessRecord>>,
    settled: Mutex<bool>,
}

impl StoppedCall {
    fn running(&self) -> bool {
        let Ok(mut settled) = self.settled.lock() else {
            return true;
        };
        if *settled {
            return false;
        }
        let Ok(members) = self.job.active_count() else {
            return true;
        };
        if members > 0 {
            return true;
        }
        if self.tree.is_some() {
            let Ok(mut recorded) = self.recorded.lock() else {
                return true;
            };
            let Ok(state) = self.tree_runtime.state(&recorded) else {
                return true;
            };
            recorded.extend(state.discovered);
            if !state.live.is_empty() {
                for member in &state.live {
                    let _ = self.tree_runtime.terminate(member);
                }
                return true;
            }
        }
        *settled = true;
        let _ = self.job.dispose();
        false
    }
}

/// Tracks stopped jobs per leader PID so `job_alive(pid)` answers whether any still have members.
#[derive(Default)]
pub struct StoppedJobs {
    entries: Mutex<HashMap<u32, Vec<Arc<StoppedCall>>>>,
}

impl StoppedJobs {
    pub fn new() -> Self {
        Self::default()
    }

    fn insert(&self, pid: u32, call: Arc<StoppedCall>) {
        if let Ok(mut map) = self.entries.lock() {
            map.entry(pid).or_default().push(call);
        }
    }

    /// Whether anything of a call ace stopped, led by `pid`, may still be alive.
    pub fn job_alive(&self, pid: u32) -> bool {
        let Ok(mut map) = self.entries.lock() else {
            return false;
        };
        let Some(calls) = map.get_mut(&pid) else {
            return false;
        };
        calls.retain(|call| call.running());
        if calls.is_empty() {
            map.remove(&pid);
            false
        } else {
            true
        }
    }
}

/// Process-wide stopped-job registry matching `git-job.ts`'s `stopped` map.
pub fn global_stopped_jobs() -> &'static StoppedJobs {
    static STOPPED: OnceLock<StoppedJobs> = OnceLock::new();
    STOPPED.get_or_init(StoppedJobs::new)
}

/// Whether anything of a stopped Windows Git job led by `pid` may still be alive.
pub fn job_alive(pid: u32) -> bool {
    global_stopped_jobs().job_alive(pid)
}

/// One Git call's Windows Job Object lifecycle.
pub struct GitJob {
    job: Arc<dyn RetainedJob>,
    ports: Arc<dyn GitJobPorts>,
    stopped_jobs: Arc<StoppedJobs>,
    state: Mutex<GitJobState>,
}

struct GitJobState {
    leader: Option<u32>,
    closed: bool,
}

impl GitJob {
    /// Prepare a job before spawning Git. Returns `None` if Windows cannot create one.
    pub fn prepare(ports: Arc<dyn GitJobPorts>, stopped_jobs: Arc<StoppedJobs>) -> Option<Self> {
        let job = ports.create_job().ok()?;
        Some(Self {
            job,
            ports,
            stopped_jobs,
            state: Mutex::new(GitJobState {
                leader: None,
                closed: false,
            }),
        })
    }

    /// Joins the started leader; `false` when it can't, leaving the taskkill route in charge.
    pub fn adopt(&self, pid: u32) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        if state.closed {
            return false;
        }
        if self.job.assign(pid).is_ok() {
            state.leader = Some(pid);
            true
        } else {
            state.closed = true;
            let _ = self.job.dispose();
            false
        }
    }

    /// Git ended by itself: whatever it left running keeps running.
    pub fn release(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.closed {
            return;
        }
        state.closed = true;
        if self.job.release().is_err() {
            let _ = self.job.dispose();
        }
    }

    /// Ends Git and every descendant, then resolves once nothing of the call is left alive.
    pub async fn stop(&self, scheduler: &dyn JobScheduler) -> CleanupResult {
        let pid = {
            let Ok(mut state) = self.state.lock() else {
                return CleanupResult::Unconfirmed {
                    reason: "Git never joined its job".to_owned(),
                };
            };
            let Some(leader) = state.leader else {
                return CleanupResult::Unconfirmed {
                    reason: "Git never joined its job".to_owned(),
                };
            };
            if state.closed {
                return CleanupResult::Unconfirmed {
                    reason: "Git never joined its job".to_owned(),
                };
            }
            state.closed = true;
            leader
        };

        let tree_runtime = self.ports.tree();
        let tree = tree_runtime
            .identify(pid)
            .map(|(start, uid)| WindowsProcessRecord { pid, start, uid });
        let mut recorded: Vec<WindowsProcessRecord> = tree.iter().cloned().collect();
        let mut seen = HashSet::new();
        let mut outside = Vec::new();
        for _ in 0..SWEEP_ROUNDS {
            if tree.is_none() {
                break;
            }
            let Ok(state) = tree_runtime.state(&recorded) else {
                break;
            };
            recorded.extend(state.discovered);
            let mut found_fresh = false;
            for member in state.live {
                if seen.insert(member.pid) {
                    found_fresh = true;
                    if self.job.assign(member.pid).is_err() {
                        outside.push(member);
                    }
                }
            }
            if !found_fresh {
                break;
            }
        }
        let _ = self.job.terminate();
        for member in &outside {
            let _ = tree_runtime.terminate(member);
        }

        let has_tree = tree.is_some();
        let call = Arc::new(StoppedCall {
            job: Arc::clone(&self.job),
            tree_runtime,
            tree,
            recorded: Mutex::new(recorded),
            settled: Mutex::new(false),
        });
        self.stopped_jobs.insert(pid, Arc::clone(&call));

        let mut waited = 0u64;
        loop {
            if !call.running() {
                let suffix = if has_tree {
                    " and no process it started is alive"
                } else {
                    ""
                };
                return CleanupResult::Confirmed {
                    evidence: format!("The Windows job holding Git process {pid} is empty{suffix}"),
                };
            }
            if waited >= STOP_WAIT_MS {
                return CleanupResult::Unconfirmed {
                    reason: format!("Git process {pid}'s job is not empty yet"),
                };
            }
            waited += POLL_MS;
            scheduler.sleep(POLL_MS).await;
        }
    }
}

impl Drop for GitJob {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock()
            && !state.closed
            && state.leader.is_none()
        {
            state.closed = true;
            let _ = self.job.dispose();
        }
    }
}

#[cfg(windows)]
mod system_windows {
    use super::*;
    use ace_supervisor::contain::{KillOnCloseJob, SystemJobApi};

    pub struct SupervisorRetainedJob(Mutex<KillOnCloseJob<SystemJobApi>>);

    impl RetainedJob for SupervisorRetainedJob {
        fn assign(&self, pid: u32) -> Result<(), String> {
            let mut guard = self.0.lock().map_err(|_| "job lock poisoned".to_owned())?;
            guard.assign(pid).map_err(|e| e.to_string())
        }

        fn terminate(&self) -> Result<(), String> {
            let mut guard = self.0.lock().map_err(|_| "job lock poisoned".to_owned())?;
            guard.terminate().map_err(|e| e.to_string())
        }

        fn active_count(&self) -> Result<u32, String> {
            let guard = self.0.lock().map_err(|_| "job lock poisoned".to_owned())?;
            guard.active_count().map_err(|e| e.to_string())
        }

        fn release(&self) -> Result<(), String> {
            let mut guard = self.0.lock().map_err(|_| "job lock poisoned".to_owned())?;
            guard.dispose().map_err(|e| e.to_string())
        }

        fn dispose(&self) -> Result<(), String> {
            let mut guard = self.0.lock().map_err(|_| "job lock poisoned".to_owned())?;
            guard.dispose().map_err(|e| e.to_string())
        }
    }

    pub struct SystemWindowsTree;

    impl WindowsTreeRuntime for SystemWindowsTree {
        fn state(&self, _recorded: &[WindowsProcessRecord]) -> Result<WindowsTreeState, String> {
            Ok(WindowsTreeState::default())
        }

        fn terminate(&self, _member: &WindowsProcessRecord) -> Result<(), String> {
            Ok(())
        }

        fn identify(&self, _pid: u32) -> Option<(String, String)> {
            None
        }
    }

    pub struct SystemGitJobPorts;

    impl GitJobPorts for SystemGitJobPorts {
        fn create_job(&self) -> Result<Arc<dyn RetainedJob>, String> {
            let job = KillOnCloseJob::create(SystemJobApi).map_err(|e| e.to_string())?;
            Ok(Arc::new(SupervisorRetainedJob(Mutex::new(job))))
        }

        fn tree(&self) -> Arc<dyn WindowsTreeRuntime> {
            Arc::new(SystemWindowsTree)
        }
    }
}

/// Platform default Windows job ports (`Some` only on Windows).
pub fn default_job_ports() -> Option<Arc<dyn GitJobPorts>> {
    #[cfg(windows)]
    {
        Some(Arc::new(system_windows::SystemGitJobPorts))
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct FakeJob {
        active: AtomicU32,
        terminated: Mutex<bool>,
    }

    impl RetainedJob for FakeJob {
        fn assign(&self, _pid: u32) -> Result<(), String> {
            Ok(())
        }
        fn terminate(&self) -> Result<(), String> {
            if let Ok(mut t) = self.terminated.lock() {
                *t = true;
            }
            self.active.store(0, Ordering::SeqCst);
            Ok(())
        }
        fn active_count(&self) -> Result<u32, String> {
            Ok(self.active.load(Ordering::SeqCst))
        }
        fn release(&self) -> Result<(), String> {
            Ok(())
        }
        fn dispose(&self) -> Result<(), String> {
            Ok(())
        }
    }

    struct FakeTree;
    impl WindowsTreeRuntime for FakeTree {
        fn state(&self, _recorded: &[WindowsProcessRecord]) -> Result<WindowsTreeState, String> {
            Ok(WindowsTreeState::default())
        }
        fn terminate(&self, _member: &WindowsProcessRecord) -> Result<(), String> {
            Ok(())
        }
        fn identify(&self, pid: u32) -> Option<(String, String)> {
            Some((format!("start-{pid}"), "sid".to_owned()))
        }
    }

    struct FakePorts(Arc<FakeJob>);
    impl GitJobPorts for FakePorts {
        fn create_job(&self) -> Result<Arc<dyn RetainedJob>, String> {
            Ok(self.0.clone())
        }
        fn tree(&self) -> Arc<dyn WindowsTreeRuntime> {
            Arc::new(FakeTree)
        }
    }

    struct ImmediateScheduler;
    impl JobScheduler for ImmediateScheduler {
        fn sleep(&self, _milliseconds: u64) -> ScheduleFuture {
            Box::pin(async {})
        }
    }

    #[tokio::test]
    async fn stop_confirms_when_job_empties() {
        let fake_job = Arc::new(FakeJob {
            active: AtomicU32::new(1),
            terminated: Mutex::new(false),
        });
        let stopped = Arc::new(StoppedJobs::new());
        let job = GitJob::prepare(Arc::new(FakePorts(fake_job)), Arc::clone(&stopped));
        assert!(job.is_some());
        if let Some(job) = job {
            assert!(job.adopt(42));
            let res = job.stop(&ImmediateScheduler).await;
            assert_eq!(
                res,
                CleanupResult::Confirmed {
                    evidence: "The Windows job holding Git process 42 is empty and no process it started is alive".to_owned(),
                }
            );
            assert!(!stopped.job_alive(42));
        }
    }
}
