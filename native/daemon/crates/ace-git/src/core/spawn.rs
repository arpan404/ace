// SPDX-License-Identifier: Apache-2.0
//! Process spawning through `ace-supervisor`, injectable runtime ports,
//! binary discovery (`git-binary.ts`), and tree teardown (`process-runtime.ts`).

use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use tokio::sync::{Notify, mpsc};

use crate::core::error::{CleanupResult, GitError, GitErrorCode};
use crate::core::job::{GitJobPorts, JobScheduler, ScheduleFuture, default_job_ports};

/// Handle returned by [`TimeoutScheduler::schedule`]; calling `cancel` stops the timer.
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

/// Ordered stream and lifecycle events produced by a [`ProcessChild`].
#[derive(Debug, Clone)]
pub enum ProcessEvent {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    StdoutError {
        code: Option<String>,
        message: String,
    },
    StderrError {
        code: Option<String>,
        message: String,
    },
    StdinAck,
    StdinFinish,
    StdinError {
        code: Option<String>,
        message: String,
    },
    SpawnError {
        code: Option<String>,
        message: String,
    },
    Exit {
        code: Option<i32>,
        signal: Option<String>,
        pid: Option<u32>,
    },
    Close {
        code: Option<i32>,
        signal: Option<String>,
    },
}

/// Parameters for spawning one Git (or helper) process.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub detached: bool,
    pub hide_window: bool,
}

/// Boxed `Send` future used across injectable runtime port traits.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Running process handle (either `ace-supervisor::child::SupervisedChild` or bridged JS child).
pub trait ProcessChild: Send + Sync {
    fn pid(&self) -> Option<u32>;
    fn spawn_id(&self) -> Option<u64>;
    fn exited(&self) -> bool;
    fn write_stdin(&self, bytes: Vec<u8>) -> Result<(), String>;
    fn end_stdin(&self);
    fn kill_leader(&self, signal: &str);
    fn signal_group(&self, signal: &str) -> BoxFuture<'_, Result<(), String>>;
    fn group_alive(&self) -> BoxFuture<'_, bool>;
    fn destroy(&self);
    fn exit_notify(&self) -> Arc<Notify>;
}

/// Spawned handle paired with its ordered event stream.
pub struct SpawnedProcess {
    pub child: Arc<dyn ProcessChild>,
    pub events: mpsc::UnboundedReceiver<ProcessEvent>,
}

/// Process spawner port (`GitProcessRuntime.spawn`).
pub trait ProcessSpawner: Send + Sync {
    fn spawn(&self, request: SpawnRequest) -> BoxFuture<'_, SpawnedProcess>;
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

/// Optional injected `locateGit` port (`GitProcessRuntime.locateGit`).
pub trait GitLocatorPort: Send + Sync {
    fn locate_git(
        &self,
        env: Vec<(String, String)>,
        cancel: Arc<AtomicBool>,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send>>;
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
    pub locate_git: Option<Arc<dyn GitLocatorPort>>,
    pub cleanup_supervisor: Option<Arc<dyn CleanupSupervisorPort>>,
    pub job_ports: Option<Arc<dyn GitJobPorts>>,
    pub pid_hook: Option<Arc<dyn Fn(u32, bool) + Send + Sync>>,
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
            locate_git: None,
            cleanup_supervisor: None,
            job_ports: default_job_ports(),
            pid_hook: None,
            runtime,
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

/// Default spawner backed by `ace-supervisor::child::spawn_child`.
pub struct SupervisorSpawner {
    runtime: tokio::runtime::Handle,
}

impl SupervisorSpawner {
    pub fn new(runtime: tokio::runtime::Handle) -> Self {
        Self { runtime }
    }
}

#[derive(Clone)]
struct SupervisorSink {
    tx: mpsc::UnboundedSender<ProcessEvent>,
    exited: Arc<AtomicBool>,
    exit_notify: Arc<Notify>,
    stdin_pending: Arc<AtomicUsize>,
    stdin_ended: Arc<AtomicBool>,
    stdin_finished: Arc<AtomicBool>,
    stdin_errored: Arc<AtomicBool>,
    pid: Arc<std::sync::atomic::AtomicU32>,
}

impl SupervisorSink {
    fn maybe_finish_stdin(&self) {
        if self.stdin_ended.load(Ordering::Acquire)
            && self.stdin_pending.load(Ordering::Acquire) == 0
            && !self.stdin_errored.load(Ordering::Acquire)
            && !self.stdin_finished.swap(true, Ordering::AcqRel)
        {
            let _ = self.tx.send(ProcessEvent::StdinFinish);
        }
    }
}

impl EventSink for SupervisorSink {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        let event = match stream {
            OutputStream::Stdout => ProcessEvent::Stdout(bytes),
            OutputStream::Stderr => ProcessEvent::Stderr(bytes),
        };
        let _ = self.tx.send(event);
        delivered.taken(true);
    }

    fn end(&self, _stream: OutputStream) {}

    fn exit(&self, exit: RawExit) {
        self.exited.store(true, Ordering::Release);
        self.exit_notify.notify_waiters();
        let pid = self.pid.load(Ordering::Acquire);
        let _ = self.tx.send(ProcessEvent::Exit {
            code: exit.code,
            signal: exit.signal,
            pid: (pid != 0).then_some(pid),
        });
    }

    fn close(&self, exit: RawExit) {
        self.exited.store(true, Ordering::Release);
        self.exit_notify.notify_waiters();
        let _ = self.tx.send(ProcessEvent::Close {
            code: exit.code,
            signal: exit.signal,
        });
    }

    fn stdin_written(&self) {
        let prev = self.stdin_pending.fetch_sub(1, Ordering::AcqRel);
        let _ = self.tx.send(ProcessEvent::StdinAck);
        if prev == 1 {
            self.maybe_finish_stdin();
        }
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.stdin_errored.store(true, Ordering::Release);
        let _ = self.tx.send(ProcessEvent::StdinError {
            code: Some(error.code().to_owned()),
            message: format!("write {}", error.code()),
        });
    }

    fn hold_limit(&self) {}

    fn held(&self, _message: String) {}
}

struct SupervisedProcessChild {
    child: SupervisedChild,
    pid: u32,
    exited: Arc<AtomicBool>,
    exit_notify: Arc<Notify>,
    sink: SupervisorSink,
}

impl ProcessChild for SupervisedProcessChild {
    fn pid(&self) -> Option<u32> {
        Some(self.pid)
    }

    fn spawn_id(&self) -> Option<u64> {
        None
    }

    fn exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    fn write_stdin(&self, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.sink.stdin_pending.fetch_add(1, Ordering::AcqRel);
        if let Err(err) = self.child.write_stdin(bytes) {
            self.sink.stdin_pending.fetch_sub(1, Ordering::AcqRel);
            return Err(err.to_string());
        }
        Ok(())
    }

    fn end_stdin(&self) {
        self.sink.stdin_ended.store(true, Ordering::Release);
        self.child.end_stdin();
        self.sink.maybe_finish_stdin();
    }

    fn kill_leader(&self, signal: &str) {
        let sig = parse_signal(signal);
        let _ = self.child.kill(sig);
    }

    fn signal_group(&self, signal: &str) -> BoxFuture<'_, Result<(), String>> {
        let res = {
            #[cfg(unix)]
            {
                let sig = parse_signal(signal);
                self.child
                    .signal_group(sig)
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            }
            #[cfg(not(unix))]
            {
                self.kill_leader(signal);
                Ok(())
            }
        };
        Box::pin(std::future::ready(res))
    }

    fn group_alive(&self) -> BoxFuture<'_, bool> {
        Box::pin(std::future::ready(!self.child.group_gone()))
    }

    fn destroy(&self) {
        self.child.dispose();
    }

    fn exit_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.exit_notify)
    }
}

impl Drop for SupervisedProcessChild {
    fn drop(&mut self) {
        self.child.disown();
    }
}

struct FailedSpawnChild {
    exit_notify: Arc<Notify>,
}

impl ProcessChild for FailedSpawnChild {
    fn pid(&self) -> Option<u32> {
        None
    }
    fn spawn_id(&self) -> Option<u64> {
        None
    }
    fn exited(&self) -> bool {
        true
    }
    fn write_stdin(&self, _bytes: Vec<u8>) -> Result<(), String> {
        Err("spawn failed".to_owned())
    }
    fn end_stdin(&self) {}
    fn kill_leader(&self, _signal: &str) {}
    fn signal_group(&self, _signal: &str) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(std::future::ready(Ok(())))
    }
    fn group_alive(&self) -> BoxFuture<'_, bool> {
        Box::pin(std::future::ready(false))
    }
    fn destroy(&self) {}
    fn exit_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.exit_notify)
    }
}

impl ProcessSpawner for SupervisorSpawner {
    fn spawn(&self, request: SpawnRequest) -> BoxFuture<'_, SpawnedProcess> {
        let (tx, rx) = mpsc::unbounded_channel();
        let exited = Arc::new(AtomicBool::new(false));
        let exit_notify = Arc::new(Notify::new());
        let spec = SpawnSpec {
            command: request.command,
            args: request.args,
            cwd: request.cwd,
            env: request.env,
            windows_verbatim: false,
            hide_window: request.hide_window,
            contain: false,
            max_output_bytes: None,
            stdin: StdioMode::Piped,
            stdout: StdioMode::Piped,
            stderr: StdioMode::Piped,
        };
        let pid_cell = Arc::new(std::sync::atomic::AtomicU32::new(0));
        let sink = SupervisorSink {
            tx: tx.clone(),
            exited: Arc::clone(&exited),
            exit_notify: Arc::clone(&exit_notify),
            stdin_pending: Arc::new(AtomicUsize::new(0)),
            stdin_ended: Arc::new(AtomicBool::new(false)),
            stdin_finished: Arc::new(AtomicBool::new(false)),
            stdin_errored: Arc::new(AtomicBool::new(false)),
            pid: Arc::clone(&pid_cell),
        };
        let out = match spawn_child(&spec, sink.clone(), &self.runtime, None) {
            Ok(child) => {
                let pid = child.pid();
                pid_cell.store(pid, Ordering::Release);
                let handle = Arc::new(SupervisedProcessChild {
                    child,
                    pid,
                    exited,
                    exit_notify,
                    sink,
                });
                SpawnedProcess {
                    child: handle,
                    events: rx,
                }
            }
            Err(err) => {
                let msg = err.to_string();
                let code = infer_spawn_errno(&msg);
                exit_notify.notify_waiters();
                let _ = tx.send(ProcessEvent::SpawnError { code, message: msg });
                let _ = tx.send(ProcessEvent::Close {
                    code: None,
                    signal: None,
                });
                SpawnedProcess {
                    child: Arc::new(FailedSpawnChild { exit_notify }),
                    events: rx,
                }
            }
        };
        Box::pin(std::future::ready(out))
    }
}

fn infer_spawn_errno(message: &str) -> Option<String> {
    if message.contains("os error 2)")
        || message.contains("os error 3)")
        || message.contains("No such file or directory")
        || message.contains("cannot find the file")
        || message.contains("cannot find the path")
    {
        return Some("ENOENT".to_owned());
    }
    if message.contains("os error 13)") || message.contains("Permission denied") {
        return Some("EACCES".to_owned());
    }
    if message.contains("os error 20)") || message.contains("Not a directory") {
        return Some("ENOTDIR".to_owned());
    }
    None
}

fn parse_signal(signal: &str) -> SignalName {
    match signal {
        "SIGTERM" => SignalName::Term,
        _ => SignalName::Kill,
    }
}

/// Wait until the process group led by `child` has no live members, bounded by `ms` (default 3s).
pub async fn group_gone(ports: &ProcessPorts, child: &dyn ProcessChild, ms: u64) {
    let Some(pid) = child.pid() else {
        return;
    };
    if ports.platform == "win32" {
        return;
    }
    const STEP: u64 = 15;
    let mut waited = 0u64;
    while waited < ms {
        if !ports.group_alive(child, pid).await {
            return;
        }
        sleep_with(ports.scheduler.as_ref(), STEP).await;
        waited += STEP;
    }
}

/// Kill the process tree led by `child` using the `platform` port strategy (`process-runtime.ts`).
pub async fn kill_tree(ports: &ProcessPorts, child: Arc<dyn ProcessChild>) {
    if child.exited() {
        if let Some(pid) = child.pid()
            && ports.platform != "win32"
            && ports.group_alive(child.as_ref(), pid).await
        {
            let _ = ports.signal_group(child.as_ref(), pid, "SIGKILL").await;
        }
        return;
    }
    if let Some(pid) = child.pid()
        && ports.platform == "win32"
    {
        let cwd = if cfg!(windows) {
            let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_owned());
            Some(format!("{root}\\System32"))
        } else {
            None
        };
        let spawned = ports
            .spawner
            .spawn(SpawnRequest {
                command: "taskkill".to_owned(),
                args: vec![
                    "/PID".to_owned(),
                    pid.to_string(),
                    "/T".to_owned(),
                    "/F".to_owned(),
                ],
                cwd,
                env: inherited_env_pairs(),
                detached: false,
                hide_window: true,
            })
            .await;
        spawned.child.end_stdin();
        let killer = spawned.child;
        let mut events = spawned.events;
        let timed_out = Arc::new(AtomicBool::new(false));
        let notify = Arc::new(Notify::new());
        let killer_for_timer = Arc::clone(&killer);
        let child_for_timer = Arc::clone(&child);
        let t_flag = Arc::clone(&timed_out);
        let t_notify = Arc::clone(&notify);
        let cancel = ports.scheduler.schedule(
            10_000,
            Box::new(move || {
                t_flag.store(true, Ordering::Release);
                killer_for_timer.kill_leader("SIGKILL");
                child_for_timer.kill_leader("SIGKILL");
                killer_for_timer.destroy();
                t_notify.notify_waiters();
            }),
        );
        loop {
            let expired = notify.notified();
            tokio::pin!(expired);
            expired.as_mut().enable();
            if timed_out.load(Ordering::Acquire) {
                break;
            }
            tokio::select! {
                biased;
                _ = &mut expired => break,
                ev = events.recv() => match ev {
                    Some(ProcessEvent::SpawnError { .. }) => {
                        cancel.cancel();
                        child.kill_leader("SIGKILL");
                        killer.destroy();
                        break;
                    }
                    Some(ProcessEvent::Close { code, .. }) => {
                        cancel.cancel();
                        if code != Some(0) {
                            child.kill_leader("SIGKILL");
                        }
                        break;
                    }
                    None => {
                        cancel.cancel();
                        break;
                    }
                    _ => {}
                }
            }
        }
        return;
    }
    if let Some(pid) = child.pid() {
        if ports
            .signal_group(child.as_ref(), pid, "SIGKILL")
            .await
            .is_err()
        {
            child.kill_leader("SIGKILL");
        }
    } else {
        child.kill_leader("SIGKILL");
    }
}

/// Drain the leader's exit bounded by 1000 ms (`drainProcessExit` in `process-runtime.ts`).
pub async fn drain_process_exit(scheduler: &dyn TimeoutScheduler, child: &dyn ProcessChild) {
    if child.pid().is_none() || child.exited() {
        return;
    }
    let exit_notify = child.exit_notify();
    let done = Arc::new(AtomicBool::new(false));
    let timer_notify = Arc::new(Notify::new());
    let d = Arc::clone(&done);
    let n = Arc::clone(&timer_notify);
    let cancel = scheduler.schedule(
        1_000,
        Box::new(move || {
            d.store(true, Ordering::Release);
            n.notify_waiters();
        }),
    );
    loop {
        let exited = exit_notify.notified();
        tokio::pin!(exited);
        exited.as_mut().enable();
        let expired = timer_notify.notified();
        tokio::pin!(expired);
        expired.as_mut().enable();
        if child.exited() || done.load(Ordering::Acquire) {
            break;
        }
        tokio::select! {
            biased;
            _ = &mut exited => {}
            _ = &mut expired => {}
        }
    }
    cancel.cancel();
}

/// The daemon's environment without `GIT_*` variables (`inheritedEnv` in `cli.ts`).
pub fn inherited_env_pairs() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(k, _)| !k.starts_with("GIT_"))
        .collect()
}

/// Port of `developerToolsGit` in `packages/git/src/git-binary.ts`.
pub async fn developer_tools_git(
    platform: &str,
    env: &[(String, String)],
    cancel: Arc<AtomicBool>,
) -> Option<String> {
    if cancel.load(Ordering::Acquire) {
        return None;
    }
    if platform == "win32" {
        return windows_path_git(env, &cancel);
    }
    if platform != "darwin" {
        return None;
    }
    let path_var = env
        .iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.as_str());
    if first_on_path(path_var, &cancel).as_deref() != Some("/usr/bin/git") {
        return None;
    }
    if cancel.load(Ordering::Acquire) {
        return None;
    }
    let env_owned = env.to_vec();
    let found = tokio::time::timeout(
        Duration::from_secs(10),
        tokio::process::Command::new("/usr/bin/xcrun")
            .args(["--find", "git"])
            .env_clear()
            .envs(env_owned)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if cancel.load(Ordering::Acquire) || !found.status.success() {
        return None;
    }
    let text = std::str::from_utf8(&found.stdout).ok()?.trim().to_owned();
    if text.is_empty()
        || !Path::new(&text).is_absolute()
        || text.contains('\n')
        || text == "/usr/bin/git"
    {
        return None;
    }
    is_executable(&text).then_some(text)
}

fn first_on_path(path_var: Option<&str>, cancel: &AtomicBool) -> Option<String> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    for dir in path_var.unwrap_or("").split(sep) {
        if dir.is_empty() || !Path::new(dir).is_absolute() {
            continue;
        }
        let candidate = Path::new(dir).join("git");
        if is_executable_path(&candidate) {
            return Some(candidate.to_string_lossy().into_owned());
        }
        if cancel.load(Ordering::Acquire) {
            return None;
        }
    }
    None
}

fn windows_path_git(env: &[(String, String)], cancel: &AtomicBool) -> Option<String> {
    let path_var = env
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("PATH"))
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    for dir in path_var.split(';') {
        if cancel.load(Ordering::Acquire) {
            return None;
        }
        let dir = dir.trim().trim_matches('"');
        if dir.is_empty() {
            continue;
        }
        for ext in [".exe", ".com"] {
            let candidate = Path::new(dir).join(format!("git{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn is_executable(path: &str) -> bool {
    is_executable_path(Path::new(path))
}

fn is_executable_path(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// Classify a spawn error into `not_a_repo`, `git_missing`, or `git_failed` (`classifySpawn`).
pub fn classify_spawn_error(
    code: Option<&str>,
    message: &str,
    cwd: &str,
    binary: &str,
) -> GitError {
    if code == Some("ENOENT") && std::fs::metadata(cwd).is_err() {
        return GitError::new(
            GitErrorCode::NotARepo,
            format!("Git working directory no longer exists: {cwd}"),
        );
    }
    if code == Some("ENOENT") {
        GitError::new(
            GitErrorCode::GitMissing,
            format!("Git binary not found: {binary}"),
        )
        .with_detail("binary", ace_json::Value::from(binary))
    } else {
        GitError::new(GitErrorCode::GitFailed, message)
            .with_detail("binary", ace_json::Value::from(binary))
    }
}
