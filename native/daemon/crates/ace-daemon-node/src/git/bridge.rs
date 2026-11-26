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

use ace_git::core::lease::LocalLease;
use ace_git::core::lease::journal::LeaseRecord;
use ace_git::core::lease::processes::GitProcess;

use super::wire::{self, Frame};
use ace_git::core::cli::StreamCallbacks;
use ace_git::core::error::{CleanupResult, GitError, GitErrorCode};
use ace_git::core::events::{EventQueue, OutputChunk};
use ace_git::core::spawn::{
    BoxFuture, CancelHandle, CleanupSupervisorPort, GroupPort, ProcessChild, ProcessEvent,
    ProcessSpawner, SpawnRequest, SpawnedProcess, TimeoutScheduler,
};
use napi::Status;
use napi::bindgen_prelude::{FnArgs, Uint8Array};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::sync::{Notify, oneshot};

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
    queue: Arc<EventQueue>,
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
        let payload = wire::object(payload_json).unwrap_or_default();
        let code_value = wire::field(&payload, "code").cloned();
        let signal = wire::string(&payload, "signal");
        let pid = wire::count(&payload, "pid").map(|pid| pid as u32);
        let message = wire::string(&payload, "message");
        let str_code = || match code_value.as_ref() {
            Some(ace_json::Value::String(code)) => Some(code.to_string_lossy().into_owned()),
            _ => None,
        };
        let int_code = || match code_value.as_ref() {
            Some(ace_json::Value::Number(number)) => number.as_f64().map(|value| value as i32),
            _ => None,
        };

        let event = match kind {
            "stdout" => ProcessEvent::Stdout(OutputChunk::new(chunk.unwrap_or_default())),
            "stderr" => ProcessEvent::Stderr(OutputChunk::new(chunk.unwrap_or_default())),
            "stdout_error" => ProcessEvent::StdoutError {
                code: str_code(),
                message: message.clone().unwrap_or_default(),
            },
            "stderr_error" => ProcessEvent::StderrError {
                code: str_code(),
                message: message.clone().unwrap_or_default(),
            },
            "stdin_ack" => ProcessEvent::StdinAck,
            "stdin_finish" => ProcessEvent::StdinFinish,
            "stdin_error" => ProcessEvent::StdinError {
                code: str_code(),
                message: message.clone().unwrap_or_default(),
            },
            "spawn_error" => ProcessEvent::SpawnError {
                code: str_code(),
                message: message.clone().unwrap_or_default(),
            },
            "exit" => {
                if let Some(p) = pid {
                    entry.pid.store(p, Ordering::Release);
                }
                entry.exited.store(true, Ordering::Release);
                entry.exit_notify.notify_waiters();
                ProcessEvent::Exit {
                    code: int_code(),
                    signal,
                    pid,
                }
            }
            "close" => {
                entry.exited.store(true, Ordering::Release);
                entry.exit_notify.notify_waiters();
                ProcessEvent::Close {
                    code: int_code(),
                    signal,
                }
            }
            _ => return,
        };
        if matches!(event, ProcessEvent::Close { .. }) {
            entry.queue.push(event);
            entry.queue.close();
        } else {
            entry.queue.push(event);
        }
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
        let json = Frame::new()
            .text("op", "kill_leader")
            .number("spawnId", self.spawn_id)
            .text("signal", signal)
            .json();
        self.hub.emit(json, Vec::new());
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
            let queue = EventQueue::new();
            let exited = Arc::new(AtomicBool::new(false));
            let exit_notify = Arc::new(Notify::new());
            let pid_cell = Arc::new(AtomicU32::new(0));
            let entry = Arc::new(BridgedChildEntry {
                queue: Arc::clone(&queue),
                exited: Arc::clone(&exited),
                exit_notify: Arc::clone(&exit_notify),
                pid: Arc::clone(&pid_cell),
            });
            if let Ok(mut map) = hub.spawns.lock() {
                map.insert(spawn_id, entry);
            }
            let env: Vec<ace_json::Value> = request
                .env
                .iter()
                .map(|(key, value)| {
                    ace_json::Value::Array(ace_json::Array::from(vec![
                        ace_json::Value::from(key.as_str()),
                        ace_json::Value::from(value.as_str()),
                    ]))
                })
                .collect();
            let env = ace_json::Value::Array(ace_json::Array::from(env));
            let json = Frame::new()
                .text("op", "spawn")
                .number("reqId", req_id)
                .number("spawnId", spawn_id)
                .text("command", &request.command)
                .set("args", wire::string_array(&request.args))
                .maybe("cwd", request.cwd.as_deref())
                .set("env", env)
                .boolean("detached", request.detached)
                .boolean("hideWindow", request.hide_window)
                .json();

            if let Some(reply_str) = hub.request_with_id(req_id, json, Vec::new()).await {
                let parsed = wire::object(&reply_str).unwrap_or_default();
                if let Some(p) = wire::count(&parsed, "pid") {
                    pid_cell.store(p as u32, Ordering::Release);
                }
                if let Some(err) = wire::string(&parsed, "error") {
                    exited.store(true, Ordering::Release);
                    exit_notify.notify_waiters();
                    queue.push(ProcessEvent::SpawnError {
                        code: wire::string(&parsed, "code"),
                        message: err,
                    });
                    queue.push(ProcessEvent::Close {
                        code: None,
                        signal: None,
                    });
                    queue.close();
                }
            }
            let child = Arc::new(BridgedChild {
                hub,
                spawn_id,
                pid: pid_cell,
                exited,
                exit_notify,
            });
            SpawnedProcess {
                child,
                events: queue,
            }
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
    let mut frame = Frame::new()
        .text("op", "signal_group")
        .number("reqId", req_id)
        .number("pid", pid as u64)
        .text("signal", signal);
    if let Some(spawn_id) = spawn_id {
        frame = frame.number("spawnId", spawn_id);
    }
    let json = frame.json();
    let Some(reply) = hub.request_with_id(req_id, json, Vec::new()).await else {
        return Err("port bridge closed".to_owned());
    };
    let parsed = wire::object(&reply).unwrap_or_default();
    if wire::flag(&parsed, "ok") {
        Ok(())
    } else {
        Err(wire::string(&parsed, "error").unwrap_or_else(|| "signal failed".to_owned()))
    }
}

async fn call_group_alive(hub: &PortHub, pid: u32, spawn_id: Option<u64>) -> bool {
    let req_id = hub.alloc_id();
    let mut frame = Frame::new()
        .text("op", "group_alive")
        .number("reqId", req_id)
        .number("pid", pid as u64);
    if let Some(spawn_id) = spawn_id {
        frame = frame.number("spawnId", spawn_id);
    }
    let json = frame.json();
    let Some(reply) = hub.request_with_id(req_id, json, Vec::new()).await else {
        return false;
    };
    wire::object(&reply).is_some_and(|parsed| wire::flag(&parsed, "alive"))
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
            let json = Frame::new()
                .text("op", "cleanup_stop")
                .number("reqId", req_id)
                .number("spawnId", spawn_id)
                .text("leasesJson", &leases_json)
                .json();
            let reply = hub
                .request_with_id(req_id, json, Vec::new())
                .await
                .ok_or_else(|| "port bridge closed".to_owned())?;
            let parsed = wire::object(&reply).unwrap_or_default();
            if let Some(err) = wire::string(&parsed, "error") {
                return Err(err);
            }
            if wire::string(&parsed, "status").as_deref() == Some("confirmed") {
                Ok(CleanupResult::Confirmed {
                    evidence: wire::string(&parsed, "evidence").unwrap_or_default(),
                })
            } else {
                Ok(CleanupResult::Unconfirmed {
                    reason: wire::string(&parsed, "reason")
                        .unwrap_or_else(|| "Cleanup unconfirmed".to_owned()),
                })
            }
        })
    }
}

/// The lease ports the core asks for on the JS thread: the shell's own
/// `live`/`orphans`, the injected `gitProcesses`/`groupAlive`/`now` probes,
/// the cleanup supervisor's reconciliation and `onLeaseRetired`.
pub(crate) struct JsLeasePorts {
    pub(crate) hub: Arc<PortHub>,
    pub(crate) scheduler: Arc<dyn TimeoutScheduler>,
    pub(crate) evidence: bool,
    pub(crate) wait_ms: u64,
}

impl JsLeasePorts {
    async fn request(&self, json: String) -> Option<ace_json::Map> {
        let req_id = self.hub.alloc_id();
        // The caller builds `op` into the frame; the id is inserted here so every
        // request is addressed the same way.
        let reply = self
            .hub
            .request_with_id(
                req_id,
                json.replace("__REQ__", &req_id.to_string()),
                Vec::new(),
            )
            .await?;
        wire::object(&reply)
    }
}

impl ace_git::core::lease::LeasePorts for JsLeasePorts {
    fn local_lease(&self, record: &LeaseRecord) -> ace_git::core::spawn::BoxFuture<'_, LocalLease> {
        let json = format!(
            "{{\"op\":\"lease_local\",\"reqId\":__REQ__,\"record\":{}}}",
            record.json()
        );
        Box::pin(async move { self.local_lease_reply(json).await })
    }

    fn processes(&self) -> ace_git::core::spawn::BoxFuture<'_, Option<Vec<GitProcess>>> {
        let json = "{\"op\":\"lease_processes\",\"reqId\":__REQ__}".to_owned();
        Box::pin(async move {
            let map = self.request(json).await?;
            match map.get("listing") {
                Some(ace_json::Value::Array(items)) => Some(
                    items
                        .iter()
                        .filter_map(GitProcess::from_json)
                        .collect::<Vec<_>>(),
                ),
                _ => None,
            }
        })
    }

    fn group_alive(&self, pid: u32) -> ace_git::core::spawn::BoxFuture<'_, bool> {
        let json = format!("{{\"op\":\"lease_group_alive\",\"reqId\":__REQ__,\"pid\":{pid}}}");
        Box::pin(async move {
            self.request(json)
                .await
                .is_some_and(|map| matches!(map.get("alive"), Some(ace_json::Value::Bool(true))))
        })
    }

    fn now_ms(&self) -> ace_git::core::spawn::BoxFuture<'_, i64> {
        let json = "{\"op\":\"lease_now\",\"reqId\":__REQ__}".to_owned();
        Box::pin(async move {
            self.request(json)
                .await
                .map_or(0, |map| match map.get("ms") {
                    Some(ace_json::Value::Number(number)) => {
                        number.as_f64().map_or(0, |value| value.round() as i64)
                    }
                    _ => 0,
                })
        })
    }

    fn running_when_gone(
        &self,
        lease: &LeaseRecord,
        listing: &[GitProcess],
    ) -> ace_git::core::spawn::BoxFuture<'_, Option<Vec<u32>>> {
        let entries: Vec<String> = listing.iter().map(json_process).collect();
        let json = format!(
            "{{\"op\":\"lease_running_when_gone\",\"reqId\":__REQ__,\"lease\":{},\"listing\":[{}]}}",
            lease.json(),
            entries.join(",")
        );
        Box::pin(async move {
            let map = self.request(json).await?;
            match map.get("pids") {
                Some(ace_json::Value::Array(items)) => Some(
                    items
                        .iter()
                        .filter_map(|item| match item {
                            ace_json::Value::Number(number) => {
                                number.as_f64().map(|value| value as u32)
                            }
                            _ => None,
                        })
                        .collect(),
                ),
                _ => None,
            }
        })
    }

    fn recover(&self, lease: &LeaseRecord) -> ace_git::core::spawn::BoxFuture<'_, CleanupResult> {
        let json = format!(
            "{{\"op\":\"lease_recover\",\"reqId\":__REQ__,\"lease\":{}}}",
            lease.json()
        );
        Box::pin(async move {
            let Some(map) = self.request(json).await else {
                return CleanupResult::Unconfirmed {
                    reason: "Cleanup supervisor failed".to_owned(),
                };
            };
            if let Some(error) = wire::string(&map, "error") {
                return CleanupResult::Unconfirmed { reason: error };
            }
            if wire::string(&map, "status").as_deref() == Some("confirmed") {
                CleanupResult::Confirmed {
                    evidence: wire::string(&map, "evidence").unwrap_or_default(),
                }
            } else {
                CleanupResult::Unconfirmed {
                    reason: wire::string(&map, "reason")
                        .unwrap_or_else(|| "Cleanup unconfirmed".to_owned()),
                }
            }
        })
    }

    fn retired(&self, event: &ace_git::core::lease::RetiredLease) {
        self.hub.emit(
            format!("{{\"op\":\"lease_retired\",\"event\":{}}}", event.to_json()),
            Vec::new(),
        );
    }

    fn pause(&self, milliseconds: u64) -> ace_git::core::spawn::BoxFuture<'_, ()> {
        let scheduler = Arc::clone(&self.scheduler);
        Box::pin(async move {
            ace_git::core::spawn::sleep_with(scheduler.as_ref(), milliseconds).await;
        })
    }

    fn has_evidence(&self) -> bool {
        self.evidence
    }

    fn wait_ms(&self) -> u64 {
        self.wait_ms
    }
}

impl JsLeasePorts {
    async fn local_lease_reply(&self, json: String) -> LocalLease {
        let Some(map) = self.request(json).await else {
            return LocalLease::default();
        };
        let groups = match map.get("groups") {
            Some(ace_json::Value::Array(items)) => Some(
                items
                    .iter()
                    .filter_map(|item| match item {
                        ace_json::Value::Number(number) => {
                            number.as_f64().map(|value| value as u32)
                        }
                        _ => None,
                    })
                    .collect(),
            ),
            _ => None,
        };
        LocalLease {
            present: wire::flag(&map, "present"),
            live: wire::flag(&map, "live"),
            quarantined: wire::flag(&map, "quarantined"),
            done: wire::flag(&map, "done"),
            groups,
            mine: wire::flag(&map, "mine"),
            record: match map.get("record") {
                Some(ace_json::Value::Object(_)) => {
                    wire::string(&map, "recordJson").and_then(|json| LeaseRecord::parse(&json))
                }
                _ => None,
            },
        }
    }
}

fn json_process(entry: &GitProcess) -> String {
    let mut frame = Frame::new()
        .number("pid", entry.pid as u64)
        .maybe("cwd", entry.cwd.as_deref())
        .maybe("checkout", entry.checkout.as_deref());
    if let Some(started) = entry.started_at {
        frame = frame.integer("startedAt", started);
    }
    if let Some(group) = entry.git_group {
        frame = frame.boolean("gitGroup", group);
    }
    frame.json()
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
    let parsed = wire::object(&reply).unwrap_or_default();
    if wire::flag(&parsed, "ok") {
        return Ok(());
    }
    let message = wire::string(&parsed, "message").unwrap_or_else(|| "Stream error".to_owned());
    if let Some(errno) = wire::string(&parsed, "errno") {
        return Err(GitError::filesystem(errno, message));
    }
    let code = wire::string(&parsed, "code")
        .as_deref()
        .and_then(parse_git_error_code)
        .unwrap_or(GitErrorCode::GitFailed);
    Err(GitError::new(code, message))
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

/// The cache's ports, answered on the JS thread by the caller of `configRead`:
/// its config sources, its computation, its `keep`, and its clock.
pub(crate) struct JsConfigPorts {
    pub(crate) hub: Arc<PortHub>,
}

impl JsConfigPorts {
    async fn request(&self, json: String) -> Option<ace_json::Map> {
        let req_id = self.hub.alloc_id();
        let reply = self
            .hub
            .request_with_id(
                req_id,
                json.replace("__REQ__", &req_id.to_string()),
                Vec::new(),
            )
            .await?;
        wire::object(&reply)
    }
}

fn error_from(map: &ace_json::Map) -> GitError {
    let code = wire::string(map, "code")
        .as_deref()
        .and_then(ace_git::core::error::GitErrorCode::parse)
        .unwrap_or(ace_git::core::error::GitErrorCode::GitFailed);
    let message = wire::string(map, "message").unwrap_or_default();
    let details = match map.get("details") {
        Some(ace_json::Value::Object(details)) => details.clone(),
        _ => ace_json::Map::new(),
    };
    GitError::with_details(code, message, details)
}

impl ace_git::core::config::ConfigPorts for JsConfigPorts {
    fn sources(
        &self,
        call: u64,
        cwd: &str,
        env_json: &str,
    ) -> ace_git::core::spawn::BoxFuture<'_, Option<Vec<String>>> {
        let json = format!(
            "{{\"op\":\"config_sources\",\"reqId\":__REQ__,\"callId\":{call},\"cwd\":{},\"envJson\":{}}}",
            ace_json::to_string(&ace_json::Value::from(cwd)),
            ace_json::to_string(&ace_json::Value::from(env_json))
        );
        Box::pin(async move {
            let map = self.request(json).await?;
            match map.get("paths") {
                Some(ace_json::Value::Array(items)) => items
                    .iter()
                    .map(|item| match item {
                        ace_json::Value::String(path) => Some(path.to_string_lossy().into_owned()),
                        _ => None,
                    })
                    .collect(),
                _ => None,
            }
        })
    }

    fn compute(
        &self,
        call: u64,
    ) -> ace_git::core::spawn::BoxFuture<'_, Result<ace_json::Value, GitError>> {
        let json = format!("{{\"op\":\"config_compute\",\"reqId\":__REQ__,\"callId\":{call}}}");
        Box::pin(async move {
            let Some(map) = self.request(json).await else {
                return Err(GitError::new(
                    ace_git::core::error::GitErrorCode::GitClosed,
                    "The config caller stopped answering",
                ));
            };
            if let Some(error) = map.get("error") {
                let ace_json::Value::Object(error) = error else {
                    return Err(GitError::new(
                        ace_git::core::error::GitErrorCode::GitFailed,
                        "The config caller failed",
                    ));
                };
                return Err(error_from(error));
            }
            Ok(map.get("value").cloned().unwrap_or(ace_json::Value::Null))
        })
    }

    fn keep(
        &self,
        call: u64,
        value: &ace_json::Value,
    ) -> ace_git::core::spawn::BoxFuture<'_, bool> {
        let json = format!(
            "{{\"op\":\"config_keep\",\"reqId\":__REQ__,\"callId\":{call},\"value\":{}}}",
            ace_json::to_string(value)
        );
        Box::pin(async move {
            self.request(json)
                .await
                .is_some_and(|map| wire::flag(&map, "keep"))
        })
    }

    fn now_ms(&self, call: u64) -> ace_git::core::spawn::BoxFuture<'_, i64> {
        let json = format!("{{\"op\":\"config_now\",\"reqId\":__REQ__,\"callId\":{call}}}");
        Box::pin(async move {
            self.request(json)
                .await
                .map_or(0, |map| match map.get("ms") {
                    Some(ace_json::Value::Number(number)) => {
                        number.as_f64().map_or(0, |value| value.round() as i64)
                    }
                    _ => 0,
                })
        })
    }
}
