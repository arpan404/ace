// SPDX-License-Identifier: Apache-2.0
//! The supervisor binding: values in, events out, never logic. Spawning,
//! inventory, journals, identity and stops cross here as JSON; behaviour
//! lives in `ace-supervisor`.

use ace_supervisor::entries::EntryPlatform;
use ace_supervisor::spawn::{ChildEvent, EventSink, RawExit, SpawnSpec, StdioMode, StopRequest};
#[cfg(target_os = "linux")]
use ace_supervisor::listing::LinuxWalk;
use ace_supervisor::signal::SignalIo as _;
use ace_supervisor::{identity, inventory, journal, listing, owner, recover, reaper, signal, stop, tree};
use napi::bindgen_prelude::{FnArgs, Uint8Array};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
#[cfg(target_os = "linux")]
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, OnceLock};

/// The addon's tokio runtime (two workers): pumps, waiters and stop tasks.
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

fn runtime() -> napi::Result<&'static tokio::runtime::Runtime> {
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }
    match tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("ace-supervisor")
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            let _ = RUNTIME.set(runtime);
            RUNTIME
                .get()
                .ok_or_else(|| napi::Error::from_reason("supervisor runtime failed to start"))
        }
        Err(error) => Err(napi::Error::from_reason(format!(
            "supervisor runtime failed to start: {error}"
        ))),
    }
}

fn bind_error(error: ace_supervisor::errors::SupervisorError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

fn unwind(context: &str) -> napi::Error {
    napi::Error::from_reason(format!("{context} panicked"))
}

/// Byte events to the shell, in arrival order, over one threadsafe function.
#[derive(Clone)]
struct TsfnSink {
    sink: Arc<ThreadsafeFunction<FnArgs<(String, Uint8Array)>>>,
}

impl EventSink for TsfnSink {
    fn emit(&self, event: ChildEvent) {
        let (kind, data) = match event {
            ChildEvent::Stdout(bytes) => ("stdout", bytes),
            ChildEvent::Stderr(bytes) => ("stderr", bytes),
            ChildEvent::Exit(exit) => (
                "exit",
                format!(
                    "{{\"code\":{},\"signal\":{}}}",
                    exit.code
                        .map(|code| code.to_string())
                        .unwrap_or_else(|| "null".to_owned()),
                    exit.signal
                        .as_ref()
                        .map(|signal| format!("\"{signal}\""))
                        .unwrap_or_else(|| "null".to_owned()),
                )
                .into_bytes(),
            ),
            ChildEvent::StdinError(message) => ("stdin-error", message.into_bytes()),
            ChildEvent::TreeGone => ("tree-gone", Vec::new()),
            ChildEvent::StopFailed(message) => ("stop-failed", message.into_bytes()),
        };
        let _ = self.sink.call(
            Ok(FnArgs::from((kind.to_owned(), Uint8Array::new(data)))),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

#[derive(Debug, serde::Deserialize)]
struct SpecJson {
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    env: Vec<(String, String)>,
    #[serde(default)]
    windows: bool,
    #[serde(default)]
    clear_env: bool,
    #[serde(default)]
    stdin: String,
    #[serde(default)]
    stdout: String,
    #[serde(default)]
    stderr: String,
    #[serde(default = "default_true")]
    kill_group_on_exit: bool,
    #[serde(default)]
    verbatim: bool,
    #[serde(default)]
    retained: bool,
}

fn default_true() -> bool {
    true
}

fn stdio_mode(name: &str) -> napi::Result<StdioMode> {
    match name {
        "" | "piped" => Ok(StdioMode::Piped),
        "ignore" => Ok(StdioMode::Ignore),
        "inherit" => Ok(StdioMode::Inherit),
        other => Err(napi::Error::from_reason(format!(
            "unknown stdio mode {other}"
        ))),
    }
}

/// A supervised child behind a handle the shell holds.
#[napi]
pub struct NativeChild {
    state: Arc<Mutex<ChildState>>,
}

struct ChildState {
    pid: Option<u32>,
    stdin_tx: Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
    stdin_end: Option<tokio::sync::oneshot::Sender<()>>,
    stop_tx: Option<tokio::sync::mpsc::UnboundedSender<StopRequest>>,
    job: Option<JobHandle>,
    exit: Arc<Mutex<Option<RawExit>>>,
    sink: Option<TsfnSink>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

#[napi]
impl NativeChild {
    /// The leader's pid, once the spawn gave one.
    #[napi(catch_unwind)]
    pub fn pid(&self) -> napi::Result<Option<u32>> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            lock_child(&self.state).map(|state| state.pid)
        }));
        match result {
            Ok(outcome) => outcome,
            Err(_) => Err(unwind("supervisor child pid")),
        }
    }

    /// Queues stdin bytes; the pump writes them in order.
    #[napi(catch_unwind)]
    pub fn write_stdin(&self, data: Uint8Array) -> napi::Result<()> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let state = lock_child(&self.state)?;
            match &state.stdin_tx {
                Some(tx) => tx
                    .send(data.to_vec())
                    .map_err(|_| locked("supervisor stdin is closed")),
                None => Err(locked("supervisor stdin is closed")),
            }
        }));
        match result {
            Ok(outcome) => outcome,
            Err(_) => Err(unwind("supervisor stdin write")),
        }
    }

    /// Closes stdin; a CLI waiting on it exits instead of hanging.
    #[napi(catch_unwind)]
    pub fn end_stdin(&self) -> napi::Result<()> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut state = lock_child(&self.state)?;
            if let Some(end) = state.stdin_end.take() {
                let _ = end.send(());
                return Ok(());
            }
            if state.stdin_tx.is_none() {
                return Err(locked("supervisor stdin is closed"));
            }
            Ok(())
        }));
        match result {
            Ok(outcome) => outcome,
            Err(_) => Err(unwind("supervisor stdin end")),
        }
    }

    /// Begins the stop escalation; shorter graces move it earlier.
    #[napi(catch_unwind)]
    pub fn stop(&self, grace_ms: f64) -> napi::Result<()> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let grace_ms = ace_supervisor::spawn::check_grace_ms(grace_ms)
                .map_err(|error| locked(&error.to_string()))?;
            let state = lock_child(&self.state)?;
            match &state.stop_tx {
                Some(tx) => tx
                    .send(StopRequest { grace_ms })
                    .map_err(|_| locked("supervisor stop is closed")),
                None => Err(locked("supervisor stop is closed")),
            }
        }));
        match result {
            Ok(outcome) => outcome,
            Err(_) => Err(unwind("supervisor stop")),
        }
    }

    /// The exit once the process and its pipes are done, if it is over.
    #[napi(catch_unwind)]
    pub fn take_exit(&self) -> napi::Result<Option<String>> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            lock_child(&self.state).map(|state| {
                state
                    .exit
                    .lock()
                    .ok()
                    .and_then(|exit| exit.clone())
                    .map(|exit| {
                    format!(
                        "{{\"code\":{},\"signal\":{}}}",
                        exit
                            .code
                            .map(|code| code.to_string())
                            .unwrap_or_else(|| "null".to_owned()),
                        exit.signal
                            .as_ref()
                            .map(|signal| format!("\"{signal}\""))
                            .unwrap_or_else(|| "null".to_owned()),
                    )
                })
            })
        }));
        match result {
            Ok(outcome) => outcome,
            Err(_) => Err(unwind("supervisor take exit")),
        }
    }

    /// Releases tasks and pipes; the tree stays as the exit left it.
    #[napi(catch_unwind)]
    pub fn dispose(&self) -> napi::Result<()> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut state = lock_child(&self.state)?;
            state.stdin_tx = None;
            state.stdin_end = None;
            state.stop_tx = None;
            for task in state.tasks.drain(..) {
                task.abort();
            }
            if let Some(handle) = state.job.take() {
                #[cfg(windows)]
                if let Ok(mut job) = handle.job.lock() {
                    job.dispose();
                }
                #[cfg(not(windows))]
                let _ = handle;
            }
            state.sink = None;
            Ok(())
        }));
        match result {
            Ok(outcome) => outcome,
            Err(_) => Err(unwind("supervisor dispose")),
        }
    }
}

fn locked(message: &str) -> napi::Error {
    napi::Error::from_reason(message)
}

fn lock_child(
    state: &Mutex<ChildState>,
) -> napi::Result<std::sync::MutexGuard<'_, ChildState>> {
    state
        .lock()
        .map_err(|_| napi::Error::from_reason("supervisor child lock failed"))
}

/// Spawns a supervised child; byte events arrive on `events` in order.
#[napi(catch_unwind)]
pub fn supervisor_spawn(
    spec_json: String,
    events: ThreadsafeFunction<FnArgs<(String, Uint8Array)>>,
) -> napi::Result<NativeChild> {
    let result = catch_unwind(AssertUnwindSafe(|| spawn_inner(&spec_json, events)));
    match result {
        Ok(Ok(child)) => Ok(child),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(unwind("supervisor spawn")),
    }
}

fn spawn_inner(
    spec_json: &str,
    events: ThreadsafeFunction<FnArgs<(String, Uint8Array)>>,
) -> napi::Result<NativeChild> {    let spec: SpecJson =
        serde_json::from_str(spec_json).map_err(|error| napi::Error::from_reason(error.to_string()))?;
    let parsed = SpawnSpec {
        command: spec.command.clone(),
        args: spec.args.clone(),
        cwd: spec.cwd.clone(),
        env: spec.env.clone(),
        windows: spec.windows,
        windows_batch: spec.verbatim,
        stdin: stdio_mode(&spec.stdin)?,
        stdout: stdio_mode(&spec.stdout)?,
        stderr: stdio_mode(&spec.stderr)?,
        kill_group_on_exit: spec.kill_group_on_exit,
    };
    parsed.validate().map_err(bind_error)?;
    let runtime = runtime()?;
    let sink = TsfnSink {
        sink: Arc::new(events),
    };
    runtime
        .block_on(spawn_task(spec, sink.clone()))
        .map(|spawned| {
            let state = ChildState {
                pid: spawned.pid,
                stdin_tx: spawned.stdin_tx,
                stdin_end: spawned.stdin_end,
                stop_tx: Some(spawned.stop_tx),
                job: spawned.job,
                exit: Arc::clone(&spawned.exit_store),
                sink: Some(sink),
                tasks: spawned.tasks,
            };
            NativeChild {
                state: Arc::new(Mutex::new(state)),
            }
        })
}

struct Spawned {
    pid: Option<u32>,
    stdin_tx: Option<tokio::sync::mpsc::UnboundedSender<Vec<u8>>>,
    stdin_end: Option<tokio::sync::oneshot::Sender<()>>,
    stop_tx: tokio::sync::mpsc::UnboundedSender<StopRequest>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
    job: Option<JobHandle>,
    exit_store: Arc<Mutex<Option<RawExit>>>,
}

fn stdio_flag(mode: StdioMode) -> std::process::Stdio {
    match mode {
        StdioMode::Piped => std::process::Stdio::piped(),
        StdioMode::Ignore => std::process::Stdio::null(),
        StdioMode::Inherit => std::process::Stdio::inherit(),
    }
}

struct TreeSignals {
    pid: u32,
}

impl ace_supervisor::stop::StopTree for TreeSignals {
    fn terminate(&self, pid: u32) {
        debug_assert_eq!(pid, self.pid);
        #[cfg(windows)]
        {
            let _ = stop::kill_windows_tree(self.pid, false);
            let _ = pid;
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            let _ = stop::kill_group(self.pid, signal::SignalName::Term);
        }
    }

    fn destroy(&self, pid: u32) {
        debug_assert_eq!(pid, self.pid);
        #[cfg(windows)]
        {
            let _ = stop::kill_windows_tree(self.pid, true);
            let _ = pid;
        }
        #[cfg(not(windows))]
        {
            let _ = pid;
            let _ = stop::kill_group(self.pid, signal::SignalName::Kill);
        }
    }
}

struct RetainedEvents {
    sink: TsfnSink,
}

impl ace_supervisor::stop::StopEvents for RetainedEvents {
    fn tree_gone(&self) {
        self.sink.emit(ChildEvent::TreeGone);
    }

    fn stop_failed(&self, message: String) {
        self.sink.emit(ChildEvent::StopFailed(message));
    }
}

async fn spawn_task(spec: SpecJson, sink: TsfnSink) -> napi::Result<Spawned> {
    use process_wrap::tokio::CommandWrap;
    let stdin_mode = stdio_mode(&spec.stdin)?;
    let stdout_mode = stdio_mode(&spec.stdout)?;
    let stderr_mode = stdio_mode(&spec.stderr)?;
    if spec.command.is_empty() {
        return Err(napi::Error::from_reason("empty command"));
    }
    // Batch entrypoints ride a pre-quoted cmd.exe line; everything else
    // spawns directly. The shell maps the command; this only honors it.
    #[cfg(windows)]
    let mut command = if spec.verbatim {
        use std::os::windows::process::CommandExt as _;
        let mut verbatim = std::process::Command::new(&spec.command);
        for arg in &spec.args {
            verbatim.raw_arg(arg);
        }
        tokio::process::Command::from(verbatim)
    } else {
        tokio::process::Command::new(&spec.command)
    };
    #[cfg(not(windows))]
    let mut command = tokio::process::Command::new(&spec.command);
    if !spec.verbatim {
        command.args(&spec.args);
    }
    command
        .envs(spec.env.iter().map(|(name, value)| (name, value)))
        .stdin(stdio_flag(stdin_mode))
        .stdout(stdio_flag(stdout_mode))
        .stderr(stdio_flag(stderr_mode));
    if let Some(cwd) = &spec.cwd {
        command.current_dir(cwd);
    }
    if spec.clear_env {
        command.env_clear();
    }
    let mut wrap = CommandWrap::from(command);
    #[cfg(unix)]
    wrap.wrap(process_wrap::tokio::ProcessGroup::leader());
    let mut child = wrap
        .spawn()
        .map_err(|error| napi::Error::from_reason(format!("supervisor spawn failed: {error}")))?;
    let pid = child.id();
    let exit_store: Arc<Mutex<Option<RawExit>>> = Arc::new(Mutex::new(None));
    let (stop_tx, stop_rx) = tokio::sync::mpsc::unbounded_channel();
    let (exited_tx, exited_rx) = tokio::sync::oneshot::channel::<()>();
    let mut tasks = Vec::new();
    // Stdin: one owner, messages in order, EOF closes it.
    let (stdin_tx, stdin_end) = match (stdin_mode, child.stdin().take()) {
        (StdioMode::Piped, Some(stdin)) => {
            let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
            let (end_tx, end_rx) = tokio::sync::oneshot::channel::<()>();
            tasks.push(tokio::spawn(stdin_pump(stdin, rx, end_rx, sink.clone())));
            (Some(tx), Some(end_tx))
        }
        _ => (None, None),
    };
    // Pumps forward bytes in arrival order; the waiter joins them before
    // the exit, so no byte is still in flight when the exit lands.
    let mut pumps = Vec::new();
    if let Some(stdout) = child.stdout().take() {
        let sink = sink.clone();
        pumps.push(tokio::spawn(async move {
            ace_supervisor::spawn::pump_stream(&sink, stdout, false).await;
        }));
    }
    if let Some(stderr) = child.stderr().take() {
        let sink = sink.clone();
        pumps.push(tokio::spawn(async move {
            ace_supervisor::spawn::pump_stream(&sink, stderr, true).await;
        }));
    }
    // The waiter owns the child: after the wait it ends stragglers holding
    // the pipes (unless retained), joins the pumps, then names the exit.
    let waiter_sink = sink.clone();
    let waiter_store = Arc::clone(&exit_store);
    let retained = spec.retained;
    let windows = spec.windows;
    tasks.push(tokio::spawn(waiter_task(
        child,
        pumps,
        waiter_sink,
        waiter_store,
        exited_tx,
        retained,
    )));
    // Windows containment: the job outlives the spawn call, like the shell's.
    // The stop task shares it to confirm the tree is gone.
    #[cfg(windows)]
    let job: Option<JobHandle> = pid.and_then(|pid| {
        ace_supervisor::contain::KillOnCloseJob::create(SystemJobApi::new()).map(|mut job| {
            job.assign(pid);
            JobHandle {
                job: Arc::new(Mutex::new(
                    Box::new(job) as Box<dyn ace_supervisor::contain::WindowsJob>,
                )),
            }
        })
    });
    #[cfg(not(windows))]
    let job: Option<JobHandle> = None;
    // The stop plan runs on its own task, never behind the reader.
    // A retained tree is confirmed gone; any other tree just exits.
    if let Some(pid) = pid {
        let tree = TreeSignals { pid };
        if retained {
            let confirm: Arc<dyn Fn() -> bool + Send + Sync> = {
                let job = job.clone();
                Arc::new(move || confirm_tree_gone(pid, &job))
            };
            let events = RetainedEvents { sink: sink.clone() };
            tasks.push(tokio::spawn(
                ace_supervisor::stop::run_retained_stop(tree, pid, windows, confirm, stop_rx, events),
            ));
        } else {
            tasks.push(tokio::spawn(
                ace_supervisor::spawn::run_stop_plan(tree, pid, stop_rx, exited_rx),
            ));
        }
    }
    Ok(Spawned {
        pid,
        stdin_tx,
        stdin_end,
        stop_tx,
        tasks,
        job,
        exit_store,
    })
}

/// A shared Windows job handle: the stop task queries it, dispose closes it.
#[derive(Clone)]
struct JobHandle {
    #[cfg(windows)]
    job: Arc<Mutex<Box<dyn ace_supervisor::contain::WindowsJob>>>,
}

/// Whether the tree is gone: the job's liveness, else the leader's.
#[cfg(windows)]
fn confirm_tree_gone(pid: u32, job: &Option<JobHandle>) -> bool {
    if let Some(handle) = job {
        if let Ok(mut contained) = handle.job.lock() {
            match contained.running() {
                ace_supervisor::contain::JobRunning::Running(alive) => return !alive,
                ace_supervisor::contain::JobRunning::Unjoined => {}
            }
        }
    }
    windows_tree_gone(pid)
}

/// Whether a POSIX tree is gone: the group answers no probe.
#[cfg(not(windows))]
fn confirm_tree_gone(pid: u32, job: &Option<JobHandle>) -> bool {
    let _ = job;
    // A refused probe while the group exits counts as gone for the stop.
    match reaper::process_group_alive(pid) {
        Ok(alive) => !alive,
        Err(_) => true,
    }
}

async fn stdin_pump(
    mut stdin: tokio::process::ChildStdin,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    mut end: tokio::sync::oneshot::Receiver<()>,
    sink: TsfnSink,
) {
    use tokio::io::AsyncWriteExt as _;
    loop {
        tokio::select! {
            message = rx.recv() => {
                let Some(bytes) = message else { return };
                if let Err(error) = stdin.write_all(&bytes).await {
                    sink.emit(ChildEvent::StdinError(error.to_string()));
                    return;
                }
            }
            _ = &mut end => {
                // Dropping stdin sends EOF; a CLI waiting on it exits.
                return;
            }
        }
    }
}

async fn waiter_task(
    mut child: Box<dyn process_wrap::tokio::ChildWrapper>,
    mut pumps: Vec<tokio::task::JoinHandle<()>>,
    sink: TsfnSink,
    exit_store: Arc<Mutex<Option<RawExit>>>,
    exited: tokio::sync::oneshot::Sender<()>,
    retained: bool,
) {
    let status = child.wait().await;
    // A natural exit kills descendants by default, including agent-started
    // dev servers: their pipes close, and the exit names the leader's end.
    if !retained && let Some(pid) = child.id() {
        use ace_supervisor::stop::StopTree as _;
        TreeSignals { pid }.destroy(pid);
    }
    drop(child);
    // The exit lands only after the pipes drained, like the close event.
    for pump in pumps.drain(..) {
        let _ = pump.await;
    }
    let (code, signal) = match status {
        Ok(status) => (
            status.code(),
            exit_signal(status),
        ),
        Err(_) => (None, None),
    };
    if let Ok(mut exit) = exit_store.lock() {
        *exit = Some(RawExit { code, signal: signal.clone() });
    }
    sink.emit(ChildEvent::Exit(RawExit { code, signal }));
    let _ = exited.send(());
}

/// The signal that ended the process, if one did. Windows has no signals.
#[cfg(unix)]
fn exit_signal(status: std::process::ExitStatus) -> Option<String> {
    use std::os::unix::process::ExitStatusExt as _;
    status.signal().map(|signal| match signal {
        1 => "SIGHUP",
        2 => "SIGINT",
        3 => "SIGQUIT",
        4 => "SIGILL",
        6 => "SIGABRT",
        8 => "SIGFPE",
        9 => "SIGKILL",
        11 => "SIGSEGV",
        13 => "SIGPIPE",
        14 => "SIGALRM",
        15 => "SIGTERM",
        _ => "SIGUNKNOWN",
    }.to_owned())
}

/// The signal that ended the process, if one did. Windows has no signals.
#[cfg(not(unix))]
fn exit_signal(_status: std::process::ExitStatus) -> Option<String> {
    None
}

/// The process inventory behind a handle the shell holds.
#[napi]
pub struct NativeInventory {
    inner: Mutex<InventoryHandle>,
}

struct InventoryHandle {
    inventory: inventory::Inventory<SystemRuntime>,
    reports: Arc<Mutex<Vec<String>>>,
}

/// The production runtime: the real kernel, this process, the real clock.
struct SystemRuntime {
    owner: u32,
}

impl inventory::InventoryRuntime for SystemRuntime {
    fn identity(&self, pid: u32) -> Result<Option<identity::ProcessIdentity>, ace_supervisor::errors::SupervisorError> {
        identity::process_identity(pid)
    }

    fn child_exited(&self, pid: u32) -> bool {
        reaper::child_has_exited(pid)
    }

    fn alive(&self, group: u32) -> Result<bool, inventory::ProbeRefused> {
        match reaper::process_group_alive(group) {
            Ok(alive) => Ok(alive),
            Err(ace_supervisor::errors::SupervisorError::Unavailable(_)) => {
                Err(inventory::ProbeRefused::Refused)
            }
            Err(error) => Err(inventory::ProbeRefused::Failed(error.to_string())),
        }
    }

    fn kill(&self, group: u32) {
        let _ = stop::kill_group(group, signal::SignalName::Kill);
    }

    fn owner_pid(&self) -> u32 {
        self.owner
    }

    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0)
    }
}

#[napi]
impl NativeInventory {
    /// Opens (creating) the journal at `path`.
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String) -> napi::Result<Self> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let reports = Arc::new(Mutex::new(Vec::new()));
            let sink = Arc::clone(&reports);
            let inventory = inventory::Inventory::open(
                &path,
                SystemRuntime {
                    owner: std::process::id(),
                },
                Arc::new(move |message: String| {
                    if let Ok(mut reports) = sink.lock() {
                        reports.push(message);
                    }
                }),
            )
            .map_err(bind_error)?;
            Ok::<InventoryHandle, napi::Error>(InventoryHandle { inventory, reports })
        }));
        match result {
            Ok(Ok(inner)) => Ok(Self {
                inner: Mutex::new(inner),
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(unwind("supervisor inventory open")),
        }
    }

    fn with<T>(&self, run: impl FnOnce(&mut InventoryHandle) -> napi::Result<T>) -> napi::Result<T> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("supervisor inventory lock failed"))?;
            run(&mut inner)
        }));
        match result {
            Ok(outcome) => outcome,
            Err(_) => Err(unwind("supervisor inventory")),
        }
    }

    /// Records one owned leader.
    #[napi(catch_unwind)]
    pub fn add(&self, pid: f64, name: String, cwd: Option<String>) -> napi::Result<()> {
        self.with(|handle| {
            handle
                .inventory
                .add(pid as u32, &name, cwd.as_deref())
                .map_err(bind_error)
        })
    }

    /// Forgets an exited process; returns the retry plan as JSON.
    #[napi(catch_unwind)]
    pub fn remove(&self, pid: f64) -> napi::Result<String> {
        self.with(|handle| {
            handle.inventory.remove(pid as u32);
            Ok(retry_plan_json(&handle.inventory))
        })
    }

    /// Retries failed deletes; returns the retry plan as JSON.
    #[napi(catch_unwind)]
    pub fn retry_removals(&self, now_ms: f64) -> napi::Result<String> {
        self.with(|handle| {
            handle.inventory.retry_removals(now_ms as u64);
            Ok(retry_plan_json(&handle.inventory))
        })
    }

    /// When the next retry is due, if one is scheduled.
    #[napi(catch_unwind)]
    pub fn retry_at_ms(&self) -> napi::Result<Option<f64>> {
        self.with(|handle| Ok(handle.inventory.retry_at_ms().map(|at| at as f64)))
    }

    /// Windows only: one descendant-recorder tick. Returns whether the
    /// shell keeps the interval.
    #[napi(catch_unwind)]
    pub fn windows_tick(&self, now_ms: f64) -> napi::Result<bool> {
        self.with(|handle| {
            let _ = &handle;
            #[cfg(windows)]
            {
                Ok(handle.inventory.windows_tick(
                    now_ms as u64,
                    &ace_supervisor::wintree::SystemWindowsTree::new(),
                ))
            }
            #[cfg(not(windows))]
            {
                let _ = now_ms;
                Ok(false)
            }
        })
    }

    /// Recovers what the previous run left recorded.
    #[napi(catch_unwind)]
    pub fn recover(&self) -> napi::Result<String> {
        self.with(|handle| {
            let recovered = handle.inventory.recover().map_err(bind_error)?;
            Ok(format!(
                "{{\"removed\":{},\"killed\":{},\"unresolved\":{}}}",
                recovered.removed, recovered.killed, recovered.unresolved
            ))
        })
    }

    /// Every recorded process, as JSON.
    #[napi(catch_unwind)]
    pub fn list(&self) -> napi::Result<String> {
        self.with(|handle| {
            let entries = handle.inventory.list().map_err(bind_error)?;
            let mut out = String::from("[");
            for (index, entry) in entries.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&ace_supervisor::entries::entry_json(
                    entry,
                    EntryPlatform::current(),
                ));
            }
            out.push(']');
            Ok(out)
        })
    }

    /// Drains report messages since the last call.
    #[napi(catch_unwind)]
    pub fn take_reports(&self) -> napi::Result<Vec<String>> {
        self.with(|handle| {
            handle
                .reports
                .lock()
                .map(|mut reports| std::mem::take(&mut *reports))
                .map_err(|_| napi::Error::from_reason("supervisor reports lock failed"))
        })
    }

    /// Closes the journal.
    #[napi(catch_unwind)]
    pub fn close(&self) -> napi::Result<()> {
        self.with(|handle| {
            handle.inventory.close();
            Ok(())
        })
    }
}

fn retry_plan_json(inventory: &inventory::Inventory<SystemRuntime>) -> String {
    match inventory.retry_at_ms() {
        Some(at) => format!("{{\"retryInMs\":{at}}}"),
        None => "{\"retryInMs\":null}".to_owned(),
    }
}

/// The escapee journal behind a handle the shell holds.
#[napi]
pub struct NativeJournal {
    inner: Mutex<journal::EscapeeJournal>,
}

#[napi]
impl NativeJournal {
    /// Opens (creating) the journal at `path` for `run`.
    #[napi(constructor, catch_unwind)]
    pub fn new(path: String, run: String) -> napi::Result<Self> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            journal::EscapeeJournal::open(&path, &run).map_err(bind_error)
        }));
        match result {
            Ok(Ok(inner)) => Ok(Self {
                inner: Mutex::new(inner),
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(unwind("supervisor journal open")),
        }
    }

    fn with<T>(&self, run: impl FnOnce(&journal::EscapeeJournal) -> napi::Result<T>) -> napi::Result<T> {
        let result = catch_unwind(AssertUnwindSafe(|| {
            let inner = self
                .inner
                .lock()
                .map_err(|_| napi::Error::from_reason("supervisor journal lock failed"))?;
            run(&inner)
        }));
        match result {
            Ok(outcome) => outcome,
            Err(_) => Err(unwind("supervisor journal")),
        }
    }

    #[napi(catch_unwind)]
    pub fn record(&self, members_json: String) -> napi::Result<()> {
        self.with(|inner| {
            let members = parse_members(&members_json)?;
            inner.record(&members).map_err(bind_error)
        })
    }

    #[napi(catch_unwind)]
    pub fn forget(&self, members_json: String) -> napi::Result<()> {
        self.with(|inner| {
            let members = parse_members(&members_json)?;
            inner.forget(&members).map_err(bind_error)
        })
    }

    #[napi(catch_unwind)]
    pub fn earlier(&self) -> napi::Result<String> {
        self.with(|inner| {
            let rows = inner.earlier().map_err(bind_error)?;
            let mut out = String::from("[");
            for (index, row) in rows.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&format!(
                    "{{\"pid\":{},\"start\":{},\"run\":{}}}",
                    row.pid,
                    quote(&row.start),
                    quote(&row.run)
                ));
            }
            out.push(']');
            Ok(out)
        })
    }

    #[napi(catch_unwind)]
    pub fn keep(&self, pid: f64, start: String) -> napi::Result<()> {
        self.with(|inner| {
            inner
                .keep(
                    &journal::JournalMember {
                        pid: pid as u32,
                        start,
                    },
                    &|_pid| true,
                )
                .map_err(bind_error)
        })
    }

    #[napi(catch_unwind)]
    pub fn record_lineage(&self, uniques: Vec<String>) -> napi::Result<()> {
        self.with(|inner| inner.record_lineage(&uniques).map_err(bind_error))
    }

    #[napi(catch_unwind)]
    pub fn forget_earlier_lineage(&self) -> napi::Result<()> {
        self.with(|inner| inner.forget_earlier_lineage().map_err(bind_error))
    }

    #[napi(catch_unwind)]
    pub fn kept(&self) -> napi::Result<String> {
        self.with(|inner| {
            let members = inner.kept().map_err(bind_error)?;
            Ok(members_json(&members))
        })
    }

    #[napi(catch_unwind)]
    pub fn close(&self) -> napi::Result<()> {
        self.with(|inner| inner.close().map_err(bind_error))
    }
}

fn parse_members(members_json: &str) -> napi::Result<Vec<journal::JournalMember>> {
    let members: Vec<MemberJson> =
        serde_json::from_str(members_json).map_err(|error| napi::Error::from_reason(error.to_string()))?;
    Ok(members
        .into_iter()
        .map(|member| journal::JournalMember {
            pid: member.pid,
            start: member.start,
        })
        .collect())
}

#[derive(Debug, serde::Deserialize)]
struct MemberJson {
    pid: u32,
    start: String,
}

fn members_json(members: &[journal::JournalMember]) -> String {
    let mut out = String::from("[");
    for (index, member) in members.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str(&format!("{{\"pid\":{},\"start\":{}}}", member.pid, quote(&member.start)));
    }
    out.push(']');
    out
}

fn quote(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for char in text.chars() {
        match char {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            char if (char as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", char as u32)),
            char => out.push(char),
        }
    }
    out.push('"');
    out
}

/// Read-only, for `ace stop`: a run's escapees, kept processes and lineage.
#[napi(catch_unwind)]
pub fn supervisor_read_ownership(path: String, run: Option<String>) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let ownership = journal::read_ownership(&path, run.as_deref()).map_err(bind_error)?;
        let mut out = String::from("{\"escapees\":");
        out.push_str(&members_json(&ownership.escapees));
        out.push_str(",\"kept\":");
        out.push_str(&members_json(&ownership.kept));
        out.push_str(",\"lineage\":[");
        for (index, unique) in ownership.lineage.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&quote(unique));
        }
        out.push_str("]}");
        Ok(out)
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor read ownership")),
    }
}

/// Reads one process's kernel identity as JSON, or null when it is gone.
#[napi(catch_unwind)]
pub fn supervisor_process_identity(pid: f64) -> napi::Result<Option<String>> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        identity::process_identity(pid as u32)
            .map(|identity| {
                identity.map(|identity| {
                    let owner = match identity.owner {
                        identity::ProcessOwner::Uid(uid) => uid.to_string(),
                        identity::ProcessOwner::Sid(sid) => quote(&sid),
                    };
                    format!(
                        "{{\"pid\":{},\"start\":{},\"uid\":{},\"group\":{}}}",
                        identity.pid,
                        quote(&identity.start),
                        owner,
                        identity.group
                    )
                })
            })
            .map_err(bind_error)
    }));
    match result {
        Ok(Ok(identity)) => Ok(identity),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(unwind("supervisor identity")),
    }
}

/// Whether a process group is gone: ESRCH proves it; other refusals throw.
#[napi(catch_unwind)]
pub fn supervisor_process_group_is_gone(group: f64) -> napi::Result<bool> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        identity::process_group_is_gone(group as u32).map_err(bind_error)
    }));
    match result {
        Ok(Ok(gone)) => Ok(gone),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(unwind("supervisor group probe")),
    }
}

/// Ends a group with `signal` (unguarded; the shell keeps the guard).
#[napi(catch_unwind)]
pub fn supervisor_kill_group(group: f64, signal: String) -> napi::Result<()> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let signal = signal::SignalName::parse(&signal).map_err(bind_error)?;
        stop::kill_group(group as u32, signal).map_err(bind_error)
    }));
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(unwind("supervisor kill group")),
    }
}

/// Signals one member, checked on its own just before the signal goes.
#[napi(catch_unwind)]
pub fn supervisor_signal_member(member_json: String, signal: String) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let member: MemberJson = serde_json::from_str(&member_json)
            .map_err(|error| bind_error(ace_supervisor::errors::SupervisorError::InvalidInput(error.to_string())))?;
        let signal = signal::SignalName::parse(&signal).map_err(bind_error)?;
        let io = SystemSignalIo;
        Ok::<String, napi::Error>(match signal::signal_member(
            &signal::TreeRef {
                pid: member.pid,
                start: member.start,
            },
            signal,
            &io,
        ) {
            signal::SignalOutcome::Sent => "sent".to_owned(),
            signal::SignalOutcome::Gone => "gone".to_owned(),
            signal::SignalOutcome::Unsafe => "unsafe".to_owned(),
        })
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor signal member")),
    }
}

struct SystemSignalIo;

impl signal::SignalIo for SystemSignalIo {
    fn start(&self, pid: u32) -> Option<String> {
        identity::process_identity(pid).unwrap_or(None).map(|identity| identity.start)
    }

    fn kill(&self, pid: u32, signal: signal::SignalName) -> bool {
        use rustix::process::Pid;
        let Ok(raw) = i32::try_from(pid) else {
            return false;
        };
        let Some(target) = Pid::from_raw(raw) else {
            return false;
        };
        let sig = match signal {
            signal::SignalName::Term => rustix::process::Signal::TERM,
            signal::SignalName::Kill => rustix::process::Signal::KILL,
        };
        rustix::process::kill_process(target, sig).is_ok()
    }

    fn pidfds(&self) -> Option<&dyn signal::PidFdTable> {
        #[cfg(target_os = "linux")]
        {
            static PIDFDS: signal::SystemPidFds = signal::SystemPidFds;
            Some(&PIDFDS)
        }
        #[cfg(not(target_os = "linux"))]
        {
            None
        }
    }
}

/// Captures the tree below `roots` as JSON.
#[napi(catch_unwind)]
pub fn supervisor_capture_tree(roots_json: String, limit: f64) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let roots: Vec<u32> = serde_json::from_str(&roots_json)
            .map_err(|error| bind_error(ace_supervisor::errors::SupervisorError::InvalidInput(error.to_string())))?;
        let system = SystemTree::new();
        let capture = tree::capture_tree(&roots, &system, limit as usize);
        let mut out = String::from("{\"members\":[");
        for (index, member) in capture.members.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&format!(
                "{{\"pid\":{},\"start\":{},\"parent\":{},\"group\":{}}}",
                member.pid,
                quote(&member.start),
                member.parent,
                member.group
            ));
        }
        out.push_str(&format!("],\"truncated\":{}}}", capture.truncated));
        Ok(out)
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor capture tree")),
    }
}

struct SystemTree {
    #[cfg(target_os = "linux")]
    walk: Mutex<LinuxWalk<listing::SystemProcFs>>,
}

impl SystemTree {
    fn new() -> Self {
        Self {
            #[cfg(target_os = "linux")]
            walk: Mutex::new(LinuxWalk::new(listing::LinuxListing::new(
                listing::SystemProcFs,
            ))),
        }
    }
}

impl tree::TreeIo for SystemTree {
    fn platform(&self) -> &str {
        #[cfg(target_os = "linux")]
        return "linux";
        #[cfg(target_os = "macos")]
        return "darwin";
        #[cfg(target_os = "windows")]
        return "win32";
        #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
        return "other";
    }

    fn children(&self, pid: u32) -> Vec<u32> {
        #[cfg(target_os = "linux")]
        {
            self.walk
                .lock()
                .map(|walk| walk.children(pid))
                .unwrap_or_default()
        }
        #[cfg(target_os = "macos")]
        {
            listing::children_of(pid)
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = pid;
            Vec::new()
        }
    }

    fn identity(&self, pid: u32) -> Option<tree::LiveIdentity> {
        #[cfg(target_os = "linux")]
        {
            let walk = self.walk.lock().ok()?;
            let info = walk.info(pid)?;
            if info.zombie {
                return None;
            }
            Some(tree::LiveIdentity {
                start: info.start,
                parent: info.parent,
                group: info.group,
            })
        }
        #[cfg(target_os = "macos")]
        {
            let info = listing::darwin_info(pid)?;
            if info.zombie {
                return None;
            }
            Some(tree::LiveIdentity {
                start: info.start,
                parent: info.parent,
                group: info.group,
            })
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = pid;
            None
        }
    }

    fn kill(&self, pid: u32, signal: signal::SignalName) -> bool {
        SystemSignalIo.kill(pid, signal)
    }

    fn pidfds(&self) -> Option<&dyn signal::PidFdTable> {
        SystemSignalIo.pidfds()
    }

    fn wait_ms(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

/// Stops captured members (SIGTERM, then SIGKILL) on a thread; `done` hears
/// the members still running as JSON.
#[napi(catch_unwind)]
pub fn supervisor_stop_members(
    _env: napi::Env,
    members: String,
    grace_ms: f64,
    done: ThreadsafeFunction<String>,
) -> napi::Result<()> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let parsed: Vec<MemberJson> = serde_json::from_str(&members)
            .map_err(|error| bind_error(ace_supervisor::errors::SupervisorError::InvalidInput(error.to_string())))?;
        let members: Vec<signal::TreeRef> = parsed
            .into_iter()
            .map(|member| signal::TreeRef {
                pid: member.pid,
                start: member.start,
            })
            .collect();
        // The thread owns the wait; the loop never blocks the JS thread.
        // Dropping the threadsafe function after the call releases it.
        std::thread::spawn(move || {
            let system = SystemTree::new();
            let left = tree::stop_members(&members, grace_ms as u64, &system, None);
            let _ = done.call(
                Ok(members_json(
                    &left
                        .iter()
                        .map(|member| journal::JournalMember {
                            pid: member.pid,
                            start: member.start.clone(),
                        })
                        .collect::<Vec<_>>(),
                )),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        });
        Ok(())
    }));
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(unwind("supervisor stop members")),
    }
}

/// Maps one program through `cmd.exe` on Windows; passes others through.
#[napi(catch_unwind)]
pub fn supervisor_to_windows_command(command: String, args: Vec<String>) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
        let mapped = owner::to_windows_command(&command, &borrowed)
            .map_err(ace_supervisor::errors::SupervisorError::InvalidInput)
            .map_err(bind_error)?;
        Ok::<String, napi::Error>(format!(
            "{{\"command\":{},\"args\":[{}],\"verbatim\":{}}}",
            quote(&mapped.command),
            mapped
                .args
                .iter()
                .map(|arg| quote(arg))
                .collect::<Vec<_>>()
                .join(","),
            mapped.verbatim
        ))
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor windows command")),
    }
}

/// A file in Windows' own System32, located by the kernel.
#[napi(catch_unwind)]
pub fn supervisor_windows_system_executable(name: String) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        #[cfg(windows)]
        {
            owner::windows_system_executable(&name).map_err(bind_error)
        }
        #[cfg(not(windows))]
        {
            let _ = name;
            Err::<String, napi::Error>(napi::Error::from_reason(
                "Windows system executables need Windows",
            ))
        }
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor system executable")),
    }
}

/// Whole-tree stop on Windows, where process groups do not exist.
#[napi(catch_unwind)]
pub fn supervisor_kill_windows_tree(pid: f64, force: bool) -> napi::Result<()> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        #[cfg(windows)]
        {
            stop::kill_windows_tree(pid as u32, force).map_err(bind_error)
        }
        #[cfg(not(windows))]
        {
            let _ = (pid, force);
            Err::<(), napi::Error>(napi::Error::from_reason("Windows tree stops need Windows"))
        }
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor kill windows tree")),
    }
}

/// The recorded tree's state now, as JSON. Windows only; elsewhere empty.
#[napi(catch_unwind)]
pub fn supervisor_tree_state(recorded_json: String) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let recorded: Vec<MemberJson> = serde_json::from_str(&recorded_json)
            .map_err(|error| bind_error(ace_supervisor::errors::SupervisorError::InvalidInput(error.to_string())))?;
        #[cfg(windows)]
        {
            use ace_supervisor::wintree::{WindowsRecord, WindowsTreeOps};
            let members: Vec<WindowsRecord> = recorded
                .into_iter()
                .map(|member| WindowsRecord {
                    pid: member.pid,
                    start: member.start,
                    uid: String::new(),
                })
                .collect();
            let system = ace_supervisor::wintree::SystemWindowsTree::new();
            let state = system.state(&members);
            Ok::<String, napi::Error>(format!(
                "{{\"live\":{},\"discovered\":{},\"gone\":{},\"ambiguous\":[{}]}}",
                members_json(
                    &state
                        .live
                        .iter()
                        .map(|member| journal::JournalMember {
                            pid: member.pid,
                            start: member.start.clone(),
                        })
                        .collect::<Vec<_>>()
                ),
                members_json(
                    &state
                        .discovered
                        .iter()
                        .map(|member| journal::JournalMember {
                            pid: member.pid,
                            start: member.start.clone(),
                        })
                        .collect::<Vec<_>>()
                ),
                members_json(
                    &state
                        .gone
                        .iter()
                        .map(|member| journal::JournalMember {
                            pid: member.pid,
                            start: member.start.clone(),
                        })
                        .collect::<Vec<_>>()
                ),
                state
                    .ambiguous
                    .iter()
                    .map(|pid| pid.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            ))
        }
        #[cfg(not(windows))]
        {
            let _ = recorded;
            Ok::<String, napi::Error>(
                "{\"live\":[],\"discovered\":[],\"gone\":[],\"ambiguous\":[]}".to_owned(),
            )
        }
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor tree state")),
    }
}

/// Ends one recorded member; returns what it did. Windows only.
#[napi(catch_unwind)]
pub fn supervisor_tree_terminate(member_json: String) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let member: MemberJson = serde_json::from_str(&member_json)
            .map_err(|error| bind_error(ace_supervisor::errors::SupervisorError::InvalidInput(error.to_string())))?;
        #[cfg(windows)]
        {
            use ace_supervisor::wintree::{WindowsRecord, WindowsTerminate, WindowsTreeOps};
            let system = ace_supervisor::wintree::SystemWindowsTree::new();
            let outcome = system
                .terminate(&WindowsRecord {
                    pid: member.pid,
                    start: member.start,
                    uid: String::new(),
                })
                .map_err(bind_error)?;
            Ok::<String, napi::Error>(match outcome {
                WindowsTerminate::Ended => "ended".to_owned(),
                WindowsTerminate::Gone => "gone".to_owned(),
            })
        }
        #[cfg(not(windows))]
        {
            let _ = member;
            Ok::<String, napi::Error>("gone".to_owned())
        }
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor tree terminate")),
    }
}

/// Ends every process in private directories on a thread; `done` hears the
/// outcome (`"ok"` or the error message).
#[napi(catch_unwind)]
pub fn supervisor_terminate_directory_processes(
    _env: napi::Env,
    directories_json: String,
    self_pid: f64,
    done: ThreadsafeFunction<String>,
) -> napi::Result<()> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let directories: Vec<String> = serde_json::from_str(&directories_json).map_err(|error| {
            bind_error(ace_supervisor::errors::SupervisorError::InvalidInput(
                error.to_string(),
            ))
        })?;
        // The thread owns the wait; dropping the function releases it.
        std::thread::spawn(move || {
            let io = ace_supervisor::dir::SystemDirectoryIo::new(self_pid as u32);
            let outcome = ace_supervisor::dir::terminate_directory_processes(
                &io,
                &directories,
                self_pid as u32,
                &|ms| std::thread::sleep(std::time::Duration::from_millis(ms)),
            )
            .map(|()| "ok".to_owned())
            .unwrap_or_else(|error| error.to_string());
            let _ = done.call(Ok(outcome), ThreadsafeFunctionCallMode::NonBlocking);
        });
        Ok(())
    }));
    match result {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(error),
        Err(_) => Err(unwind("supervisor terminate directory")),
    }
}

/// Read-only, for `ace stop`: what the inventory records as owned by one
/// daemon run, by pid and start.
#[napi(catch_unwind)]
pub fn supervisor_read_owned_groups(
    path: String,
    owner_pid: f64,
    owner_start: String,
) -> napi::Result<String> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let owned =
            recover::read_owned_groups(&path, owner_pid as u32, &owner_start).map_err(bind_error)?;
        let mut out = String::from("[");
        for (index, (pid, start)) in owned.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&format!("{{\"pid\":{pid},\"start\":{}}}", quote(start)));
        }
        out.push(']');
        Ok(out)
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor read owned groups")),
    }
}

/// Whether a journal still records the tree a leader started. Windows only.
#[napi(catch_unwind)]
pub fn supervisor_windows_tree_recorded(path: String, leader_json: String) -> napi::Result<bool> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let leader: MemberJson = serde_json::from_str(&leader_json)
            .map_err(|error| bind_error(ace_supervisor::errors::SupervisorError::InvalidInput(error.to_string())))?;
        #[cfg(windows)]
        {
            recover::windows_tree_recorded(&path, leader.pid, &leader.start).map_err(bind_error)
        }
        #[cfg(not(windows))]
        {
            let _ = (path, leader);
            Ok(false)
        }
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor tree recorded")),
    }
}

/// Moves this process into a process group of its own.
#[napi(catch_unwind)]
pub fn supervisor_leave_process_group() -> napi::Result<bool> {
    let result = catch_unwind(AssertUnwindSafe(|| {
        #[cfg(unix)]
        {
            Ok(ace_supervisor::signal::leave_process_group())
        }
        #[cfg(not(unix))]
        {
            Ok(false)
        }
    }));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor leave group")),
    }
}

/// Makes this process a child subreaper. False where the platform can't.
#[napi(catch_unwind)]
pub fn supervisor_become_subreaper() -> napi::Result<bool> {
    let result = catch_unwind(AssertUnwindSafe(|| Ok(reaper::become_subreaper())));
    match result {
        Ok(outcome) => outcome,
        Err(_) => Err(unwind("supervisor subreaper")),
    }
}
