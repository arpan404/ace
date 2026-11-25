// SPDX-License-Identifier: Apache-2.0
//! N-API binding for `ace_devices::inventory::InventoryCoordinator` plus live
//! `host:track-devices-l` and `notify` watchers on the shared tokio runtime (D2).

use super::{bind_error, guarded, parse_json};
use crate::supervisor::runtime;
use ace_devices::error::DeviceFailure;
use ace_devices::inventory::adb_track::{
    AdbTrackConfig, AdbTrackEvent, SupervisedAdbStarter, TokioTrackClock, TrackClock,
    adb_server_port, run_adb_track_once,
};
use ace_devices::inventory::watch::{
    DirWatchEvent, DirWatchHandle, avd_folder, core_simulator_folder, start_dir_watch,
};
use ace_devices::inventory::{
    CoordinatorAction, CoordinatorConfig, DEBOUNCE_MS, DEFAULT_FALLBACK_INTERVAL_MS, Inventory,
    InventoryCoordinator, InventorySource, LIVENESS_RECONCILE_MS,
};
use ace_json::{ObjectWriter, Value};
use napi::Status;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// Weak threadsafe callback so an idle inventory watch never keeps the process alive.
pub type ActionsFn = ThreadsafeFunction<String, (), String, Status, false, true>;

struct WatchState {
    coordinator: InventoryCoordinator,
    on_actions: Arc<ActionsFn>,
    home: PathBuf,
    env: Vec<(String, String)>,
    adb_path: Option<String>,
    adb_port: u16,
    adb_connect_enabled: bool,
    generations: [u64; 3],
    adb_cancel: Option<CancellationToken>,
    avd_watch: Option<(DirWatchHandle, CancellationToken)>,
    ios_watch: Option<(DirWatchHandle, CancellationToken)>,
    closed: bool,
}

impl WatchState {
    fn stop_source(&mut self, source: InventorySource) {
        let idx = source.index();
        self.generations[idx] = self.generations[idx].wrapping_add(1);
        match source {
            InventorySource::Adb => {
                if let Some(cancel) = self.adb_cancel.take() {
                    cancel.cancel();
                }
            }
            InventorySource::Avds => {
                if let Some((_handle, cancel)) = self.avd_watch.take() {
                    cancel.cancel();
                }
            }
            InventorySource::Ios => {
                if let Some((_handle, cancel)) = self.ios_watch.take() {
                    cancel.cancel();
                }
            }
        }
    }

    fn stop_all_watchers(&mut self) {
        for source in InventorySource::ALL {
            self.stop_source(source);
        }
    }

    fn apply_runtime_env(&mut self, obj: &ace_json::Map) {
        if let Some(home) = obj.get("home").and_then(Value::as_str) {
            self.home = PathBuf::from(home);
        }
        if let Some(env_arr) = obj.get("env").and_then(Value::as_array) {
            let mut pairs = Vec::with_capacity(env_arr.len());
            for item in env_arr {
                if let Some(pair) = item.as_array()
                    && pair.len() == 2
                    && let (Some(k), Some(v)) = (pair[0].as_str(), pair[1].as_str())
                {
                    pairs.push((k.to_owned(), v.to_owned()));
                }
            }
            self.env = pairs;
        }
        if let Some(val) = obj.get("adbPath") {
            self.adb_path = val.as_str().map(ToOwned::to_owned);
        }
        let explicit_port = self
            .env
            .iter()
            .any(|(k, v)| k == "ANDROID_ADB_SERVER_PORT" && !v.trim().is_empty());
        self.adb_port = adb_server_port(&self.env);
        self.adb_connect_enabled = self.adb_path.is_some() || explicit_port;
    }
}

/// Native D2 inventory watch: owns `InventoryCoordinator` plus live adb-track and `notify` tasks.
#[napi]
pub struct NativeInventoryWatch {
    state: Arc<Mutex<WatchState>>,
}

impl Drop for NativeInventoryWatch {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.state.lock() {
            guard.closed = true;
            guard.stop_all_watchers();
        }
    }
}

#[napi]
impl NativeInventoryWatch {
    #[napi(constructor)]
    pub fn new(config_json: String, on_actions: ActionsFn) -> napi::Result<Self> {
        guarded("NativeInventoryWatch::new", || {
            let val = parse_json(&config_json)?;
            let obj = val
                .as_object()
                .ok_or_else(|| napi::Error::from_reason("config must be an object"))?;
            let enable_ios = obj
                .get("enableIos")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let fallback_interval_ms = obj
                .get("fallbackIntervalMs")
                .and_then(Value::as_f64)
                .map(|n| n.max(1.0) as u64)
                .unwrap_or(DEFAULT_FALLBACK_INTERVAL_MS);
            let debounce_ms = obj
                .get("debounceMs")
                .and_then(Value::as_f64)
                .map(|n| n.max(0.0) as u64)
                .unwrap_or(DEBOUNCE_MS);
            let liveness_interval_ms = obj
                .get("livenessIntervalMs")
                .and_then(Value::as_f64)
                .map(|n| n.max(1.0) as u64)
                .unwrap_or(LIVENESS_RECONCILE_MS);

            let mut watch_state = WatchState {
                coordinator: InventoryCoordinator::new(CoordinatorConfig {
                    enable_ios,
                    fallback_interval_ms,
                    debounce_ms,
                    liveness_interval_ms,
                }),
                on_actions: Arc::new(on_actions),
                home: PathBuf::new(),
                env: Vec::new(),
                adb_path: None,
                adb_port: adb_server_port(&[]),
                adb_connect_enabled: false,
                generations: [0; 3],
                adb_cancel: None,
                avd_watch: None,
                ios_watch: None,
                closed: false,
            };
            watch_state.apply_runtime_env(obj);
            Ok(Self {
                state: Arc::new(Mutex::new(watch_state)),
            })
        })
    }

    /// Returns the last published `Inventory` JSON, if any.
    #[napi(catch_unwind)]
    pub fn current(&self) -> napi::Result<Option<String>> {
        guarded("NativeInventoryWatch::current", || {
            let guard = lock_state(&self.state)?;
            Ok(guard.coordinator.current().map(Inventory::to_json_string))
        })
    }

    /// Records an external inventory read; returns `Inventory` JSON only if it changed.
    #[napi(catch_unwind)]
    pub fn update(&self, inventory_json: String) -> napi::Result<Option<String>> {
        guarded("NativeInventoryWatch::update", || {
            let val = parse_json(&inventory_json)?;
            let inventory = Inventory::from_value(&val).map_err(bind_error)?;
            let mut guard = lock_state(&self.state)?;
            Ok(match guard.coordinator.update(inventory) {
                Some(CoordinatorAction::Publish(inv)) => Some(inv.to_json_string()),
                _ => None,
            })
        })
    }

    /// Starts or stops watching; returns a JSON array of JS actions to run immediately.
    #[napi(catch_unwind)]
    pub fn set_watching(&self, active: bool, runtime_json: Option<String>) -> napi::Result<String> {
        guarded("NativeInventoryWatch::set_watching", || {
            let runtime_obj = match runtime_json {
                Some(text) => {
                    let val = parse_json(&text)?;
                    Some(
                        val.as_object()
                            .cloned()
                            .ok_or_else(|| napi::Error::from_reason("runtime must be an object"))?,
                    )
                }
                None => None,
            };
            let rt = runtime()?;
            let mut guard = lock_state(&self.state)?;
            if guard.closed {
                return Ok("[]".into());
            }
            if let Some(obj) = &runtime_obj {
                guard.apply_runtime_env(obj);
            }
            let actions = guard.coordinator.set_active(active);
            let js_actions = apply_actions(&self.state, &mut guard, rt, actions);
            Ok(encode_js_actions(&js_actions))
        })
    }

    /// Notifies the coordinator that an armed timer fired; returns JS actions JSON.
    #[napi(catch_unwind)]
    pub fn timer_fired(&self, timer_id: f64) -> napi::Result<String> {
        guarded("NativeInventoryWatch::timer_fired", || {
            let rt = runtime()?;
            let mut guard = lock_state(&self.state)?;
            if guard.closed {
                return Ok("[]".into());
            }
            let actions = guard.coordinator.on_timer_fired(timer_id.max(0.0) as u64);
            let js_actions = apply_actions(&self.state, &mut guard, rt, actions);
            Ok(encode_js_actions(&js_actions))
        })
    }

    /// Reports a completed SDK read; returns JS actions JSON.
    #[napi(catch_unwind)]
    pub fn read_succeeded(&self, read_id: f64, inventory_json: String) -> napi::Result<String> {
        guarded("NativeInventoryWatch::read_succeeded", || {
            let val = parse_json(&inventory_json)?;
            let inventory = Inventory::from_value(&val).map_err(bind_error)?;
            let rt = runtime()?;
            let mut guard = lock_state(&self.state)?;
            let actions = guard
                .coordinator
                .on_read_succeeded(read_id.max(0.0) as u64, inventory);
            let js_actions = apply_actions(&self.state, &mut guard, rt, actions);
            Ok(encode_js_actions(&js_actions))
        })
    }

    /// Reports a failed SDK read; returns JS actions JSON.
    #[napi(catch_unwind)]
    pub fn read_failed(
        &self,
        read_id: f64,
        failure_json: String,
        raw_message: String,
    ) -> napi::Result<String> {
        guarded("NativeInventoryWatch::read_failed", || {
            let val = parse_json(&failure_json)?;
            let failure = DeviceFailure::from_value(&val).map_err(bind_error)?;
            let rt = runtime()?;
            let mut guard = lock_state(&self.state)?;
            let actions =
                guard
                    .coordinator
                    .on_read_failed(read_id.max(0.0) as u64, failure, &raw_message);
            let js_actions = apply_actions(&self.state, &mut guard, rt, actions);
            Ok(encode_js_actions(&js_actions))
        })
    }

    /// Cancels an in-flight read dropped by JS (e.g. after view release); returns JS actions JSON.
    #[napi(catch_unwind)]
    pub fn read_cancelled(&self, read_id: f64) -> napi::Result<String> {
        guarded("NativeInventoryWatch::read_cancelled", || {
            let rt = runtime()?;
            let mut guard = lock_state(&self.state)?;
            let actions = guard.coordinator.on_read_cancelled(read_id.max(0.0) as u64);
            let js_actions = apply_actions(&self.state, &mut guard, rt, actions);
            Ok(encode_js_actions(&js_actions))
        })
    }

    /// Stops all watchers and cancels all timers permanently.
    #[napi(catch_unwind)]
    pub fn close(&self) -> napi::Result<String> {
        guarded("NativeInventoryWatch::close", || {
            let rt = runtime()?;
            let mut guard = lock_state(&self.state)?;
            guard.closed = true;
            let actions = guard.coordinator.set_active(false);
            let js_actions = apply_actions(&self.state, &mut guard, rt, actions);
            guard.stop_all_watchers();
            Ok(encode_js_actions(&js_actions))
        })
    }
}

fn lock_state(
    state: &Arc<Mutex<WatchState>>,
) -> napi::Result<std::sync::MutexGuard<'_, WatchState>> {
    state
        .lock()
        .map_err(|_| napi::Error::from_reason("inventory watch lock poisoned"))
}

/// Applies watcher actions inside Rust and collects JS-facing actions.
fn apply_actions(
    state_arc: &Arc<Mutex<WatchState>>,
    guard: &mut WatchState,
    rt: &'static tokio::runtime::Runtime,
    initial: Vec<CoordinatorAction>,
) -> Vec<CoordinatorAction> {
    let mut queue: VecDeque<CoordinatorAction> = initial.into();
    let mut js_actions = Vec::new();

    while let Some(action) = queue.pop_front() {
        match action {
            CoordinatorAction::StopWatcher(source) => {
                guard.stop_source(source);
            }
            CoordinatorAction::StartWatcher(source) => {
                if guard.closed || !guard.coordinator.is_active() {
                    continue;
                }
                guard.stop_source(source);
                let generation = guard.generations[source.index()];
                match source {
                    InventorySource::Adb => start_adb_task(state_arc, guard, rt, generation),
                    InventorySource::Avds | InventorySource::Ios => {
                        let follow_up = start_fs_watch(state_arc, guard, rt, source, generation);
                        queue.extend(follow_up);
                    }
                }
            }
            other => js_actions.push(other),
        }
    }
    js_actions
}

fn start_adb_task(
    state_arc: &Arc<Mutex<WatchState>>,
    guard: &mut WatchState,
    rt: &'static tokio::runtime::Runtime,
    generation: u64,
) {
    if !guard.adb_connect_enabled {
        // No adb binary and no explicit ANDROID_ADB_SERVER_PORT: stay Unhealthy on 4 s fallback
        // without probing a host adb server on 127.0.0.1:5037.
        return;
    }
    let cancel = CancellationToken::new();
    guard.adb_cancel = Some(cancel.clone());
    let config =
        AdbTrackConfig::loopback(guard.adb_port, guard.adb_path.clone(), guard.env.clone());
    let (tx, mut rx) = mpsc::unbounded_channel();
    let clock: Arc<dyn TrackClock> = Arc::new(TokioTrackClock);
    let starter = Arc::new(SupervisedAdbStarter::new(Arc::clone(&clock)));
    rt.spawn(run_adb_track_once(
        config,
        starter,
        clock,
        tx,
        cancel.clone(),
    ));

    let state_for_task = Arc::clone(state_arc);
    rt.spawn(async move {
        let mut saw_disconnect = false;
        loop {
            tokio::select! {
                biased;
                () = cancel.cancelled() => break,
                event = rx.recv() => {
                    match event {
                        Some(AdbTrackEvent::Connected) => {
                            dispatch_async(&state_for_task, rt, InventorySource::Adb, generation, |c| {
                                c.on_watcher_ready(InventorySource::Adb, true)
                            });
                        }
                        Some(AdbTrackEvent::Update(_)) => {
                            dispatch_async(&state_for_task, rt, InventorySource::Adb, generation, |c| {
                                c.on_source_trigger(InventorySource::Adb)
                            });
                        }
                        Some(AdbTrackEvent::Disconnected(_)) | None => {
                            saw_disconnect = true;
                            break;
                        }
                    }
                }
            }
        }
        if saw_disconnect && !cancel.is_cancelled() {
            dispatch_async(&state_for_task, rt, InventorySource::Adb, generation, |c| {
                c.on_watcher_lost(InventorySource::Adb)
            });
        }
    });
}

fn start_fs_watch(
    state_arc: &Arc<Mutex<WatchState>>,
    guard: &mut WatchState,
    rt: &'static tokio::runtime::Runtime,
    source: InventorySource,
    generation: u64,
) -> Vec<CoordinatorAction> {
    let target = match source {
        InventorySource::Avds => avd_folder(&guard.env, &guard.home),
        InventorySource::Ios => core_simulator_folder(&guard.home),
        InventorySource::Adb => return Vec::new(),
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    match start_dir_watch(&target, tx) {
        Ok(handle) => {
            let on_target = handle.is_on_target();
            let cancel = CancellationToken::new();
            match source {
                InventorySource::Avds => guard.avd_watch = Some((handle, cancel.clone())),
                InventorySource::Ios => guard.ios_watch = Some((handle, cancel.clone())),
                InventorySource::Adb => {}
            }
            let state_for_task = Arc::clone(state_arc);
            rt.spawn(async move {
                loop {
                    tokio::select! {
                        biased;
                        () = cancel.cancelled() => break,
                        event = rx.recv() => {
                            match event {
                                Some(DirWatchEvent::Changed) => {
                                    dispatch_async(&state_for_task, rt, source, generation, |c| {
                                        c.on_source_trigger(source)
                                    });
                                }
                                Some(DirWatchEvent::RestartNeeded(_)) | None => {
                                    dispatch_async(&state_for_task, rt, source, generation, |c| {
                                        c.on_watcher_lost(source)
                                    });
                                    break;
                                }
                            }
                        }
                    }
                }
            });
            guard.coordinator.on_watcher_ready(source, on_target)
        }
        Err(_) => guard.coordinator.on_watcher_lost(source),
    }
}

fn dispatch_async(
    state_arc: &Arc<Mutex<WatchState>>,
    rt: &'static tokio::runtime::Runtime,
    source: InventorySource,
    generation: u64,
    step: impl FnOnce(&mut InventoryCoordinator) -> Vec<CoordinatorAction>,
) {
    let payload = {
        let Ok(mut guard) = state_arc.lock() else {
            return;
        };
        if guard.closed || guard.generations[source.index()] != generation {
            return;
        }
        let actions = step(&mut guard.coordinator);
        let js_actions = apply_actions(state_arc, &mut guard, rt, actions);
        if js_actions.is_empty() {
            return;
        }
        (
            Arc::clone(&guard.on_actions),
            encode_js_actions(&js_actions),
        )
    };
    // Mutex is dropped before invoking JS callback.
    let _ = payload
        .0
        .call(payload.1, ThreadsafeFunctionCallMode::NonBlocking);
}

fn encode_js_actions(actions: &[CoordinatorAction]) -> String {
    let mut out = String::new();
    out.push('[');
    for (idx, action) in actions.iter().enumerate() {
        if idx > 0 {
            out.push(',');
        }
        match action {
            CoordinatorAction::ArmTimer { id, delay_ms, .. } => {
                let mut obj = ObjectWriter::new(&mut out);
                obj.str("op", "arm_timer");
                obj.number("id", *id as f64);
                obj.number("delayMs", *delay_ms as f64);
                obj.finish();
            }
            CoordinatorAction::CancelTimer { id } => {
                let mut obj = ObjectWriter::new(&mut out);
                obj.str("op", "cancel_timer");
                obj.number("id", *id as f64);
                obj.finish();
            }
            CoordinatorAction::StartRead {
                read_id,
                scope,
                liveness,
            } => {
                let mut obj = ObjectWriter::new(&mut out);
                obj.str("op", "start_read");
                obj.number("readId", *read_id as f64);
                obj.str("scope", scope.as_str());
                obj.bool("liveness", *liveness);
                obj.finish();
            }
            CoordinatorAction::Publish(inventory) => {
                out.push_str("{\"op\":\"publish\",\"inventory\":");
                out.push_str(&inventory.to_json_string());
                out.push('}');
            }
            CoordinatorAction::LogWarn { message, detail } => {
                let mut obj = ObjectWriter::new(&mut out);
                obj.str("op", "log_warn");
                obj.str("message", message);
                obj.str("detail", detail);
                obj.finish();
            }
            CoordinatorAction::StartWatcher(_) | CoordinatorAction::StopWatcher(_) => {}
        }
    }
    out.push(']');
    out
}
