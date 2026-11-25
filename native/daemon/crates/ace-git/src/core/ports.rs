// SPDX-License-Identifier: Apache-2.0
//! The ports the core is built from: the injected timeout scheduler, group
//! control, cleanup supervisor, running-child registry, environment and the
//! whole runtime (G2a). Every default is native; an injected member is called.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use crate::core::error::CleanupResult;
use crate::core::job::{GitJobPorts, JobScheduler, ScheduleFuture, default_job_ports};
use crate::core::spawn::{ProcessChild, ProcessSpawner, SupervisorSpawner};
use tokio::sync::Notify;

/// Boxed `Send` future used across injectable runtime port traits.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait CancelHandle: Send + Sync {
    fn cancel(&self);
}

/// Injectable timeout scheduler (`GitProcessRuntime.scheduleTimeout`).
pub trait TimeoutScheduler: Send + Sync {
    fn schedule(
        &self,
        milliseconds: u64,
        callback: Box<dyn FnOnce() + Send>,
    ) -> Box<dyn CancelHandle>;
}

/// Default scheduler backed by a `tokio::runtime::Handle` (no global timer).
pub struct TokioScheduler {
    runtime: tokio::runtime::Handle,
}

impl TokioScheduler {
    pub fn new(runtime: tokio::runtime::Handle) -> Self {
        Self { runtime }
    }
}

struct TokioCancel(Mutex<Option<tokio::task::AbortHandle>>);

impl CancelHandle for TokioCancel {
    fn cancel(&self) {
        if let Ok(mut guard) = self.0.lock()
            && let Some(handle) = guard.take()
        {
            handle.abort();
        }
    }
}

impl TimeoutScheduler for TokioScheduler {
    fn schedule(
        &self,
        milliseconds: u64,
        callback: Box<dyn FnOnce() + Send>,
    ) -> Box<dyn CancelHandle> {
        let handle = self.runtime.spawn(async move {
            tokio::time::sleep(Duration::from_millis(milliseconds)).await;
            callback();
        });
        Box::new(TokioCancel(Mutex::new(Some(handle.abort_handle()))))
    }
}

/// Adapter so any [`TimeoutScheduler`] can drive [`JobScheduler`].
pub struct SchedulerAdapter(pub Arc<dyn TimeoutScheduler>);

impl JobScheduler for SchedulerAdapter {
    fn sleep(&self, milliseconds: u64) -> ScheduleFuture {
        let scheduler = Arc::clone(&self.0);
        Box::pin(async move {
            sleep_with(scheduler.as_ref(), milliseconds).await;
        })
    }
}

/// Sleep for `milliseconds` using the injected [`TimeoutScheduler`].
pub async fn sleep_with(scheduler: &dyn TimeoutScheduler, milliseconds: u64) {
    let notify = Arc::new(Notify::new());
    let done = Arc::new(AtomicBool::new(false));
    let n = Arc::clone(&notify);
    let d = Arc::clone(&done);
    let _handle = scheduler.schedule(
        milliseconds,
        Box::new(move || {
            d.store(true, Ordering::Release);
            n.notify_one();
        }),
    );
    crate::core::wake::wait_for_flag(&done, &notify).await;
}

/// Optional injected group control (`GitProcessRuntime.signalGroup` / `groupAlive`).
pub trait GroupPort: Send + Sync {
    fn signal_group(
        &self,
        pid: u32,
        signal: &str,
        spawn_id: Option<u64>,
    ) -> BoxFuture<'_, Result<(), String>>;
    fn group_alive(&self, pid: u32, spawn_id: Option<u64>) -> BoxFuture<'_, bool>;
}

/// Optional injected cleanup supervisor port (`GitProcessRuntime.cleanupSupervisor`).
pub trait CleanupSupervisorPort: Send + Sync {
    fn stop(
        &self,
        spawn_id: u64,
        leases_json: String,
    ) -> Pin<Box<dyn Future<Output = Result<CleanupResult, String>> + Send>>;
}

/// All runtime ports injected into the Git CLI core (no globals).
pub struct ProcessPorts {
    pub platform: String,
    pub spawner: Arc<dyn ProcessSpawner>,
    pub scheduler: Arc<dyn TimeoutScheduler>,
    pub signal_group_override: Option<Arc<dyn GroupPort>>,
    pub group_alive_override: Option<Arc<dyn GroupPort>>,
    pub cleanup_supervisor: Option<Arc<dyn CleanupSupervisorPort>>,
    pub job_ports: Option<Arc<dyn GitJobPorts>>,
    pub pid_hook: Option<Arc<dyn Fn(u32, bool) + Send + Sync>>,
    /// Reports one stdin write reaching the child, so the shell that streams
    /// stdin (`Readable`, as Node's `pipe` does) can resume after pausing.
    pub stdin_ack_hook: Option<Arc<dyn Fn(u64, usize) + Send + Sync>>,
    /// The daemon's environment, read per call: injection point for tests and the shell.
    pub environment: Arc<dyn Fn() -> Vec<(String, String)> + Send + Sync>,
    /// The Git processes this daemon still owns (`runningChildren`), shared across instances.
    pub running_children: Arc<RunningChildren>,
    /// Windows: the private empty directory `core.hooksPath` points at, created on first use.
    pub hooks_dir: Option<Arc<dyn Fn() -> String + Send + Sync>>,
    pub runtime: tokio::runtime::Handle,
}

impl ProcessPorts {
    pub fn native(runtime: tokio::runtime::Handle) -> Self {
        let spawner = Arc::new(SupervisorSpawner::new(runtime.clone()));
        let scheduler = Arc::new(TokioScheduler::new(runtime.clone()));
        Self {
            platform: default_platform().to_owned(),
            spawner,
            scheduler,
            signal_group_override: None,
            group_alive_override: None,
            cleanup_supervisor: None,
            job_ports: default_job_ports(),
            pid_hook: None,
            stdin_ack_hook: None,
            environment: Arc::new(process_environment),
            running_children: Arc::new(RunningChildren::default()),
            hooks_dir: crate::core::cli::default_hooks_dir(),
            runtime,
        }
    }

    pub fn notify_stdin_ack(&self, call_id: u64, bytes: usize) {
        if let Some(ref hook) = self.stdin_ack_hook {
            hook(call_id, bytes);
        }
    }

    pub fn notify_pid(&self, pid: u32, alive: bool) {
        if let Some(ref hook) = self.pid_hook {
            hook(pid, alive);
        }
    }

    pub async fn signal_group(
        &self,
        child: &dyn ProcessChild,
        pid: u32,
        signal: &str,
    ) -> Result<(), String> {
        if let Some(port) = &self.signal_group_override {
            port.signal_group(pid, signal, child.spawn_id()).await
        } else {
            child.signal_group(signal).await
        }
    }

    pub async fn group_alive(&self, child: &dyn ProcessChild, pid: u32) -> bool {
        if let Some(port) = &self.group_alive_override {
            port.group_alive(pid, child.spawn_id()).await
        } else {
            child.group_alive().await
        }
    }
}

/// Current host platform in Node's `process.platform` naming.
pub const fn default_platform() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "darwin"
    }
    #[cfg(target_os = "linux")]
    {
        "linux"
    }
    #[cfg(target_os = "windows")]
    {
        "win32"
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        std::env::consts::OS
    }
}

/// Process-wide live child PID set (`runningChildren` in `git-processes.ts`).
#[derive(Default)]
pub struct RunningChildren {
    pids: Mutex<HashSet<u32>>,
}

impl RunningChildren {
    pub fn add(&self, pid: u32) {
        if let Ok(mut set) = self.pids.lock() {
            set.insert(pid);
        }
    }

    pub fn remove(&self, pid: u32) {
        if let Ok(mut set) = self.pids.lock() {
            set.remove(&pid);
        }
    }

    pub fn snapshot(&self) -> Vec<u32> {
        self.pids
            .lock()
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default()
    }
}

pub fn running_children() -> &'static RunningChildren {
    static CHILDREN: OnceLock<RunningChildren> = OnceLock::new();
    CHILDREN.get_or_init(RunningChildren::default)
}

/// The daemon's whole environment, as node hands it to a child that names no
/// `env` (`process.env`). Git calls filter `GIT_*` out themselves, as
/// `inheritedEnv` in `cli.ts` does; taskkill inherits all of it.
pub fn process_environment() -> Vec<(String, String)> {
    std::env::vars().collect()
}

/// `inheritedEnv`'s rule: no `GIT_*` variable reaches a Git call.
pub fn git_environment(pairs: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    pairs
        .into_iter()
        .filter(|(key, _)| !key.starts_with("GIT_"))
        .collect()
}
