// SPDX-License-Identifier: Apache-2.0
//! Core Git CLI process execution (`GitCli.executeRaw`, `verify`, `pause`, `close`,
//! capture bounds, deadlines, cancellation, and cleanup receipts).
//! Ported from `packages/git/src/cli.ts` (G2a).

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use ace_json::{JsString, Map, Number, Value};
use tokio::sync::{Notify, mpsc, watch};

use crate::core::deadline::validate_timeout_ms;
use crate::core::diagnostics::GitDiagnostics;
use crate::core::error::{CleanupResult, GitError, GitErrorCode, json_string_array};
use crate::core::failure::{StderrTail, failure_message};
use crate::core::job::{GitJob, StoppedJobs, global_stopped_jobs};
use crate::core::spawn::{
    BoxFuture, ProcessEvent, ProcessPorts, SchedulerAdapter, SpawnRequest, classify_spawn_error,
    drain_process_exit, group_gone, inherited_env_pairs, kill_tree, running_children,
};

/// Maximum concurrent calls admitted by one `GitCliCore` instance.
pub const CALL_LIMIT: usize = 64;
/// Default stdout capture limit (64 MiB).
pub const DEFAULT_CAPTURE_BYTES: usize = 64 * 1024 * 1024;
/// Maximum raw stderr bytes retained in `Output.stderr` (64 KiB).
const STDERR_RAW_LIMIT: usize = 65_536;
/// Maximum stdout tail bytes fed to `diagnostics.accept_output` (4 KiB).
const OUTPUT_TAIL_LIMIT: usize = 4_096;

/// Why ace stopped Git (`stopAtCapture` or `stopAfterMs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    Capture,
    Budget,
}

impl StopReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Budget => "budget",
        }
    }
}

/// Result of one `execute_raw` call (`Output` in `cli.ts`).
#[derive(Debug, Clone)]
pub struct ExecuteRawOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: i32,
    pub truncated: bool,
    pub stopped: Option<StopReason>,
    pub cleanup_id: Option<u64>,
    pub cleanup_group_pid: Option<u32>,
}

/// Streaming callbacks invoked while a child runs (`consume`, `output`, `stderr`).
pub trait StreamCallbacks: Send + Sync {
    fn on_stdout(&self, chunk: Vec<u8>) -> BoxFuture<'_, Result<(), GitError>>;
    fn on_stderr(&self, chunk: Vec<u8>) -> BoxFuture<'_, Result<(), GitError>>;
}

/// Optional streaming stdin commands (for Node `Readable` inputs).
#[derive(Debug)]
pub enum StdinCommand {
    Write(Vec<u8>),
    End,
    Error(GitError),
}

/// Parameters for one `execute_raw` invocation.
pub struct ExecuteRawOptions {
    pub cwd: String,
    pub args: Vec<String>,
    pub binary: Option<String>,
    pub env: Vec<(String, String)>,
    pub write: bool,
    pub strip_askpass: bool,
    pub execution_disabled: bool,
    pub allow_failure: bool,
    pub capture_bytes: Option<usize>,
    pub timeout_ms: Option<u64>,
    pub stop_at_capture: bool,
    pub stop_after_ms: Option<u64>,
    pub bounded: bool,
    pub has_input: bool,
    pub input: Option<Vec<u8>>,
    pub stdin_rx: Option<mpsc::UnboundedReceiver<StdinCommand>>,
    pub stream_stdout: bool,
    pub stream_stderr: bool,
    pub callbacks: Option<Arc<dyn StreamCallbacks>>,
    pub leases_json: String,
    pub aborted_before_dispatch: bool,
}

/// Settlement record for a killed call's cleanup, awaited by `error.cleanup.settled`.
#[derive(Debug, Clone)]
pub struct CleanupEntry {
    pub result: CleanupResult,
    pub group_pid: Option<u32>,
}

/// Tracks in-flight cleanup settlements by opaque id so `GitError` can cross N-API cleanly.
#[derive(Default)]
pub struct CleanupRegistry {
    next_id: AtomicU64,
    entries: Mutex<HashMap<u64, watch::Receiver<Option<CleanupEntry>>>>,
}

impl CleanupRegistry {
    pub fn register(&self) -> (u64, watch::Sender<Option<CleanupEntry>>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = watch::channel(None);
        if let Ok(mut map) = self.entries.lock() {
            map.insert(id, rx);
        }
        (id, tx)
    }

    pub async fn wait(&self, id: u64) -> CleanupEntry {
        let rx = self
            .entries
            .lock()
            .ok()
            .and_then(|map| map.get(&id).cloned());
        let Some(mut rx) = rx else {
            return CleanupEntry {
                result: CleanupResult::Unconfirmed {
                    reason: "Unknown cleanup receipt".to_owned(),
                },
                group_pid: None,
            };
        };
        loop {
            if let Some(entry) = rx.borrow().clone() {
                if let Ok(mut map) = self.entries.lock() {
                    map.remove(&id);
                }
                return entry;
            }
            if rx.changed().await.is_err() {
                return CleanupEntry {
                    result: CleanupResult::Unconfirmed {
                        reason: "Cleanup settlement channel closed".to_owned(),
                    },
                    group_pid: None,
                };
            }
        }
    }
}

/// Cancellation handle for one in-flight call (caller abort or service close).
#[derive(Default)]
pub struct CallCancel {
    aborted: AtomicBool,
    closed: AtomicBool,
    notify: Notify,
}

impl CallCancel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn abort(&self) {
        self.aborted.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    pub fn is_aborted(&self) -> bool {
        self.aborted.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub async fn notified(&self) {
        self.notify.notified().await;
    }

    /// Resolves once the call is aborted or the service closed, registering
    /// before it reads either flag so the wakeup is never lost.
    pub async fn cancelled(&self) {
        crate::core::wake::wait_until(|| self.is_aborted() || self.is_closed(), &self.notify).await;
    }

    /// Resolves once the service closed. An abort alone does not.
    pub async fn closed(&self) {
        crate::core::wake::wait_until(|| self.is_closed(), &self.notify).await;
    }
}

/// Configuration for [`GitCliCore`].
pub struct GitCliConfig {
    pub configured_binary: Option<String>,
    pub timeout_ms: Option<f64>,
}

/// Native core process runner backing `GitCli` (`cli.ts`).
pub struct GitCliCore {
    pub ports: Arc<ProcessPorts>,
    pub configured_binary: Option<String>,
    pub timeout_ms: u64,
    resolved_binary: Mutex<Option<String>>,
    closed: AtomicBool,
    active_calls: AtomicUsize,
    active_zero: Notify,
    cancellations: Mutex<HashMap<u64, Arc<CallCancel>>>,
    next_call_id: AtomicU64,
    drains: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    pub cleanups: Arc<CleanupRegistry>,
    stopped_jobs: Arc<StoppedJobs>,
}

impl GitCliCore {
    pub fn new(config: GitCliConfig, ports: Arc<ProcessPorts>) -> Result<Self, GitError> {
        if let Some(ref bin) = config.configured_binary
            && (bin.is_empty() || bin.contains('\0'))
        {
            return Err(GitError::new(
                GitErrorCode::InvalidArgument,
                "gitBinary must name an executable",
            ));
        }
        let timeout_ms = validate_timeout_ms(config.timeout_ms)?;
        Ok(Self {
            ports,
            configured_binary: config.configured_binary,
            timeout_ms,
            resolved_binary: Mutex::new(None),
            closed: AtomicBool::new(false),
            active_calls: AtomicUsize::new(0),
            active_zero: Notify::new(),
            cancellations: Mutex::new(HashMap::new()),
            next_call_id: AtomicU64::new(1),
            drains: Mutex::new(Vec::new()),
            cleanups: Arc::new(CleanupRegistry::default()),
            stopped_jobs: Arc::new(StoppedJobs::new()),
        })
    }

    pub fn platform(&self) -> &str {
        &self.ports.platform
    }

    pub fn binary(&self) -> String {
        if let Some(ref bin) = self.configured_binary {
            return bin.clone();
        }
        if let Ok(guard) = self.resolved_binary.lock()
            && let Some(ref resolved) = *guard
        {
            return resolved.clone();
        }
        "git".to_owned()
    }

    pub fn set_resolved_binary(&self, binary: Option<String>) {
        if let Ok(mut guard) = self.resolved_binary.lock() {
            *guard = binary;
        }
    }

    pub fn active_calls(&self) -> usize {
        self.active_calls.load(Ordering::Acquire)
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn register_cancel(&self) -> (u64, Arc<CallCancel>) {
        let id = self.next_call_id.fetch_add(1, Ordering::Relaxed);
        let cancel = CallCancel::new();
        if self.is_closed() {
            cancel.close();
        }
        if let Ok(mut map) = self.cancellations.lock() {
            map.insert(id, Arc::clone(&cancel));
        }
        (id, cancel)
    }

    pub fn abort_call(&self, call_id: u64) {
        if let Ok(map) = self.cancellations.lock()
            && let Some(cancel) = map.get(&call_id)
        {
            cancel.abort();
        }
    }

    fn unregister_cancel(&self, call_id: u64) {
        if let Ok(mut map) = self.cancellations.lock() {
            map.remove(&call_id);
        }
    }

    /// Cancellable pause using the injected timeout scheduler (`GitCli.pause`).
    pub async fn pause(&self, milliseconds: u64) -> Result<(), GitError> {
        if self.is_closed() {
            return Err(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
        }
        let (call_id, cancel) = self.register_cancel();
        let done = Arc::new(AtomicBool::new(false));
        let timer_notify = Arc::new(Notify::new());
        let d = Arc::clone(&done);
        let n = Arc::clone(&timer_notify);
        let handle = self.ports.scheduler.schedule(
            milliseconds,
            Box::new(move || {
                d.store(true, Ordering::Release);
                n.notify_waiters();
            }),
        );
        let result = loop {
            // The timer registers before its flag is read, and `closed()`
            // registers before it reads the close flag, so neither wakeup is lost.
            let timer = timer_notify.notified();
            tokio::pin!(timer);
            timer.as_mut().enable();
            if cancel.is_closed() {
                break Err(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
            }
            if done.load(Ordering::Acquire) {
                break Ok(());
            }
            tokio::select! {
                biased;
                _ = cancel.closed() => {}
                _ = &mut timer => {}
            }
        };
        handle.cancel();
        self.unregister_cancel(call_id);
        result
    }

    /// Bounded shutdown (`GitCli.close`): cancels every active call/pause and drains exits.
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        let cancels: Vec<Arc<CallCancel>> = self
            .cancellations
            .lock()
            .map(|map| map.values().cloned().collect())
            .unwrap_or_default();
        for cancel in cancels {
            cancel.close();
        }
        while self.active_calls.load(Ordering::Acquire) > 0 {
            crate::core::wake::wait_until(
                || self.active_calls.load(Ordering::Acquire) == 0,
                &self.active_zero,
            )
            .await;
        }
        let drains: Vec<tokio::task::JoinHandle<()>> = self
            .drains
            .lock()
            .map(|mut vec| std::mem::take(&mut *vec))
            .unwrap_or_default();
        for handle in drains {
            let _ = handle.await;
        }
    }

    /// Execute one Git command directly (`GitCli.executeRaw`).
    pub async fn execute_raw(
        self: &Arc<Self>,
        mut opts: ExecuteRawOptions,
        call_id: u64,
        cancel: Arc<CallCancel>,
    ) -> Result<ExecuteRawOutput, GitError> {
        if self.is_closed() {
            self.unregister_cancel(call_id);
            return Err(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
        }
        if opts.aborted_before_dispatch || cancel.is_aborted() {
            self.unregister_cancel(call_id);
            return Err(GitError::new(
                GitErrorCode::GitCancelled,
                "Git operation cancelled before dispatch",
            ));
        }
        self.active_calls.fetch_add(1, Ordering::AcqRel);
        let res = self.execute_raw_inner(&mut opts, cancel, call_id).await;
        self.unregister_cancel(call_id);
        if self.active_calls.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.active_zero.notify_waiters();
        }
        res
    }

    async fn execute_raw_inner(
        self: &Arc<Self>,
        opts: &mut ExecuteRawOptions,
        cancel: Arc<CallCancel>,
        call_id: u64,
    ) -> Result<ExecuteRawOutput, GitError> {
        let binary = opts.binary.clone().unwrap_or_else(|| self.binary());
        let mut env_map: BTreeMap<String, String> = inherited_env_pairs().into_iter().collect();
        env_map.insert("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned());
        env_map.insert("LC_ALL".to_owned(), "C".to_owned());
        if !opts.write {
            env_map.insert("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned());
        }
        for (k, v) in &opts.env {
            env_map.insert(k.clone(), v.clone());
        }
        let mut effective_args = opts.args.clone();
        if self.ports.platform == "win32" {
            effective_args = windows_hookless_args(&effective_args);
            windows_hookless_env(&mut env_map);
            windows_long_paths_env(&mut env_map);
        }
        if opts.strip_askpass {
            env_map.remove("SSH_ASKPASS");
            env_map.insert("GIT_ASKPASS".to_owned(), String::new());
            env_map.insert("GIT_TERMINAL_PROMPT".to_owned(), "0".to_owned());
        }

        if cancel.is_aborted() {
            return Err(GitError::new(
                GitErrorCode::GitCancelled,
                "Git operation cancelled before dispatch",
            ));
        }

        let job = if self.ports.platform == "win32" && self.ports.cleanup_supervisor.is_none() {
            self.ports
                .job_ports
                .as_ref()
                .and_then(|jp| GitJob::prepare(Arc::clone(jp), Arc::clone(&self.stopped_jobs)))
        } else {
            None
        };

        let mut spawn_args = Vec::with_capacity(effective_args.len() + 1);
        spawn_args.push("--no-pager".to_owned());
        spawn_args.extend(effective_args.iter().cloned());

        let spawned = self
            .ports
            .spawner
            .spawn(SpawnRequest {
                command: binary.clone(),
                args: spawn_args,
                cwd: Some(opts.cwd.clone()),
                env: env_map.into_iter().collect(),
                detached: self.ports.platform != "win32",
                hide_window: true,
            })
            .await;
        let child = spawned.child;
        let events = spawned.events;
        let pid = child.pid();
        let contained = match (job, pid) {
            (Some(j), Some(p)) if j.adopt(p) => Some(Arc::new(j)),
            _ => None,
        };
        if let Some(p) = pid {
            running_children().add(p);
            self.ports.notify_pid(p, true);
        }

        // Write static stdin (if any) and close stdin when not streaming.
        if let Some(bytes) = opts.input.take() {
            if !bytes.is_empty() {
                let _ = child.write_stdin(bytes);
            }
            child.end_stdin();
        } else if opts.stdin_rx.is_none() {
            child.end_stdin();
        }

        let deadline = opts.timeout_ms.unwrap_or(self.timeout_ms);
        let deadline_hit = Arc::new(AtomicBool::new(false));
        let budget_hit = Arc::new(AtomicBool::new(false));
        let timer_notify = Arc::new(Notify::new());

        let d_flag = Arc::clone(&deadline_hit);
        let d_notify = Arc::clone(&timer_notify);
        let cancel_deadline = self.ports.scheduler.schedule(
            deadline,
            Box::new(move || {
                d_flag.store(true, Ordering::Release);
                d_notify.notify_waiters();
            }),
        );

        let cancel_budget = opts.stop_after_ms.map(|ms| {
            let b_flag = Arc::clone(&budget_hit);
            let b_notify = Arc::clone(&timer_notify);
            self.ports.scheduler.schedule(
                ms,
                Box::new(move || {
                    b_flag.store(true, Ordering::Release);
                    b_notify.notify_waiters();
                }),
            )
        });

        let limit = opts.capture_bytes.unwrap_or(DEFAULT_CAPTURE_BYTES);
        let bounded = opts.stop_at_capture || opts.stop_after_ms.is_some() || opts.bounded;
        let mut stdout_chunks: Vec<Vec<u8>> = Vec::new();
        let mut stderr_raw: Vec<u8> = Vec::new();
        let mut captured: usize = 0;
        let mut truncated = false;
        let mut diagnostics = GitDiagnostics::new();
        let mut tail = StderrTail::new();
        let mut stdin_error: Option<String> = None;
        let mut stdin_finished = false;
        let mut spawn_error: Option<(Option<String>, String)> = None;
        let mut failure: Option<GitError> = None;
        let mut enough: Option<StopReason> = None;
        let mut close_result: Option<(Option<i32>, Option<String>)> = None;

        // Check immediate cancellation / close after spawn.
        if cancel.is_aborted() {
            failure = Some(GitError::new(
                GitErrorCode::GitCancelled,
                "Git operation cancelled",
            ));
        } else if cancel.is_closed() || self.is_closed() {
            failure = Some(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
        }

        let mut stdin_rx = opts.stdin_rx.take();
        // Sizes of the writes not yet acknowledged, so each ack names its chunk.
        let mut stdin_written: VecDeque<usize> = VecDeque::new();

        while failure.is_none() && enough.is_none() && close_result.is_none() {
            // The timer registers before its flag is read, and `cancelled()`
            // registers before it reads abort and close, so neither wakeup is lost.
            let expired = timer_notify.notified();
            tokio::pin!(expired);
            expired.as_mut().enable();
            if deadline_hit.load(Ordering::Acquire) {
                failure = Some(
                    GitError::new(
                        GitErrorCode::GitTimeout,
                        format!("Git exceeded {deadline}ms"),
                    )
                    .with_detail("args", json_string_array(&effective_args)),
                );
                break;
            }
            if budget_hit.load(Ordering::Acquire) {
                enough = Some(StopReason::Budget);
                break;
            }
            if cancel.is_aborted() {
                failure = Some(GitError::new(
                    GitErrorCode::GitCancelled,
                    "Git operation cancelled",
                ));
                break;
            }
            if cancel.is_closed() || self.is_closed() {
                failure = Some(GitError::new(GitErrorCode::GitClosed, "Git service closed"));
                break;
            }

            tokio::select! {
                biased;
                _ = cancel.cancelled() => {}
                _ = &mut expired => {}
                cmd = async {
                    match stdin_rx.as_mut() {
                        Some(rx) => rx.recv().await,
                        None => std::future::pending().await,
                    }
                } => {
                    match cmd {
                        Some(StdinCommand::Write(bytes)) => {
                            let len = bytes.len();
                            if child.write_stdin(bytes).is_ok() {
                                stdin_written.push_back(len);
                            }
                        }
                        Some(StdinCommand::End) | None => {
                            stdin_rx = None;
                            child.end_stdin();
                        }
                        Some(StdinCommand::Error(err)) => {
                            stdin_rx = None;
                            failure = Some(err);
                        }
                    }
                }
                ev = events.recv() => match ev {
                    Some(ProcessEvent::Stdout(chunk)) => {
                        let bytes = chunk.bytes;
                        if opts.stream_stdout {
                            if let Some(ref cb) = opts.callbacks {
                                tokio::select! {
                                    biased;
                                    _ = cancel.cancelled() => {}
                                    _ = expired_stop(&deadline_hit, &budget_hit, &timer_notify) => {}
                                    res = cb.on_stdout(bytes) => {
                                        if let Err(err) = res {
                                            failure = Some(err);
                                        }
                                    }
                                }
                            }
                        } else {
                            let remaining = limit.saturating_sub(captured);
                            if remaining > 0 {
                                let take = remaining.min(bytes.len());
                                stdout_chunks.push(bytes[..take].to_vec());
                                captured += take;
                            }
                            if bytes.len() > remaining {
                                truncated = true;
                                if opts.capture_bytes.is_none() {
                                    failure = Some(
                                        GitError::new(
                                            GitErrorCode::OutputTooLarge,
                                            "Git metadata exceeded 64 MiB",
                                        )
                                        .with_detail("args", json_string_array(&effective_args)),
                                    );
                                }
                            }
                            if opts.stop_at_capture && captured >= limit && failure.is_none() && enough.is_none() {
                                truncated = true;
                                enough = Some(StopReason::Capture);
                            }
                        }
                    }
                    Some(ProcessEvent::Stderr(chunk)) => {
                        let bytes = chunk.bytes;
                        if opts.stream_stderr
                            && let Some(ref cb) = opts.callbacks
                        {
                            tokio::select! {
                                biased;
                                _ = cancel.cancelled() => {}
                                _ = expired_stop(&deadline_hit, &budget_hit, &timer_notify) => {}
                                res = cb.on_stderr(bytes.clone()) => {
                                    if let Err(err) = res {
                                        failure = Some(err);
                                    }
                                }
                            }
                        }
                        diagnostics.accept(&bytes);
                        tail.accept(&bytes);
                        let keep = bytes.len().min(STDERR_RAW_LIMIT.saturating_sub(stderr_raw.len()));
                        if keep > 0 {
                            stderr_raw.extend_from_slice(&bytes[..keep]);
                        }
                    }
                    Some(ProcessEvent::StdoutError { code, message })
                    | Some(ProcessEvent::StderrError { code, message }) => {
                        failure = Some(match code {
                            Some(errno) => GitError::filesystem(errno, message),
                            None => GitError::new(GitErrorCode::GitFailed, message),
                        });
                    }
                    Some(ProcessEvent::StdinError { message, .. }) => {
                        if stdin_error.is_none() {
                            stdin_error = Some(message);
                        }
                    }
                    Some(ProcessEvent::StdinFinish) => {
                        stdin_finished = true;
                    }
                    Some(ProcessEvent::StdinAck) => {
                        if let Some(bytes) = stdin_written.pop_front() {
                            self.ports.notify_stdin_ack(call_id, bytes);
                        }
                    }
                    Some(ProcessEvent::SpawnError { code, message }) => {
                        if code.as_deref() == Some("ENOENT") && self.configured_binary.is_none() {
                            self.set_resolved_binary(None);
                        }
                        spawn_error = Some((code, message));
                    }
                    Some(ProcessEvent::Exit { pid: exit_pid, .. }) => {
                        if let Some(p) = exit_pid.or(pid) {
                            running_children().remove(p);
                            self.ports.notify_pid(p, false);
                        }
                    }
                    Some(ProcessEvent::Close { code, signal }) => {
                        if let Some(p) = pid {
                            running_children().remove(p);
                            self.ports.notify_pid(p, false);
                        }
                        close_result = Some((code, signal));
                    }
                    None => {
                        if let Some(p) = pid {
                            running_children().remove(p);
                            self.ports.notify_pid(p, false);
                        }
                        close_result = Some((None, None));
                    }
                }
            }
        }

        // Handle signal termination on Close as a kill path (matching cli.ts:1155).
        if let Some((_, Some(sig))) = &close_result
            && spawn_error.is_none()
            && failure.is_none()
            && enough.is_none()
        {
            let mut details = Map::new();
            details.insert(JsString::from("signal"), Value::from(sig.as_str()));
            details.insert(JsString::from("stderr"), Value::String(tail.text()));
            failure = Some(GitError::with_details(
                GitErrorCode::GitFailed,
                "Git terminated by signal",
                details,
            ));
        }

        cancel_deadline.cancel();
        if let Some(cb) = cancel_budget {
            cb.cancel();
        }

        if failure.is_some() || enough.is_some() {
            if let Some(p) = pid {
                running_children().remove(p);
                self.ports.notify_pid(p, false);
            }
            let drain_scheduler = Arc::clone(&self.ports.scheduler);
            let drain_child = Arc::clone(&child);
            let drain_handle = self.ports.runtime.spawn(async move {
                drain_process_exit(drain_scheduler.as_ref(), drain_child.as_ref()).await;
            });
            if let Ok(mut drains) = self.drains.lock() {
                drains.retain(|h| !h.is_finished());
                drains.push(drain_handle);
            }

            let (cleanup_id, cleanup_tx) = self.cleanups.register();
            let ports_clone = Arc::clone(&self.ports);
            let child_clone = Arc::clone(&child);
            let leases_json = opts.leases_json.clone();
            let contained_clone = contained.clone();

            self.ports.runtime.spawn(async move {
                let entry = if let Some(job) = contained_clone {
                    let adapter = SchedulerAdapter(Arc::clone(&ports_clone.scheduler));
                    let result = job.stop(&adapter).await;
                    CleanupEntry {
                        result,
                        group_pid: pid,
                    }
                } else if let Some(ref sup) = ports_clone.cleanup_supervisor
                    && let Some(spawn_id) = child_clone.spawn_id()
                {
                    match sup.stop(spawn_id, leases_json).await {
                        Ok(result) => CleanupEntry {
                            result,
                            group_pid: None,
                        },
                        Err(_) => {
                            kill_tree(&ports_clone, Arc::clone(&child_clone)).await;
                            CleanupEntry {
                                result: CleanupResult::Unconfirmed {
                                    reason: "Cleanup supervisor failed".to_owned(),
                                },
                                group_pid: None,
                            }
                        }
                    }
                } else {
                    let group_pid = if ports_clone.platform != "win32" {
                        pid
                    } else {
                        None
                    };
                    kill_tree(&ports_clone, Arc::clone(&child_clone)).await;
                    CleanupEntry {
                        result: CleanupResult::Unconfirmed {
                            reason: format!(
                                "No escaped-descendant containment on {}",
                                ports_clone.platform
                            ),
                        },
                        group_pid,
                    }
                };
                let _ = cleanup_tx.send(Some(entry));
            });

            let sync_group_pid = if contained.is_some() {
                pid
            } else if self.ports.cleanup_supervisor.is_some() && child.spawn_id().is_some() {
                None
            } else if self.ports.platform != "win32" {
                pid
            } else {
                None
            };

            if let Some(ref mut err) = failure {
                err.cleanup_id = Some(cleanup_id);
                err.cleanup_group_pid = sync_group_pid;
            }
            child.destroy();

            if let Some(reason) = enough
                && failure.is_none()
            {
                group_gone(&self.ports, child.as_ref(), 3_000).await;
                return Ok(ExecuteRawOutput {
                    stdout: concat_chunks(stdout_chunks),
                    stderr: String::from_utf8_lossy(&stderr_raw).into_owned(),
                    exit_code: 0,
                    truncated: true,
                    stopped: Some(reason),
                    cleanup_id: Some(cleanup_id),
                    cleanup_group_pid: sync_group_pid,
                });
            }
            if bounded {
                group_gone(&self.ports, child.as_ref(), 3_000).await;
            }
            return Err(failure
                .unwrap_or_else(|| GitError::new(GitErrorCode::GitFailed, "Git command failed")));
        }

        // Normal close path.
        if let Some(ref job) = contained {
            job.release();
        }
        if bounded
            && let Some(p) = pid
            && self.ports.platform != "win32"
        {
            if self.ports.group_alive(child.as_ref(), p).await {
                let _ = self.ports.signal_group(child.as_ref(), p, "SIGKILL").await;
            }
            group_gone(&self.ports, child.as_ref(), 3_000).await;
        }

        if let Some((code, msg)) = spawn_error {
            return Err(classify_spawn_error(
                code.as_deref(),
                &msg,
                &opts.cwd,
                &binary,
            ));
        }

        let code = close_result.and_then(|(c, _)| c);
        if code != Some(0) {
            diagnostics.accept_output(&output_tail(&stdout_chunks));
            let category = diagnostics.finish();
            if !opts.allow_failure
                || (opts.execution_disabled && category == GitErrorCode::ObjectsNotAvailable)
            {
                let mut details = Map::new();
                if let Some(c) = code {
                    details.insert(
                        JsString::from("code"),
                        Value::Number(Number::from(c as f64)),
                    );
                } else {
                    details.insert(JsString::from("code"), Value::Null);
                }
                details.insert(JsString::from("stderr"), Value::String(tail.text()));
                if let Some(ref lock) = diagnostics.lock_file {
                    details.insert(JsString::from("lock"), Value::from(lock.as_str()));
                }
                return Err(GitError::with_details(
                    category,
                    failure_message(category),
                    details,
                ));
            }
        }

        if code == Some(0) && opts.has_input && (stdin_error.is_some() || !stdin_finished) {
            let mut details = Map::new();
            details.insert(JsString::from("code"), Value::Number(Number::from(0.0)));
            details.insert(JsString::from("stderr"), Value::String(tail.text()));
            if let Some(ref cause) = stdin_error {
                details.insert(JsString::from("cause"), Value::from(cause.as_str()));
            }
            return Err(GitError::with_details(
                GitErrorCode::GitFailed,
                "Git stopped reading its input before the end",
                details,
            ));
        }

        Ok(ExecuteRawOutput {
            stdout: concat_chunks(stdout_chunks),
            stderr: String::from_utf8_lossy(&stderr_raw).into_owned(),
            exit_code: code.unwrap_or(-1),
            truncated,
            stopped: None,
            cleanup_id: None,
            cleanup_group_pid: None,
        })
    }

    pub fn job_alive(&self, pid: u32) -> bool {
        self.stopped_jobs.job_alive(pid) || global_stopped_jobs().job_alive(pid)
    }
}

/// Resolves once the deadline or the work budget fired, registering before it
/// reads either flag so the wakeup is never lost.
async fn expired_stop(deadline: &AtomicBool, budget: &AtomicBool, notify: &Notify) {
    crate::core::wake::wait_until(
        || deadline.load(Ordering::Acquire) || budget.load(Ordering::Acquire),
        notify,
    )
    .await;
}

/// Exact UTF-8 scalar output (`textOutput` in `cli.ts`): strict UTF-8, strip one trailing `\n`.
pub fn text_output(stdout: &[u8]) -> Result<String, GitError> {
    let text = std::str::from_utf8(stdout)
        .map_err(|_| GitError::new(GitErrorCode::MalformedOutput, "Malformed Git UTF-8 scalar"))?;
    Ok(text.strip_suffix('\n').unwrap_or(text).to_owned())
}

/// Streaming patch output (`patchOutput` in `cli.ts`): omits incomplete trailing UTF-8 sequence when truncated.
pub fn patch_output(stdout: &[u8], truncated: bool) -> String {
    if !truncated {
        return String::from_utf8_lossy(stdout).into_owned();
    }
    let mut out = String::new();
    let mut slice = stdout;
    loop {
        match std::str::from_utf8(slice) {
            Ok(valid) => {
                out.push_str(valid);
                break;
            }
            Err(err) => {
                let up_to = err.valid_up_to();
                if up_to > 0
                    && let Ok(valid) = std::str::from_utf8(&slice[..up_to])
                {
                    out.push_str(valid);
                }
                slice = &slice[up_to..];
                if let Some(len) = err.error_len() {
                    out.push('\u{FFFD}');
                    slice = &slice[len..];
                } else {
                    // Truncated mid-codepoint: omit incomplete trailing bytes, matching StringDecoder.write.
                    break;
                }
            }
        }
    }
    out
}

fn concat_chunks(chunks: Vec<Vec<u8>>) -> Vec<u8> {
    let total: usize = chunks.iter().map(Vec::len).sum();
    let mut out = Vec::with_capacity(total);
    for chunk in chunks {
        out.extend_from_slice(&chunk);
    }
    out
}

fn output_tail(chunks: &[Vec<u8>]) -> String {
    let mut parts: Vec<&[u8]> = Vec::new();
    let mut bytes = 0usize;
    for chunk in chunks.iter().rev() {
        if bytes >= OUTPUT_TAIL_LIMIT {
            break;
        }
        let need = OUTPUT_TAIL_LIMIT - bytes;
        let slice = &chunk[chunk.len().saturating_sub(need)..];
        parts.push(slice);
        bytes += slice.len();
    }
    parts.reverse();
    let mut buf = Vec::with_capacity(bytes);
    for part in parts {
        buf.extend_from_slice(part);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn windows_private_hooks_dir() -> &'static str {
    static DIR: OnceLock<String> = OnceLock::new();
    DIR.get_or_init(|| {
        let base = std::env::temp_dir();
        let pid = std::process::id();
        for attempt in 0u32..1000 {
            let candidate = base.join(format!("ace-git-hooks-{pid}-{attempt}"));
            if std::fs::create_dir(&candidate).is_ok() {
                return candidate.to_string_lossy().into_owned();
            }
        }
        base.join(format!("ace-git-hooks-{pid}"))
            .to_string_lossy()
            .into_owned()
    })
}

/// Windows only: rewrite `-c core.hooksPath=/dev/null` to a private empty directory.
pub fn windows_hookless_args(args: &[String]) -> Vec<String> {
    args.iter()
        .enumerate()
        .map(|(index, arg)| {
            if index > 0 && args[index - 1] == "-c" && arg == "core.hooksPath=/dev/null" {
                format!("core.hooksPath={}", windows_private_hooks_dir())
            } else {
                arg.clone()
            }
        })
        .collect()
}

/// Windows only: rewrite `GIT_CONFIG_KEY_i=core.hooksPath` with `/dev/null` value.
pub fn windows_hookless_env(env: &mut BTreeMap<String, String>) {
    let count = env
        .get("GIT_CONFIG_COUNT")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    for idx in 0..count {
        let key_name = format!("GIT_CONFIG_KEY_{idx}");
        let val_name = format!("GIT_CONFIG_VALUE_{idx}");
        if env.get(&key_name).map(String::as_str) == Some("core.hooksPath")
            && env.get(&val_name).map(String::as_str) == Some("/dev/null")
        {
            env.insert(val_name, windows_private_hooks_dir().to_owned());
        }
    }
}

/// Windows only: append `core.longpaths=true` to `GIT_CONFIG_*` entries.
pub fn windows_long_paths_env(env: &mut BTreeMap<String, String>) {
    let count = match env.get("GIT_CONFIG_COUNT") {
        None => 0usize,
        Some(raw) => match raw.parse::<usize>() {
            Ok(n) => n,
            Err(_) => return,
        },
    };
    env.insert(
        format!("GIT_CONFIG_KEY_{count}"),
        "core.longpaths".to_owned(),
    );
    env.insert(format!("GIT_CONFIG_VALUE_{count}"), "true".to_owned());
    env.insert("GIT_CONFIG_COUNT".to_owned(), (count + 1).to_string());
}

/// Parse `git --version` output, requiring Git >= 2.40.0.
pub fn verify_git_version(stdout: &[u8], binary: &str) -> Result<(), GitError> {
    let text = text_output(stdout)?;
    let rest = text.strip_prefix("git version ");
    let parsed = rest.and_then(|s| {
        let mut nums = s
            .split(|c: char| !c.is_ascii_digit())
            .filter(|part| !part.is_empty());
        let major: u32 = nums.next()?.parse().ok()?;
        let minor: u32 = nums.next()?.parse().ok()?;
        let _patch: u32 = nums.next()?.parse().ok()?;
        Some((major, minor))
    });
    match parsed {
        Some((major, minor)) if major > 2 || (major == 2 && minor >= 40) => Ok(()),
        _ => {
            let version = String::from_utf8_lossy(stdout).trim().to_owned();
            Err(
                GitError::new(GitErrorCode::GitTooOld, "ace requires Git 2.40 or newer")
                    .with_detail("binary", Value::from(binary))
                    .with_detail("version", Value::from(version.as_str())),
            )
        }
    }
}

/// Probe stub kept for compatibility with G0 callers.
pub fn probe(op: &str) -> Result<(), crate::error::Error> {
    Err(crate::error::Error::unimplemented("core::cli", op))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_output_rejects_invalid_utf8_and_strips_single_newline() {
        assert_eq!(text_output(b"abc\n").ok().as_deref(), Some("abc"));
        assert_eq!(text_output(b"abc\n\n").ok().as_deref(), Some("abc\n"));
        assert!(matches!(
            text_output(&[0xff, 0xfe]),
            Err(GitError {
                code: GitErrorCode::MalformedOutput,
                ..
            })
        ));
    }

    #[test]
    fn patch_output_drops_incomplete_utf8_only_when_truncated() {
        let bytes = [b'a', 0xe2, 0x82];
        assert_eq!(patch_output(&bytes, true), "a");
        assert_eq!(patch_output(&bytes, false), "a\u{FFFD}");
    }

    #[test]
    fn verify_git_version_checks_minimum_2_40() {
        assert!(verify_git_version(b"git version 2.40.0\n", "git").is_ok());
        assert!(verify_git_version(b"git version 2.48.1 (Apple Git-155)\n", "git").is_ok());
        assert!(matches!(
            verify_git_version(b"git version 2.39.5\n", "git"),
            Err(GitError {
                code: GitErrorCode::GitTooOld,
                ..
            })
        ));
    }
}
