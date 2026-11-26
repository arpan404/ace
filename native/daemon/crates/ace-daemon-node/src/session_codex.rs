// SPDX-License-Identifier: Apache-2.0
//! The Codex session binding (E3-codex.5): the Rust session shell behind the
//! facade's calls. Values cross as JSON text; the session's ordered events go
//! out through the shared `SessionPort`, one batch at a time (E3.0c).
//!
//! One native pool is made per TypeScript `CodexHostPool` (the facade's
//! WeakMap), so the tests that share one pool share one native pool. The child
//! is the facade's: it spawns it with `spawn_target()` and stops it when the
//! pool's stop port names that host.

// napi-derive registers exports only outside test builds, so in the lib test
// target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

use std::sync::{Arc, Mutex};

use ace_adapter_codex::session::host::{Host, HostConfig, Retirement};
use ace_adapter_codex::session::pool::{CODEX_ELISION, initialize};
use ace_adapter_codex::session::shell::{HostConsumer, SessionChannel, SharedHost, ShellConfig};
use ace_json::Value;
use ace_supervisor::divert::DivertTarget;
use ace_supervisor::divert::OutputConsumer;
use indexmap::IndexMap;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;

use crate::session_bridge::SessionPort;
use crate::supervisor::child::NativeOutputTarget;

/// The facade's callback: one encoded batch of `[[kind, ...fields], ...]`.
type Events = ThreadsafeFunction<String, ()>;
/// The pool's stop callback: one JSON `{host, key, reason}` per child stop.
type Stop = ThreadsafeFunction<String, ()>;
/// The pool's timer callback: one JSON `{host, key, ms}`, `ms: null` cancels.
type HostTimer = ThreadsafeFunction<String, ()>;

#[derive(serde::Deserialize)]
struct ShellConfigJson {
    scope: String,
    started: f64,
    cwd: String,
    #[serde(default)]
    bearer: Option<String>,
    #[serde(default)]
    workspace: String,
    #[serde(default)]
    home: Option<String>,
    #[serde(default)]
    hostname: Option<String>,
    #[serde(default)]
    env: Vec<(String, String)>,
}

/// One live host and the channel that spawned it, if any.
struct HostEntry {
    shared: Arc<SharedHost>,
    consumer: Option<Arc<HostConsumer>>,
}

struct PoolState {
    idle_ms: f64,
    next_host: u64,
    next_tenant: u64,
    hosts: IndexMap<String, Arc<HostEntry>>,
}

/// The native twin of one TypeScript `CodexHostPool`.
#[napi]
pub struct CodexPoolNative {
    state: Arc<Mutex<PoolState>>,
    stop: Arc<Stop>,
    timer: Arc<HostTimer>,
}

#[napi]
impl CodexPoolNative {
    #[napi(constructor, catch_unwind)]
    pub fn new(idle_ms: Option<f64>, stop: Stop, timer: HostTimer) -> napi::Result<Self> {
        let idle_ms = idle_ms.unwrap_or(600_000.0);
        if !idle_ms.is_finite() || idle_ms.fract() != 0.0 || idle_ms < 0.0 {
            return Err(napi::Error::from_reason("Invalid Codex host idle time"));
        }
        Ok(Self {
            state: Arc::new(Mutex::new(PoolState {
                idle_ms,
                next_host: 1,
                next_tenant: 1,
                hosts: IndexMap::new(),
            })),
            stop: Arc::new(stop),
            timer: Arc::new(timer),
        })
    }

    /// Attach one session to a host, reusing a live one for this key when the
    /// host is shared. A returned channel that `needs_spawn` opens the process.
    #[napi(catch_unwind)]
    pub fn open(
        &self,
        key: String,
        dedicated: bool,
        config_json: String,
        events: Events,
    ) -> napi::Result<CodexChannelNative> {
        let config: ShellConfigJson = serde_json::from_str(&config_json).map_err(input_error)?;
        let mut state = lock(&self.state);
        let live = state
            .hosts
            .get(&key)
            .filter(|entry| entry.shared.host.available() && !dedicated)
            .cloned();
        let (entry, fresh) = match live {
            Some(entry) => (entry, false),
            None => {
                let host = Host::new(if dedicated {
                    HostConfig::dedicated(initialize())
                } else {
                    HostConfig::shared(initialize(), state.idle_ms)
                });
                let id = state.next_host;
                state.next_host += 1;
                let shared = Arc::new(SharedHost::new(id, key.clone(), host));
                let timers = Arc::clone(&self.timer);
                shared.set_host_timer(Arc::new(move |json: String| {
                    let _ = timers.call_with_return_value(
                        Ok(json),
                        ThreadsafeFunctionCallMode::NonBlocking,
                        |_result, _env| Ok(()),
                    );
                }));
                let entry = Arc::new(HostEntry {
                    shared,
                    consumer: None,
                });
                state.hosts.insert(key.clone(), Arc::clone(&entry));
                (entry, true)
            }
        };
        let tenant = state.next_tenant;
        state.next_tenant += 1;
        let stop = Arc::clone(&self.stop);
        let stop_closure = Arc::new(move |json: String| {
            let _ = stop.call_with_return_value(
                Ok(json),
                ThreadsafeFunctionCallMode::NonBlocking,
                |_result, _env| Ok(()),
            );
        });
        let channel = SessionChannel::new(
            Arc::clone(&entry.shared),
            tenant,
            ShellConfig {
                scope: config.scope,
                started: config.started,
                cwd: config.cwd.clone(),
                bearer: config.bearer,
                workspace: config.workspace,
                home: config.home,
                hostname: config.hostname,
                env: config.env,
            },
            stop_closure,
        );
        let port = SessionPort::new(events, channel.queue(), channel.gate())?;
        let intake = Arc::clone(&channel);
        port.set_resume(Arc::new(move || intake.queue_consumed()));
        if let Err(error) = entry.shared.host.attach(tenant, channel.clone()) {
            return Err(napi::Error::from_reason(error.to_string()));
        }
        let consumer = if fresh && entry.consumer.is_none() {
            Some(Arc::new(
                HostConsumer::new(
                    Arc::clone(&entry.shared.host),
                    entry.shared.active_write(),
                    channel.line_limit(),
                    CODEX_ELISION,
                )
                .map_err(|error| napi::Error::from_reason(error.to_string()))?,
            ))
        } else {
            None
        };
        let limit = channel.line_limit();
        Ok(CodexChannelNative {
            channel,
            port,
            consumer,
            ports: Arc::clone(&entry.shared.ports),
            limit,
        })
    }

    /// The child's stop could not be confirmed for this host.
    #[napi(catch_unwind)]
    pub fn stop_failed(&self, key: String, message: String) {
        if let Some(entry) = lock(&self.state).hosts.get(&key).cloned()
            && let Some(channel) = entry.shared.first_channel()
        {
            channel.stop_failed(&message);
        }
    }

    /// An armed host timer fired in the facade's clock.
    #[napi(catch_unwind)]
    pub fn host_timer(&self, host_id: u32, key: String) {
        let hosts: Vec<Arc<HostEntry>> = lock(&self.state).hosts.values().cloned().collect();
        if let Some(entry) = hosts
            .into_iter()
            .find(|entry| entry.shared.id == u64::from(host_id))
        {
            entry.shared.host.timer(&key);
        }
    }

    /// The child stop landed; its exit confirms the retire.
    #[napi(catch_unwind)]
    pub fn stop_confirmed(&self, key: String) {
        if let Some(entry) = lock(&self.state).hosts.get(&key).cloned()
            && let Some(channel) = entry.shared.first_channel()
        {
            channel.stop_confirmed();
        }
    }

    /// The TypeScript pool's close: retire every live app-server.
    #[napi(catch_unwind)]
    pub fn close(&self) {
        let hosts: Vec<Arc<HostEntry>> = lock(&self.state).hosts.values().cloned().collect();
        for entry in hosts {
            entry.shared.host.retire(Retirement::Shutdown);
        }
    }

    /// A host retired: the pool no longer names it. A delayed callback never
    /// evicts a replacement already under the key.
    #[napi(catch_unwind)]
    pub fn forget(&self, key: String, host_id: u32) {
        let mut state = lock(&self.state);
        let current = state
            .hosts
            .get(&key)
            .is_some_and(|entry| entry.shared.id == u64::from(host_id));
        if current {
            state.hosts.shift_remove(&key);
        }
    }
}

/// One session's channel handle.
#[napi]
pub struct CodexChannelNative {
    channel: Arc<SessionChannel>,
    port: SessionPort,
    consumer: Option<Arc<HostConsumer>>,
    ports: Arc<std::sync::OnceLock<ace_supervisor::divert::ChildPorts>>,
    limit: Arc<std::sync::atomic::AtomicUsize>,
}

#[napi]
impl CodexChannelNative {
    /// Whether this channel opens a new host (the facade spawns the child).
    #[napi(catch_unwind)]
    pub fn needs_spawn(&self) -> bool {
        self.consumer.is_some()
    }

    /// The sink the facade spawns the child with.
    #[napi(catch_unwind)]
    pub fn spawn_target(&self) -> napi::Result<NativeOutputTarget> {
        let Some(consumer) = &self.consumer else {
            return Err(napi::Error::from_reason("the host already runs"));
        };
        let consumer: Arc<dyn OutputConsumer> = Arc::clone(consumer) as Arc<dyn OutputConsumer>;
        Ok(NativeOutputTarget::with_limit(
            DivertTarget {
                consumer,
                ports: Arc::clone(&self.ports),
            },
            Arc::clone(&self.limit),
        ))
    }

    /// The child exists: the host may publish, and the pumps answer its gate.
    #[napi(catch_unwind)]
    pub fn spawned(&self, pid: Option<u32>) {
        self.channel.spawned(pid.unwrap_or(0));
    }

    /// The open's promise id; `Opened` settles it.
    #[napi(catch_unwind)]
    pub fn ready(&self) -> u32 {
        self.channel.ready() as u32
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn attached(
        &self,
        root: String,
        model: String,
        selection_json: String,
        permission_mode: Option<String>,
    ) {
        self.channel
            .attached(&root, &model, &selection_json, permission_mode.as_deref());
    }

    #[napi(catch_unwind)]
    pub fn permission_mode_port(&self, present: bool) {
        self.channel.permission_mode_port(present);
    }

    #[napi(catch_unwind)]
    pub fn note(&self, json: String) {
        self.channel.note(&json);
    }

    /// One request through the host; the returned id is its promise.
    #[napi(catch_unwind)]
    pub fn request(
        &self,
        method: String,
        params_json: String,
        timeout_ms: Option<f64>,
    ) -> napi::Result<u32> {
        let params = object(&params_json, "Codex request parameters")?;
        let operation = self.channel.allocate_operation();
        self.channel
            .request_operation(operation, &method, Some(params), timeout_ms);
        Ok(operation as u32)
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn send(
        &self,
        operation: u32,
        parts_json: String,
        delivery: String,
        command_id: Option<String>,
        origin: Option<String>,
        fence_json: Option<String>,
        user_message_id: String,
    ) {
        self.channel.send(
            u64::from(operation),
            &parts_json,
            &delivery,
            command_id.as_deref(),
            origin.as_deref(),
            fence_json.as_deref(),
            &user_message_id,
        );
    }

    #[napi(catch_unwind)]
    pub fn interrupt(&self, operation: u32, agent: Option<String>, cascade: bool) {
        self.channel
            .interrupt(u64::from(operation), agent.as_deref(), cascade);
    }

    #[napi(catch_unwind)]
    pub fn stop_task(&self, operation: u32, task: String) {
        self.channel.stop_task(u64::from(operation), &task);
    }

    #[napi(catch_unwind)]
    #[allow(clippy::too_many_arguments)]
    pub fn resolve(
        &self,
        operation: u32,
        key: String,
        resolution_json: String,
        user_message_id: String,
        interaction_id: Option<String>,
        model: String,
    ) {
        self.channel.resolve(
            u64::from(operation),
            &key,
            &resolution_json,
            &user_message_id,
            interaction_id.as_deref(),
            &model,
        );
    }

    #[napi(catch_unwind)]
    pub fn configure(
        &self,
        operation: u32,
        selection_json: String,
        model: Option<String>,
        reopen: bool,
    ) {
        self.channel.configure(
            u64::from(operation),
            &selection_json,
            model.as_deref(),
            reopen,
        );
    }

    #[napi(catch_unwind)]
    pub fn close(&self, operation: u32, reason: String) {
        self.channel.close(u64::from(operation), &reason);
    }

    #[napi(catch_unwind)]
    pub fn fail_open(&self, operation: u32) {
        self.channel.fail_open(u64::from(operation));
    }

    #[napi(catch_unwind)]
    pub fn abort(&self, reason: String) {
        self.channel.abort(&reason);
    }

    #[napi(catch_unwind)]
    pub fn timer(&self, key: String, now: f64) {
        self.channel.timer(&key, now);
    }

    #[napi(catch_unwind)]
    pub fn tool_facts(&self, operation: u32, model: Option<String>) {
        self.channel
            .tool_facts(u64::from(operation), model.as_deref());
    }

    #[napi(catch_unwind)]
    pub fn read_root(&self, operation: u32) {
        self.channel.read_root(u64::from(operation));
    }

    #[napi(catch_unwind)]
    pub fn rate_limits(&self) {
        self.channel.rate_limits();
    }

    #[napi(catch_unwind)]
    pub fn catalog_start(&self) {
        self.channel.catalog_start();
    }

    #[napi(catch_unwind)]
    pub fn launch_mode(&self, operation: u32, mode_json: String) {
        self.channel.launch_mode(u64::from(operation), &mode_json);
    }

    #[napi(catch_unwind)]
    pub fn launch_failed(&self, operation: u32, message: String) {
        self.channel.launch_failed(u64::from(operation), &message);
    }

    #[napi(catch_unwind)]
    pub fn mcp_status(&self, operation: u32) {
        self.channel.mcp_status(u64::from(operation));
    }

    #[napi(catch_unwind)]
    pub fn mcp_add(&self, operation: u32, name: String, input_json: String) {
        self.channel
            .mcp_add(u64::from(operation), &name, &input_json);
    }

    #[napi(catch_unwind)]
    pub fn mcp_replace(&self, operation: u32) {
        self.channel.mcp_replace(u64::from(operation));
    }

    #[napi(catch_unwind)]
    pub fn mcp_reconnect(&self, operation: u32) {
        self.channel.mcp_reconnect(u64::from(operation));
    }

    #[napi(catch_unwind)]
    pub fn mcp_toggle(&self, operation: u32, name: String, on: bool) {
        self.channel.mcp_toggle(u64::from(operation), &name, on);
    }

    #[napi(catch_unwind)]
    pub fn goal(&self, operation: u32, change_json: String) {
        self.channel.goal(u64::from(operation), &change_json);
    }

    #[napi(catch_unwind)]
    pub fn clear_goal(&self, operation: u32) {
        self.channel.clear_goal(u64::from(operation));
    }

    #[napi(catch_unwind)]
    pub fn set_paused(&self, paused: bool) {
        self.channel.set_paused(paused);
    }

    #[napi(catch_unwind)]
    pub fn fail(&self) {
        self.channel.fail_intake();
    }

    #[napi(catch_unwind)]
    pub fn drain(&self) {
        self.port.drain();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn object(text: &str, what: &str) -> napi::Result<Value> {
    match ace_json::parse(text) {
        Ok(value @ Value::Object(_)) => Ok(value),
        _ => Err(napi::Error::from_reason(format!(
            "{what} is not a JSON object"
        ))),
    }
}

fn input_error(error: serde_json::Error) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}
