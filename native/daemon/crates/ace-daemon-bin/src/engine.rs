// SPDX-License-Identifier: Apache-2.0
//! Hosts `ace-engine` on one dedicated thread inside `ace-daemon-bin` (ADR 0223 §4, slice 3).
//!
//! `ace_engine::Engine` is single-threaded (`Rc<Core>`). This shell owns one OS thread that drives
//! the executor's `pump`, schedules its timers without spawning extra tasks, wraps `ace-store`'s
//! `TransactionStack` with the engine's `AfterCommit` sink, and connects `MaintenanceGate` to
//! `Ports::admits()`. Provider/session/write ports remain explicitly unbound (`PortError::Unbound`)
//! until provider sessions are composed in a later slice.

mod schema;

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use ace_engine::actor::deps::ActorDeps;
use ace_engine::executor::{AfterCommit, Budget, Notified, Notifier, Pump};
use ace_engine::frames::live::UnportedLive;
use ace_engine::futures::channel::oneshot as futures_oneshot;
use ace_engine::futures::future::LocalBoxFuture;
use ace_engine::ports::{OpenFrame, PortError, Ports, Timer};
use ace_engine::{Engine, EngineStack, Inputs};
use ace_store::Connection;
use ace_store::writer::transaction::{Frame, TransactionStack};
use tokio::sync::oneshot;

use crate::log::Log;
use crate::maintenance::MaintenanceGate;
use crate::store::head_seq_of;

/// One pump turn's wall-clock limits (ADR 0223 §4): 4 ms total, 2 ms intake, 64 runnables.
const TURN_BUDGET: Duration = Duration::from_millis(4);
const INTAKE_BUDGET: Duration = Duration::from_millis(2);
const TURN_RUNNABLES: usize = 64;

/// How long startup waits for `ace-engine` to complete its bounded initial scan.
pub const READY_TIMEOUT: Duration = Duration::from_secs(5);

/// How long shutdown waits for `ace-engine` to run its close sequence.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);

struct WakeState {
    pump_pending: bool,
    close_requested: bool,
    shutdown: bool,
}

struct Wake {
    state: Mutex<WakeState>,
    condvar: Condvar,
}

impl Wake {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(WakeState {
                pump_pending: true,
                close_requested: false,
                shutdown: false,
            }),
            condvar: Condvar::new(),
        })
    }

    fn request_pump(&self) -> Notified {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if state.shutdown {
            return Notified::Closing;
        }
        state.pump_pending = true;
        self.condvar.notify_one();
        Notified::Posted
    }

    fn request_close(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.close_requested = true;
        state.pump_pending = true;
        self.condvar.notify_one();
    }

    fn mark_shutdown(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        state.shutdown = true;
        self.condvar.notify_all();
    }

    fn wait_for_work(&self, next_deadline: Option<Instant>) -> (bool, bool) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        loop {
            if state.shutdown {
                return (false, true);
            }
            if state.close_requested || state.pump_pending {
                let close = state.close_requested;
                state.close_requested = false;
                state.pump_pending = false;
                return (close, false);
            }
            match next_deadline {
                Some(deadline) => {
                    let now = Instant::now();
                    if deadline <= now {
                        return (false, false);
                    }
                    let (guard, timed_out) = self
                        .condvar
                        .wait_timeout(state, deadline.saturating_duration_since(now))
                        .unwrap_or_else(|poison| poison.into_inner());
                    state = guard;
                    if timed_out.timed_out() {
                        return (false, false);
                    }
                }
                None => {
                    state = self
                        .condvar
                        .wait(state)
                        .unwrap_or_else(|poison| poison.into_inner());
                }
            }
        }
    }
}

struct ChannelNotifier(Arc<Wake>);

impl Notifier for ChannelNotifier {
    fn notify(&self) -> Notified {
        self.0.request_pump()
    }
}

struct WallBudget {
    started: Instant,
}

impl WallBudget {
    fn new() -> Self {
        Self {
            started: Instant::now(),
        }
    }
}

impl Budget for WallBudget {
    fn start(&mut self) {
        self.started = Instant::now();
    }

    fn spent(&self, started: usize) -> bool {
        started >= TURN_RUNNABLES || self.started.elapsed() >= TURN_BUDGET
    }

    fn intake_spent(&self) -> bool {
        self.started.elapsed() >= INTAKE_BUDGET
    }
}

struct Timers {
    next_key: u64,
    entries: HashMap<u64, (Instant, futures_oneshot::Sender<()>)>,
}

impl Timers {
    fn new() -> Self {
        Self {
            next_key: 0,
            entries: HashMap::new(),
        }
    }

    fn arm(&mut self, ms: f64) -> Timer {
        self.next_key = self.next_key.wrapping_add(1).max(1);
        let key = self.next_key;
        let clamped_ms = if ms.is_finite() && ms > 0.0 {
            ms.min(u64::MAX as f64) as u64
        } else {
            0
        };
        let deadline = Instant::now() + Duration::from_millis(clamped_ms);
        let (tx, fired) = futures_oneshot::channel();
        self.entries.insert(key, (deadline, tx));
        Timer { key, fired }
    }

    fn cancel(&mut self, key: u64) {
        self.entries.remove(&key);
    }

    fn cancel_all(&mut self) {
        self.entries.clear();
    }

    fn next_deadline(&self) -> Option<Instant> {
        self.entries.values().map(|(deadline, _)| *deadline).min()
    }

    fn fire_due(&mut self, now: Instant) -> bool {
        let due: Vec<u64> = self
            .entries
            .iter()
            .filter_map(|(key, (deadline, _))| (*deadline <= now).then_some(*key))
            .collect();
        if due.is_empty() {
            return false;
        }
        for key in due {
            if let Some((_, tx)) = self.entries.remove(&key) {
                let _ = tx.send(());
            }
        }
        true
    }
}

struct SharedStack {
    stack: RefCell<TransactionStack>,
    detached: Cell<bool>,
}

impl SharedStack {
    fn new() -> Rc<Self> {
        Rc::new(Self {
            stack: RefCell::new(TransactionStack::new()),
            detached: Cell::new(false),
        })
    }
}

impl EngineStack for SharedStack {
    fn is_open(&self) -> bool {
        self.stack.borrow().is_open()
    }

    fn after_commit(&self, token: u64) -> bool {
        if self.detached.get() {
            return false;
        }
        self.stack.borrow_mut().after_commit(token)
    }

    fn detach(&self) -> Vec<u64> {
        self.detached.set(true);
        Vec::new()
    }
}

struct NativePorts {
    conn: Arc<Connection>,
    stack: Rc<SharedStack>,
    frames: RefCell<HashMap<u64, Frame>>,
    next_frame: Cell<u64>,
    after: RefCell<Option<Rc<AfterCommit>>>,
    timers: Rc<RefCell<Timers>>,
    maintenance: Arc<MaintenanceGate>,
    log: Arc<Log>,
    ready_tx: RefCell<Option<oneshot::Sender<Result<(), String>>>>,
    close_tx: RefCell<Option<oneshot::Sender<Option<String>>>>,
    finished: Rc<Cell<bool>>,
    id_counter: Cell<u64>,
}

impl NativePorts {
    fn attach_after(&self, after: Rc<AfterCommit>) {
        *self.after.borrow_mut() = Some(after);
    }

    fn make_id(&self, prefix: &str) -> String {
        if let Ok(uuid) = crate::ids::uuid_v4() {
            return uuid;
        }
        let n = self.id_counter.get().wrapping_add(1);
        self.id_counter.set(n);
        format!("{prefix}-{n}")
    }
}

impl Ports for NativePorts {
    fn now(&self) -> f64 {
        crate::home::now_ms() as f64
    }

    fn set_timer(&self, ms: f64) -> Timer {
        self.timers.borrow_mut().arm(ms)
    }

    fn cancel_timer(&self, key: u64) {
        self.timers.borrow_mut().cancel(key);
    }

    fn cancel_all_timers(&self) {
        self.timers.borrow_mut().cancel_all();
    }

    fn set_batch_timer(&self, ms: f64) -> Timer {
        self.timers.borrow_mut().arm(ms)
    }

    fn thread_id(&self) -> String {
        self.make_id("thread")
    }

    fn command_id(&self) -> String {
        self.make_id("cmd")
    }

    fn next_id(&self, kind: &str) -> String {
        self.make_id(kind)
    }

    fn report(&self, error: String) {
        self.log.log(
            "warn",
            "Engine reported an error",
            serde_json::json!({ "error": error }),
        );
    }

    fn providers_activated(&self) -> LocalBoxFuture<'static, Result<(), PortError>> {
        Box::pin(async { Ok(()) })
    }

    fn wait_for_provider(&self, _provider: &str) -> LocalBoxFuture<'static, Result<(), PortError>> {
        Box::pin(async { Err(PortError::Unbound("waitForProvider")) })
    }

    fn resolve_ready(&self, error: Option<String>) {
        if let Some(tx) = self.ready_tx.borrow_mut().take() {
            let outcome = match error {
                Some(message) => Err(message),
                None => Ok(()),
            };
            let _ = tx.send(outcome);
        }
    }

    fn resolve_close(&self, error: Option<String>) {
        if let Some(tx) = self.close_tx.borrow_mut().take() {
            let _ = tx.send(error);
        }
    }

    fn is_transaction_open(&self) -> bool {
        self.stack.is_open()
    }

    fn open_transaction(&self) -> Result<OpenFrame, PortError> {
        let frame = self
            .stack
            .stack
            .borrow_mut()
            .begin(&self.conn, None)
            .map_err(|error| PortError::Sqlite(error.to_string()))?;
        let outermost = !frame.nested();
        let token = self.next_frame.get().wrapping_add(1).max(1);
        self.next_frame.set(token);
        self.frames.borrow_mut().insert(token, frame);
        Ok(OpenFrame { token, outermost })
    }

    fn close_transaction(&self, frame_token: u64, threw: Option<String>) -> Result<(), PortError> {
        let Some(frame) = self.frames.borrow_mut().remove(&frame_token) else {
            return Err(PortError::Threw(format!(
                "unknown engine transaction frame {frame_token}"
            )));
        };
        let finish = if threw.is_none() {
            self.stack.stack.borrow_mut().succeed(&self.conn, frame)
        } else {
            self.stack.stack.borrow_mut().fail(&self.conn, frame)
        };
        for report in &finish.reports {
            self.report(report.to_string());
        }
        if let Some(after) = self.after.borrow().as_ref().cloned() {
            if !finish.dropped.is_empty() {
                after.drop_tokens(&finish.dropped);
            }
            if !finish.released.is_empty() {
                let remaining = after.release_runs(&finish.released);
                after.release(&remaining);
            }
        }
        if let Some(error) = finish.error {
            return Err(PortError::Sqlite(format!("{error:?}")));
        }
        Ok(())
    }

    fn append_events(&self, _json: &str) -> Result<(), PortError> {
        Err(PortError::Unbound("appendEvents"))
    }

    fn settle_call(&self, _call: u64, _error: Option<String>) {}

    fn reject_pending(&self) {}

    fn finish_close(&self) {
        self.finished.set(true);
    }

    fn admits(&self) -> Result<bool, PortError> {
        Ok(self.maintenance.admit())
    }

    fn head_seq(&self) -> Result<f64, PortError> {
        Ok(head_seq_of(&self.conn) as f64)
    }
}

/// Handle to the running `ace-engine` thread.
pub struct EngineHandle {
    wake: Arc<Wake>,
    ready_rx: Option<oneshot::Receiver<Result<(), String>>>,
    close_rx: Option<oneshot::Receiver<Option<String>>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl EngineHandle {
    /// Spawns the `ace-engine` thread on the daemon's opened event store.
    pub fn start(
        conn: Arc<Connection>,
        maintenance: Arc<MaintenanceGate>,
        log: Arc<Log>,
    ) -> Result<Self, String> {
        schema::migrate(&conn)?;
        let wake = Wake::new();
        let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let (ready_tx, ready_rx) = oneshot::channel();
        let (close_tx, close_rx) = oneshot::channel();
        let thread_wake = Arc::clone(&wake);
        let thread = std::thread::Builder::new()
            .name("ace-engine".to_owned())
            .spawn(move || {
                run_engine_thread(
                    conn,
                    maintenance,
                    log,
                    thread_wake,
                    init_tx,
                    ready_tx,
                    close_tx,
                );
            })
            .map_err(|error| format!("cannot start the engine thread: {error}"))?;
        match init_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                wake,
                ready_rx: Some(ready_rx),
                close_rx: Some(close_rx),
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(_) => {
                let _ = thread.join();
                Err("the engine thread exited before starting".to_owned())
            }
        }
    }

    /// Waits for `ace-engine`'s bounded startup scan to reach `Lifecycle::Ready`.
    pub async fn await_ready(&mut self, timeout: Duration) -> Result<(), String> {
        let Some(rx) = self.ready_rx.take() else {
            return Ok(());
        };
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("engine thread closed before becoming ready".to_owned()),
            Err(_) => Err("engine readiness timed out".to_owned()),
        }
    }

    /// Runs `ace-engine`'s close sequence and joins its thread before `timeout`.
    /// Returns `true` when the engine finished cleanly inside the budget.
    pub async fn close(mut self, timeout: Duration) -> bool {
        self.wake.request_close();
        let settled = match self.close_rx.take() {
            Some(rx) => match tokio::time::timeout(timeout, rx).await {
                Ok(Ok(None)) => true,
                // `ace-engine`'s `recovery::close` returns `NativeEngineIncomplete` (`E5.8`)
                // until recovery lands. All tasks, timers, and the engine thread still shut down
                // cleanly.
                Ok(Ok(Some(message))) if message.starts_with("NativeEngineIncomplete:") => true,
                Ok(Ok(Some(_))) | Ok(Err(_)) | Err(_) => false,
            },
            None => true,
        };
        self.wake.mark_shutdown();
        if let Some(thread) = self.thread.take() {
            let _ = tokio::task::spawn_blocking(move || thread.join()).await;
        }
        settled
    }
}

impl Drop for EngineHandle {
    fn drop(&mut self) {
        self.wake.request_close();
        self.wake.mark_shutdown();
    }
}

fn run_engine_thread(
    conn: Arc<Connection>,
    maintenance: Arc<MaintenanceGate>,
    log: Arc<Log>,
    wake: Arc<Wake>,
    init_tx: std::sync::mpsc::Sender<Result<(), String>>,
    ready_tx: oneshot::Sender<Result<(), String>>,
    close_tx: oneshot::Sender<Option<String>>,
) {
    let stack = SharedStack::new();
    let timers = Rc::new(RefCell::new(Timers::new()));
    let finished = Rc::new(Cell::new(false));
    let ports = Rc::new(NativePorts {
        conn: Arc::clone(&conn),
        stack: Rc::clone(&stack),
        frames: RefCell::new(HashMap::new()),
        next_frame: Cell::new(0),
        after: RefCell::new(None),
        timers: Rc::clone(&timers),
        maintenance,
        log,
        ready_tx: RefCell::new(Some(ready_tx)),
        close_tx: RefCell::new(Some(close_tx)),
        finished: Rc::clone(&finished),
        id_counter: Cell::new(0),
    });
    let notifier = Box::new(ChannelNotifier(Arc::clone(&wake)));
    let actor_deps = Rc::new(ActorDeps::production(Rc::new(UnportedLive), 0.0));
    let engine = match Engine::new(
        Rc::clone(&ports) as Rc<dyn Ports>,
        stack as Rc<dyn EngineStack>,
        Inputs::default(),
        "[]",
        notifier,
        &conn,
        actor_deps,
    ) {
        Ok(engine) => Rc::new(engine),
        Err(error) => {
            let _ = init_tx.send(Err(error.to_string()));
            return;
        }
    };
    ports.attach_after(Rc::clone(&engine.core().after));
    let _ = init_tx.send(Ok(()));

    let mut budget = WallBudget::new();
    let mut closing_started = false;
    loop {
        timers.borrow_mut().fire_due(Instant::now());
        while matches!(engine.pump(&mut budget), Pump::Rearm | Pump::Busy) {
            timers.borrow_mut().fire_due(Instant::now());
            if finished.get() {
                break;
            }
        }
        if finished.get() {
            wake.mark_shutdown();
            break;
        }
        let next_deadline = timers.borrow().next_deadline();
        let (close_requested, shutdown) = wake.wait_for_work(next_deadline);
        if shutdown {
            break;
        }
        if close_requested && !closing_started {
            closing_started = true;
            engine.start_close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::LogLevel;
    use crate::maintenance::MaintenanceHold;
    use crate::store::Store;
    use crate::test_support::TempDir;

    #[tokio::test]
    async fn engine_reaches_ready_on_a_fresh_store_and_closes_cleanly() {
        let dir = TempDir::new("ace-engine-lifecycle");
        let log = Arc::new(Log::open(dir.path(), LogLevel::Error));
        let store = match Store::open(dir.path()) {
            Ok(store) => store,
            Err(error) => panic!("fresh store opens: {error}"),
        };
        let gate = Arc::new(MaintenanceGate::for_store(store.connection()));
        let mut engine = match EngineHandle::start(store.connection(), gate, log) {
            Ok(engine) => engine,
            Err(error) => panic!("engine starts: {error}"),
        };
        let ready = engine.await_ready(Duration::from_secs(3)).await;
        assert!(ready.is_ok(), "engine reaches ready: {ready:?}");
        assert!(
            engine.close(Duration::from_secs(3)).await,
            "engine closes cleanly inside its deadline"
        );
        store.close();
    }

    #[tokio::test]
    async fn engine_respects_maintenance_gate_while_running() {
        let dir = TempDir::new("ace-engine-maintenance");
        let log = Arc::new(Log::open(dir.path(), LogLevel::Error));
        let store = match Store::open(dir.path()) {
            Ok(store) => store,
            Err(error) => panic!("fresh store opens: {error}"),
        };
        let gate = Arc::new(MaintenanceGate::for_store(store.connection()));
        gate.enter(MaintenanceHold::Update);
        assert!(!gate.admit());
        let mut engine = match EngineHandle::start(store.connection(), Arc::clone(&gate), log) {
            Ok(engine) => engine,
            Err(error) => panic!("engine starts under maintenance hold: {error}"),
        };
        let ready = engine.await_ready(Duration::from_secs(3)).await;
        assert!(
            ready.is_ok(),
            "engine still reaches ready under maintenance"
        );
        assert!(engine.close(Duration::from_secs(3)).await);
        store.close();
    }
}
