// SPDX-License-Identifier: Apache-2.0
//! Process spawning through `ace-supervisor`, injectable runtime ports,
//! binary discovery (`git-binary.ts`), and tree teardown (`process-runtime.ts`).

use std::collections::{HashSet, VecDeque};
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use ace_supervisor::child::{SupervisedChild, spawn_child};
use ace_supervisor::errors::NodeIoError;
use ace_supervisor::pump::Flow;
use ace_supervisor::signal::SignalName;
use ace_supervisor::spawn::{Delivered, EventSink, OutputStream, RawExit, SpawnSpec, StdioMode};
use tokio::sync::Notify;

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

/// A chunk of piped output, with the delivery its stream is waiting on: the
/// queue answers `taken(false)` once it is full, pausing the pump, and resumes
/// it when the consumer takes a chunk. At most `EVENT_QUEUE_CHUNKS` chunks are
/// ever held, so a Git process that writes faster than the core reads cannot
/// queue its whole output in memory.
pub struct OutputChunk {
    pub bytes: Vec<u8>,
    pub delivered: Option<Delivered>,
    /// The stream's flow, so the queue can resume that stream by itself.
    flow: Option<Arc<dyn StreamFlow>>,
}

/// One output stream's flow, behind a trait so a test can watch a resume.
pub trait StreamFlow: Send + Sync {
    fn resume(&self);
}

impl StreamFlow for Flow {
    fn resume(&self) {
        Flow::resume(self);
    }
}

impl std::fmt::Debug for OutputChunk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OutputChunk")
            .field("bytes", &self.bytes.len())
            .field("delivered", &self.delivered.is_some())
            .field("flow", &self.flow.is_some())
            .finish()
    }
}

impl OutputChunk {
    /// A chunk no flow control watches (a bridged JS child's streams).
    pub fn new(bytes: Vec<u8>) -> Self {
        Self {
            bytes,
            delivered: None,
            flow: None,
        }
    }

    /// A chunk the supervisor's pump delivered, with the flow its stream waits on.
    pub fn supervised(bytes: Vec<u8>, delivered: Delivered) -> Self {
        let flow = Some(Arc::clone(&delivered.flow()) as Arc<dyn StreamFlow>);
        Self {
            bytes,
            delivered: Some(delivered),
            flow,
        }
    }

    #[cfg(test)]
    fn with_flow(bytes: Vec<u8>, flow: Arc<dyn StreamFlow>) -> Self {
        Self {
            bytes,
            delivered: None,
            flow: Some(flow),
        }
    }
}

/// How many output chunks the event queue holds before pausing the pump.
pub const EVENT_QUEUE_CHUNKS: usize = 16;

/// The ordered event queue one spawn's consumer reads (`ProcessEvent` stream).
pub struct EventQueue {
    state: Mutex<EventQueueState>,
    notify: Notify,
}

#[derive(Default)]
struct EventQueueState {
    events: VecDeque<ProcessEvent>,
    /// One slot per stream: a full queue pauses each stream once, and each
    /// resumes when the queue has room again. A single slot would let stderr
    /// overwrite stdout's pause and stall the other pipe until its deadline.
    paused_stdout: Option<Arc<dyn StreamFlow>>,
    paused_stderr: Option<Arc<dyn StreamFlow>>,
    closed: bool,
}

impl EventQueueState {
    fn paused_slot(&mut self, stream: OutputStream) -> &mut Option<Arc<dyn StreamFlow>> {
        match stream {
            OutputStream::Stdout => &mut self.paused_stdout,
            OutputStream::Stderr => &mut self.paused_stderr,
        }
    }
}

impl EventQueue {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(EventQueueState::default()),
            notify: Notify::new(),
        })
    }

    /// Queues one output chunk, answering the pump once it is in the queue (or
    /// pausing it when the queue is full).
    pub fn push_output(&self, stream: OutputStream, chunk: OutputChunk) {
        let OutputChunk {
            bytes,
            delivered,
            flow,
        } = chunk;
        // The pump only learns of the pause after the chunk is in the queue.
        let full = {
            let Ok(mut state) = self.state.lock() else {
                return;
            };
            let full = state.events.len() >= EVENT_QUEUE_CHUNKS;
            if full && flow.is_some() {
                *state.paused_slot(stream) = flow.clone();
            }
            let event = match stream {
                OutputStream::Stdout => ProcessEvent::Stdout(OutputChunk {
                    bytes,
                    delivered: None,
                    flow,
                }),
                OutputStream::Stderr => ProcessEvent::Stderr(OutputChunk {
                    bytes,
                    delivered: None,
                    flow,
                }),
            };
            state.events.push_back(event);
            full
        };
        if let Some(delivered) = delivered {
            delivered.taken(!full);
        }
        self.notify.notify_one();
    }

    /// Queues one lifecycle event.
    pub fn push(&self, event: ProcessEvent) {
        if let Ok(mut state) = self.state.lock() {
            state.events.push_back(event);
        }
        self.notify.notify_one();
    }

    /// No event follows: a consumer with an empty queue stops waiting.
    pub fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
        }
        self.notify.notify_one();
    }

    /// The next event in order, or `None` once the stream closed.
    pub async fn recv(&self) -> Option<ProcessEvent> {
        loop {
            let mut resume: Vec<Arc<dyn StreamFlow>> = Vec::new();
            {
                let Ok(mut state) = self.state.lock() else {
                    return None;
                };
                if let Some(event) = state.events.pop_front() {
                    if state.events.len() < EVENT_QUEUE_CHUNKS {
                        resume.extend(state.paused_stdout.take());
                        resume.extend(state.paused_stderr.take());
                    }
                    drop(state);
                    for flow in resume {
                        flow.resume();
                    }
                    return Some(event);
                }
                if state.closed {
                    return None;
                }
            }
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self
                .state
                .lock()
                .is_ok_and(|state| !state.events.is_empty() || state.closed)
            {
                continue;
            }
            notified.await;
        }
    }
}

/// Ordered stream and lifecycle events produced by a [`ProcessChild`].
#[derive(Debug)]
pub enum ProcessEvent {
    Stdout(OutputChunk),
    Stderr(OutputChunk),
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
    pub events: Arc<EventQueue>,
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
            locate_git: None,
            cleanup_supervisor: None,
            job_ports: default_job_ports(),
            pid_hook: None,
            stdin_ack_hook: None,
            environment: Arc::new(inherited_env_pairs),
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
    queue: Arc<EventQueue>,
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
            self.queue.push(ProcessEvent::StdinFinish);
        }
    }
}

impl EventSink for SupervisorSink {
    fn output(&self, stream: OutputStream, bytes: Vec<u8>, delivered: Delivered) {
        self.queue
            .push_output(stream, OutputChunk::supervised(bytes, delivered));
    }

    fn end(&self, _stream: OutputStream) {}

    fn exit(&self, exit: RawExit) {
        self.exited.store(true, Ordering::Release);
        self.exit_notify.notify_waiters();
        let pid = self.pid.load(Ordering::Acquire);
        self.queue.push(ProcessEvent::Exit {
            code: exit.code,
            signal: exit.signal,
            pid: (pid != 0).then_some(pid),
        });
    }

    fn close(&self, exit: RawExit) {
        self.exited.store(true, Ordering::Release);
        self.exit_notify.notify_waiters();
        self.queue.push(ProcessEvent::Close {
            code: exit.code,
            signal: exit.signal,
        });
        self.queue.close();
    }

    fn stdin_written(&self) {
        let prev = self.stdin_pending.fetch_sub(1, Ordering::AcqRel);
        self.queue.push(ProcessEvent::StdinAck);
        if prev == 1 {
            self.maybe_finish_stdin();
        }
    }

    fn stdin_error(&self, error: NodeIoError) {
        self.stdin_errored.store(true, Ordering::Release);
        self.queue.push(ProcessEvent::StdinError {
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
        let queue = EventQueue::new();
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
            queue: Arc::clone(&queue),
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
                    events: queue,
                }
            }
            Err(err) => {
                let msg = err.to_string();
                // The supervisor names node's errno for a spawn the OS refused.
                let code = match &err {
                    ace_supervisor::errors::SupervisorError::SpawnFailed { code, .. } => {
                        code.map(str::to_owned)
                    }
                    _ => None,
                };
                exit_notify.notify_waiters();
                queue.push(ProcessEvent::SpawnError { code, message: msg });
                queue.push(ProcessEvent::Close {
                    code: None,
                    signal: None,
                });
                queue.close();
                SpawnedProcess {
                    child: Arc::new(FailedSpawnChild { exit_notify }),
                    events: queue,
                }
            }
        };
        Box::pin(std::future::ready(out))
    }
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
        let events = spawned.events;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[derive(Default)]
    struct RecordingFlow {
        resumes: AtomicUsize,
    }

    impl StreamFlow for RecordingFlow {
        fn resume(&self) {
            self.resumes.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[tokio::test]
    async fn a_full_queue_pauses_both_streams_and_one_pop_resumes_both() {
        let queue = EventQueue::new();
        let stdout_flow = Arc::new(RecordingFlow::default());
        let stderr_flow = Arc::new(RecordingFlow::default());
        for index in 0..EVENT_QUEUE_CHUNKS {
            queue.push_output(
                OutputStream::Stdout,
                OutputChunk::new(format!("stdout {index}").into_bytes()),
            );
        }
        // The queue is full: each stream's own pause must be kept.
        queue.push_output(
            OutputStream::Stdout,
            OutputChunk::with_flow(
                b"more stdout".to_vec(),
                Arc::clone(&stdout_flow) as Arc<dyn StreamFlow>,
            ),
        );
        queue.push_output(
            OutputStream::Stderr,
            OutputChunk::with_flow(
                b"more stderr".to_vec(),
                Arc::clone(&stderr_flow) as Arc<dyn StreamFlow>,
            ),
        );
        for _ in 0..EVENT_QUEUE_CHUNKS + 2 {
            assert!(queue.recv().await.is_some());
        }
        assert_eq!(stdout_flow.resumes.load(Ordering::SeqCst), 1);
        assert_eq!(stderr_flow.resumes.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn events_come_out_in_the_order_they_were_queued() {
        let queue = EventQueue::new();
        queue.push_output(OutputStream::Stdout, OutputChunk::new(b"one".to_vec()));
        queue.push(ProcessEvent::StdinAck);
        queue.push_output(OutputStream::Stderr, OutputChunk::new(b"two".to_vec()));
        let mut chunks = Vec::new();
        let mut acks = 0;
        for _ in 0..3 {
            match queue.recv().await {
                Some(ProcessEvent::Stdout(chunk)) => {
                    chunks.push(String::from_utf8_lossy(&chunk.bytes).into_owned())
                }
                Some(ProcessEvent::Stderr(chunk)) => {
                    chunks.push(String::from_utf8_lossy(&chunk.bytes).into_owned())
                }
                Some(ProcessEvent::StdinAck) => acks += 1,
                other => panic!("unexpected event: {other:?}"),
            }
        }
        assert_eq!(chunks, vec!["one".to_owned(), "two".to_owned()]);
        assert_eq!(acks, 1);
    }

    #[tokio::test]
    async fn a_closed_queue_ends_the_consumer_once_it_is_empty() {
        let queue = EventQueue::new();
        queue.push_output(OutputStream::Stdout, OutputChunk::new(b"last".to_vec()));
        queue.close();
        assert!(matches!(queue.recv().await, Some(ProcessEvent::Stdout(_))));
        assert!(queue.recv().await.is_none());
    }

    #[tokio::test]
    async fn a_consumer_waiting_on_an_empty_queue_wakes_for_the_next_chunk() {
        let queue = EventQueue::new();
        let consumer = {
            let queue = Arc::clone(&queue);
            tokio::spawn(async move { queue.recv().await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        queue.push_output(OutputStream::Stdout, OutputChunk::new(b"wake".to_vec()));
        let event = tokio::time::timeout(Duration::from_millis(500), consumer)
            .await
            .expect("woken")
            .expect("consumer");
        match event {
            Some(ProcessEvent::Stdout(chunk)) => assert_eq!(chunk.bytes, b"wake"),
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
