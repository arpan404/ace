// SPDX-License-Identifier: Apache-2.0
//! The port bridge (G2a): each `GitProcessRuntime` member the caller injected
//! crosses to the core through one weak threadsafe function (`PortCallFn`),
//! and an injected `spawn`'s `ChildProcess` feeds stdin, stdout, stderr, error,
//! exit, and close events through one ordered per-spawn queue.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use ace_git::core::cli::StreamCallbacks;
use ace_git::core::error::{CleanupResult, GitError, GitErrorCode};
use ace_git::core::spawn::{
    BoxFuture, CancelHandle, CleanupSupervisorPort, GitLocatorPort, GroupPort, ProcessChild,
    ProcessEvent, ProcessSpawner, SpawnRequest, SpawnedProcess, TimeoutScheduler,
};
use napi::Status;
use napi::bindgen_prelude::{FnArgs, Uint8Array};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tokio::sync::{Notify, mpsc, oneshot};

use super::{caught, unwind};

/// Weak threadsafe callback into the JS shell: `(eventJson, optionalBytes) => void`.
pub(crate) type PortCallFn = ThreadsafeFunction<
    FnArgs<(String, Uint8Array)>,
    (),
    FnArgs<(String, Uint8Array)>,
    Status,
    false,
    true,
>;

/// The ordered child-event queue kept for G0 bridge tests.
#[napi]
pub struct GitPortBridge {
    events: Mutex<BridgeState>,
}

struct BridgeState {
    events: Vec<String>,
    closed: bool,
}

#[napi]
impl GitPortBridge {
    /// Opens the bridge; the shell feeds one per `GitService` instance.
    #[napi(constructor, catch_unwind)]
    pub fn new() -> napi::Result<Self> {
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| BridgeState {
            events: Vec::new(),
            closed: false,
        })) {
            Ok(state) => Ok(Self {
                events: Mutex::new(state),
            }),
            Err(_) => Err(unwind("git port bridge open")),
        }
    }

    /// Feeds one ordered queue event as JSON; returns the queued count.
    #[napi(catch_unwind)]
    pub fn push_event(&self, event_json: String) -> napi::Result<f64> {
        caught("git port bridge push", || {
            let mut state = self.events.lock().map_err(|_| {
                ace_git::error::Error::Internal("git bridge lock failed".to_owned())
            })?;
            if state.closed {
                return Err(ace_git::error::Error::Internal(
                    "git bridge is closed".to_owned(),
                ));
            }
            state.events.push(event_json);
            Ok(state.events.len() as f64)
        })
    }

    /// Takes every queued event, in order.
    #[napi(catch_unwind)]
    pub fn drain(&self) -> napi::Result<Vec<String>> {
        caught("git port bridge drain", || {
            let mut state = self.events.lock().map_err(|_| {
                ace_git::error::Error::Internal("git bridge lock failed".to_owned())
            })?;
            Ok(std::mem::take(&mut state.events))
        })
    }

    /// Closes the bridge; the queue stays drained, no event arrives after.
    #[napi(catch_unwind)]
    pub fn close(&self) -> napi::Result<()> {
        caught("git port bridge close", || {
            let mut state = self.events.lock().map_err(|_| {
                ace_git::error::Error::Internal("git bridge lock failed".to_owned())
            })?;
            state.closed = true;
            Ok(())
        })
    }
}

/// The bridge's foundations version; the shells refuse a mismatch at startup.
#[napi(catch_unwind)]
pub fn git_bridge_version() -> napi::Result<String> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| "g0".to_owned())) {
        Ok(version) => Ok(version),
        Err(_) => Err(unwind("git bridge version")),
    }
}

struct BridgedChildEntry {
    tx: mpsc::UnboundedSender<ProcessEvent>,
    exited: Arc<AtomicBool>,
    exit_notify: Arc<Notify>,
    pid: Arc<AtomicU32>,
}

/// Shared port hub bridging injected JS runtime callbacks for one `NativeGitCore`.
pub(crate) struct PortHub {
    callback: PortCallFn,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<String>>>,
    spawns: Mutex<HashMap<u64, Arc<BridgedChildEntry>>>,
    timers: Mutex<HashMap<u64, Box<dyn FnOnce() + Send>>>,
}

impl PortHub {
    pub(crate) fn new(callback: PortCallFn) -> Self {
        Self {
            callback,
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            spawns: Mutex::new(HashMap::new()),
            timers: Mutex::new(HashMap::new()),
        }
    }

    fn alloc_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub(crate) fn emit(&self, json: String, bytes: Vec<u8>) {
        let _ = self.callback.call(
            FnArgs::from((json, Uint8Array::new(bytes))),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }

    async fn request_with_id(&self, req_id: u64, json: String, bytes: Vec<u8>) -> Option<String> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut map) = self.pending.lock() {
            map.insert(req_id, tx);
        }
        let status = self.callback.call(
            FnArgs::from((json, Uint8Array::new(bytes))),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        if status != Status::Ok {
            if let Ok(mut map) = self.pending.lock() {
                map.remove(&req_id);
            }
            return None;
        }
        rx.await.ok()
    }

    pub(crate) fn reply(&self, req_id: u64, reply_json: String) {
        let sender = self
            .pending
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&req_id));
        if let Some(tx) = sender {
            let _ = tx.send(reply_json);
        }
    }

    pub(crate) fn fire_timer(&self, timer_id: u64) {
        let cb = self
            .timers
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&timer_id));
        if let Some(callback) = cb {
            callback();
        }
    }

    pub(crate) fn push_spawn_event(
        &self,
        spawn_id: u64,
        kind: &str,
        payload_json: &str,
        chunk: Option<Vec<u8>>,
    ) {
        let entry = self
            .spawns
            .lock()
            .ok()
            .and_then(|map| map.get(&spawn_id).cloned());
        let Some(entry) = entry else {
            return;
        };
        #[derive(Deserialize, Default)]
        struct Payload {
            code: Option<serde_json::Value>,
            signal: Option<String>,
            pid: Option<u32>,
            message: Option<String>,
        }
        let payload: Payload = serde_json::from_str(payload_json).unwrap_or_default();
        let str_code = || {
            payload
                .code
                .as_ref()
                .and_then(|v| v.as_str())
                .map(str::to_owned)
        };
        let int_code = || {
            payload
                .code
                .as_ref()
                .and_then(|v| v.as_i64())
                .map(|n| n as i32)
        };

        let event = match kind {
            "stdout" => ProcessEvent::Stdout(chunk.unwrap_or_default()),
            "stderr" => ProcessEvent::Stderr(chunk.unwrap_or_default()),
            "stdout_error" => ProcessEvent::StdoutError {
                code: str_code(),
                message: payload.message.unwrap_or_default(),
            },
            "stderr_error" => ProcessEvent::StderrError {
                code: str_code(),
                message: payload.message.unwrap_or_default(),
            },
            "stdin_ack" => ProcessEvent::StdinAck,
            "stdin_finish" => ProcessEvent::StdinFinish,
            "stdin_error" => ProcessEvent::StdinError {
                code: str_code(),
                message: payload.message.unwrap_or_default(),
            },
            "spawn_error" => ProcessEvent::SpawnError {
                code: str_code(),
                message: payload.message.unwrap_or_default(),
            },
            "exit" => {
                if let Some(p) = payload.pid {
                    entry.pid.store(p, Ordering::Release);
                }
                entry.exited.store(true, Ordering::Release);
                entry.exit_notify.notify_waiters();
                ProcessEvent::Exit {
                    code: int_code(),
                    signal: payload.signal,
                    pid: payload.pid,
                }
            }
            "close" => {
                entry.exited.store(true, Ordering::Release);
                entry.exit_notify.notify_waiters();
                ProcessEvent::Close {
                    code: int_code(),
                    signal: payload.signal,
                }
            }
            _ => return,
        };
        let _ = entry.tx.send(event);
    }

    pub(crate) fn notify_pid(&self, pid: u32, alive: bool) {
        let op = if alive { "pid_add" } else { "pid_remove" };
        self.emit(format!("{{\"op\":\"{op}\",\"pid\":{pid}}}"), Vec::new());
    }
}

struct BridgedChild {
    hub: Arc<PortHub>,
    spawn_id: u64,
    pid: Arc<AtomicU32>,
    exited: Arc<AtomicBool>,
    exit_notify: Arc<Notify>,
}

impl ProcessChild for BridgedChild {
    fn pid(&self) -> Option<u32> {
        let p = self.pid.load(Ordering::Acquire);
        (p != 0).then_some(p)
    }

    fn spawn_id(&self) -> Option<u64> {
        Some(self.spawn_id)
    }

    fn exited(&self) -> bool {
        self.exited.load(Ordering::Acquire)
    }

    fn write_stdin(&self, bytes: Vec<u8>) -> Result<(), String> {
        self.hub.emit(
            format!("{{\"op\":\"stdin_write\",\"spawnId\":{}}}", self.spawn_id),
            bytes,
        );
        Ok(())
    }

    fn end_stdin(&self) {
        self.hub.emit(
            format!("{{\"op\":\"stdin_end\",\"spawnId\":{}}}", self.spawn_id),
            Vec::new(),
        );
    }

    fn kill_leader(&self, signal: &str) {
        #[derive(Serialize)]
        struct Msg<'a> {
            op: &'static str,
            #[serde(rename = "spawnId")]
            spawn_id: u64,
            signal: &'a str,
        }
        if let Ok(json) = serde_json::to_string(&Msg {
            op: "kill_leader",
            spawn_id: self.spawn_id,
            signal,
        }) {
            self.hub.emit(json, Vec::new());
        }
    }

    fn signal_group(&self, signal: &str) -> BoxFuture<'_, Result<(), String>> {
        let hub = Arc::clone(&self.hub);
        let spawn_id = self.spawn_id;
        let pid = self.pid();
        let signal = signal.to_owned();
        Box::pin(async move {
            let Some(pid) = pid else {
                return Err("no pid".to_owned());
            };
            call_signal_group(&hub, pid, &signal, Some(spawn_id)).await
        })
    }

    fn group_alive(&self) -> BoxFuture<'_, bool> {
        let hub = Arc::clone(&self.hub);
        let spawn_id = self.spawn_id;
        let pid = self.pid();
        Box::pin(async move {
            let Some(pid) = pid else {
                return false;
            };
            call_group_alive(&hub, pid, Some(spawn_id)).await
        })
    }

    fn destroy(&self) {
        self.hub.emit(
            format!("{{\"op\":\"destroy\",\"spawnId\":{}}}", self.spawn_id),
            Vec::new(),
        );
    }

    fn exit_notify(&self) -> Arc<Notify> {
        Arc::clone(&self.exit_notify)
    }
}

impl Drop for BridgedChild {
    fn drop(&mut self) {
        if let Ok(mut map) = self.hub.spawns.lock() {
            map.remove(&self.spawn_id);
        }
        self.hub.emit(
            format!("{{\"op\":\"release_child\",\"spawnId\":{}}}", self.spawn_id),
            Vec::new(),
        );
    }
}

pub(crate) struct JsSpawner {
    pub(crate) hub: Arc<PortHub>,
}

impl ProcessSpawner for JsSpawner {
    fn spawn(&self, request: SpawnRequest) -> BoxFuture<'_, SpawnedProcess> {
        let hub = Arc::clone(&self.hub);
        Box::pin(async move {
            let spawn_id = hub.alloc_id();
            let req_id = hub.alloc_id();
            let (tx, rx) = mpsc::unbounded_channel();
            let exited = Arc::new(AtomicBool::new(false));
            let exit_notify = Arc::new(Notify::new());
            let pid_cell = Arc::new(AtomicU32::new(0));
            let entry = Arc::new(BridgedChildEntry {
                tx: tx.clone(),
                exited: Arc::clone(&exited),
                exit_notify: Arc::clone(&exit_notify),
                pid: Arc::clone(&pid_cell),
            });
            if let Ok(mut map) = hub.spawns.lock() {
                map.insert(spawn_id, entry);
            }
            #[derive(Serialize)]
            struct SpawnMsg {
                op: &'static str,
                #[serde(rename = "reqId")]
                req_id: u64,
                #[serde(rename = "spawnId")]
                spawn_id: u64,
                command: String,
                args: Vec<String>,
                cwd: Option<String>,
                env: Vec<(String, String)>,
                detached: bool,
                #[serde(rename = "hideWindow")]
                hide_window: bool,
            }
            let json = serde_json::to_string(&SpawnMsg {
                op: "spawn",
                req_id,
                spawn_id,
                command: request.command,
                args: request.args,
                cwd: request.cwd,
                env: request.env,
                detached: request.detached,
                hide_window: request.hide_window,
            })
            .unwrap_or_default();

            #[derive(Deserialize, Default)]
            struct SpawnReply {
                pid: Option<u32>,
                error: Option<String>,
                code: Option<String>,
            }
            if let Some(reply_str) = hub.request_with_id(req_id, json, Vec::new()).await {
                let parsed: SpawnReply = serde_json::from_str(&reply_str).unwrap_or_default();
                if let Some(p) = parsed.pid {
                    pid_cell.store(p, Ordering::Release);
                }
                if let Some(err) = parsed.error {
                    exited.store(true, Ordering::Release);
                    exit_notify.notify_waiters();
                    let _ = tx.send(ProcessEvent::SpawnError {
                        code: parsed.code,
                        message: err,
                    });
                    let _ = tx.send(ProcessEvent::Close {
                        code: None,
                        signal: None,
                    });
                }
            }
            let child = Arc::new(BridgedChild {
                hub,
                spawn_id,
                pid: pid_cell,
                exited,
                exit_notify,
            });
            SpawnedProcess { child, events: rx }
        })
    }
}

pub(crate) struct JsScheduler {
    pub(crate) hub: Arc<PortHub>,
}

struct JsCancelHandle {
    hub: Arc<PortHub>,
    timer_id: u64,
}

impl CancelHandle for JsCancelHandle {
    fn cancel(&self) {
        let removed = self
            .hub
            .timers
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&self.timer_id))
            .is_some();
        if removed {
            self.hub.emit(
                format!("{{\"op\":\"cancel_timer\",\"timerId\":{}}}", self.timer_id),
                Vec::new(),
            );
        }
    }
}

impl TimeoutScheduler for JsScheduler {
    fn schedule(
        &self,
        milliseconds: u64,
        callback: Box<dyn FnOnce() + Send>,
    ) -> Box<dyn CancelHandle> {
        let timer_id = self.hub.alloc_id();
        if let Ok(mut map) = self.hub.timers.lock() {
            map.insert(timer_id, callback);
        }
        self.hub.emit(
            format!("{{\"op\":\"schedule\",\"timerId\":{timer_id},\"ms\":{milliseconds}}}"),
            Vec::new(),
        );
        Box::new(JsCancelHandle {
            hub: Arc::clone(&self.hub),
            timer_id,
        })
    }
}

pub(crate) struct JsGroupPort {
    pub(crate) hub: Arc<PortHub>,
}

impl GroupPort for JsGroupPort {
    fn signal_group(
        &self,
        pid: u32,
        signal: &str,
        spawn_id: Option<u64>,
    ) -> BoxFuture<'_, Result<(), String>> {
        let hub = Arc::clone(&self.hub);
        let signal = signal.to_owned();
        Box::pin(async move { call_signal_group(&hub, pid, &signal, spawn_id).await })
    }

    fn group_alive(&self, pid: u32, spawn_id: Option<u64>) -> BoxFuture<'_, bool> {
        let hub = Arc::clone(&self.hub);
        Box::pin(async move { call_group_alive(&hub, pid, spawn_id).await })
    }
}

async fn call_signal_group(
    hub: &PortHub,
    pid: u32,
    signal: &str,
    spawn_id: Option<u64>,
) -> Result<(), String> {
    let req_id = hub.alloc_id();
    #[derive(Serialize)]
    struct Msg<'a> {
        op: &'static str,
        #[serde(rename = "reqId")]
        req_id: u64,
        pid: u32,
        signal: &'a str,
        #[serde(rename = "spawnId")]
        spawn_id: Option<u64>,
    }
    let json = serde_json::to_string(&Msg {
        op: "signal_group",
        req_id,
        pid,
        signal,
        spawn_id,
    })
    .unwrap_or_default();
    let Some(reply) = hub.request_with_id(req_id, json, Vec::new()).await else {
        return Err("port bridge closed".to_owned());
    };
    #[derive(Deserialize, Default)]
    struct Reply {
        ok: bool,
        error: Option<String>,
    }
    let parsed: Reply = serde_json::from_str(&reply).unwrap_or_default();
    if parsed.ok {
        Ok(())
    } else {
        Err(parsed.error.unwrap_or_else(|| "signal failed".to_owned()))
    }
}

async fn call_group_alive(hub: &PortHub, pid: u32, spawn_id: Option<u64>) -> bool {
    let req_id = hub.alloc_id();
    #[derive(Serialize)]
    struct Msg {
        op: &'static str,
        #[serde(rename = "reqId")]
        req_id: u64,
        pid: u32,
        #[serde(rename = "spawnId")]
        spawn_id: Option<u64>,
    }
    let json = serde_json::to_string(&Msg {
        op: "group_alive",
        req_id,
        pid,
        spawn_id,
    })
    .unwrap_or_default();
    let Some(reply) = hub.request_with_id(req_id, json, Vec::new()).await else {
        return false;
    };
    #[derive(Deserialize, Default)]
    struct Reply {
        alive: bool,
    }
    serde_json::from_str::<Reply>(&reply).is_ok_and(|r| r.alive)
}

pub(crate) struct JsLocatorPort {
    pub(crate) hub: Arc<PortHub>,
}

impl GitLocatorPort for JsLocatorPort {
    fn locate_git(
        &self,
        env: Vec<(String, String)>,
        _cancel: Arc<AtomicBool>,
    ) -> Pin<Box<dyn Future<Output = Option<String>> + Send>> {
        let hub = Arc::clone(&self.hub);
        Box::pin(async move {
            let req_id = hub.alloc_id();
            #[derive(Serialize)]
            struct Msg {
                op: &'static str,
                #[serde(rename = "reqId")]
                req_id: u64,
                env: Vec<(String, String)>,
            }
            let json = serde_json::to_string(&Msg {
                op: "locate_git",
                req_id,
                env,
            })
            .ok()?;
            let reply = hub.request_with_id(req_id, json, Vec::new()).await?;
            #[derive(Deserialize, Default)]
            struct Reply {
                path: Option<String>,
            }
            serde_json::from_str::<Reply>(&reply)
                .ok()
                .and_then(|r| r.path)
        })
    }
}

pub(crate) struct JsCleanupSupervisorPort {
    pub(crate) hub: Arc<PortHub>,
}

impl CleanupSupervisorPort for JsCleanupSupervisorPort {
    fn stop(
        &self,
        spawn_id: u64,
        leases_json: String,
    ) -> Pin<Box<dyn Future<Output = Result<CleanupResult, String>> + Send>> {
        let hub = Arc::clone(&self.hub);
        Box::pin(async move {
            let req_id = hub.alloc_id();
            #[derive(Serialize)]
            struct Msg {
                op: &'static str,
                #[serde(rename = "reqId")]
                req_id: u64,
                #[serde(rename = "spawnId")]
                spawn_id: u64,
                #[serde(rename = "leasesJson")]
                leases_json: String,
            }
            let json = serde_json::to_string(&Msg {
                op: "cleanup_stop",
                req_id,
                spawn_id,
                leases_json,
            })
            .map_err(|e| e.to_string())?;
            let reply = hub
                .request_with_id(req_id, json, Vec::new())
                .await
                .ok_or_else(|| "port bridge closed".to_owned())?;
            #[derive(Deserialize, Default)]
            struct Reply {
                status: Option<String>,
                evidence: Option<String>,
                reason: Option<String>,
                error: Option<String>,
            }
            let parsed: Reply = serde_json::from_str(&reply).unwrap_or_default();
            if let Some(err) = parsed.error {
                return Err(err);
            }
            if parsed.status.as_deref() == Some("confirmed") {
                Ok(CleanupResult::Confirmed {
                    evidence: parsed.evidence.unwrap_or_default(),
                })
            } else {
                Ok(CleanupResult::Unconfirmed {
                    reason: parsed
                        .reason
                        .unwrap_or_else(|| "Cleanup unconfirmed".to_owned()),
                })
            }
        })
    }
}

pub(crate) struct JsStreamCallbacks {
    pub(crate) hub: Arc<PortHub>,
    pub(crate) call_id: u64,
}

impl StreamCallbacks for JsStreamCallbacks {
    fn on_stdout(&self, chunk: Vec<u8>) -> BoxFuture<'_, Result<(), GitError>> {
        let hub = Arc::clone(&self.hub);
        let call_id = self.call_id;
        Box::pin(async move { call_stream_cb(&hub, "stream_stdout", call_id, chunk).await })
    }

    fn on_stderr(&self, chunk: Vec<u8>) -> BoxFuture<'_, Result<(), GitError>> {
        let hub = Arc::clone(&self.hub);
        let call_id = self.call_id;
        Box::pin(async move { call_stream_cb(&hub, "stream_stderr", call_id, chunk).await })
    }
}

async fn call_stream_cb(
    hub: &PortHub,
    op: &'static str,
    call_id: u64,
    chunk: Vec<u8>,
) -> Result<(), GitError> {
    let req_id = hub.alloc_id();
    let json = format!("{{\"op\":\"{op}\",\"reqId\":{req_id},\"callId\":{call_id}}}");
    let Some(reply) = hub.request_with_id(req_id, json, chunk).await else {
        return Err(GitError::new(
            GitErrorCode::GitFailed,
            "Stream callback failed",
        ));
    };
    #[derive(Deserialize, Default)]
    struct Reply {
        ok: bool,
        code: Option<String>,
        errno: Option<String>,
        message: Option<String>,
    }
    let parsed: Reply = serde_json::from_str(&reply).unwrap_or_default();
    if parsed.ok {
        return Ok(());
    }
    if let Some(errno) = parsed.errno {
        return Err(GitError::filesystem(
            errno,
            parsed.message.unwrap_or_else(|| "Stream error".to_owned()),
        ));
    }
    let code = parsed
        .code
        .as_deref()
        .and_then(parse_git_error_code)
        .unwrap_or(GitErrorCode::GitFailed);
    Err(GitError::new(
        code,
        parsed.message.unwrap_or_else(|| "Stream error".to_owned()),
    ))
}

pub(crate) fn parse_git_error_code(raw: &str) -> Option<GitErrorCode> {
    match raw {
        "git_missing" => Some(GitErrorCode::GitMissing),
        "git_too_old" => Some(GitErrorCode::GitTooOld),
        "git_timeout" => Some(GitErrorCode::GitTimeout),
        "git_cancelled" => Some(GitErrorCode::GitCancelled),
        "git_closed" => Some(GitErrorCode::GitClosed),
        "git_busy" => Some(GitErrorCode::GitBusy),
        "filesystem_error" => Some(GitErrorCode::FilesystemError),
        "output_too_large" => Some(GitErrorCode::OutputTooLarge),
        "malformed_output" => Some(GitErrorCode::MalformedOutput),
        "invalid_argument" => Some(GitErrorCode::InvalidArgument),
        "git_failed" => Some(GitErrorCode::GitFailed),
        _ => None,
    }
}
