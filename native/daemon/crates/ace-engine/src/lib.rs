// SPDX-License-Identifier: Apache-2.0
//! The daemon's engine (ADR 0223 §2, E5). E5.1 ports the facade's machinery first: the local
//! executor, the ports, the registry view, the intent workers, the limits, the store seam with
//! its after-commit wakes, and `ready`/`flush`/`close` with every public method declared at its
//! final timing. E5.2 to E5.10 fill in the modules behind these seams.

pub use futures;

pub mod access;
pub mod actor;
pub mod approvals;
pub mod commands;
pub mod cursor_reconcile;
pub mod delegation;
pub mod delivery;
pub mod executor;
pub mod frames;
pub mod hosts;
pub mod inputs;
pub mod intents;
pub mod limits;
pub mod liveness;
pub mod meters;
pub mod models;
pub mod moves;
pub mod ports;
pub mod queue;
pub mod records;
pub mod recovery;
pub mod registry;
pub mod release;
pub mod repository;
pub mod restart;
pub mod sessions;
pub mod settle;
pub mod snapshot;
pub mod steering;
pub mod transitions;
pub mod workers;

use executor::{AfterCommit, Budget, Deferred, DeferredHost, Executor, Lane, Pump, TaskId};
use futures::FutureExt;
use futures::channel::oneshot;
use futures::future::{LocalBoxFuture, Shared};
use ports::{Ports, Timer};
use registry::Registry;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::panic::AssertUnwindSafe;
use std::rc::{Rc, Weak};
use std::task::Waker;

/// The engine's thread ids are the protocol's strings.
pub type ThreadId = String;

/// The close deadline: the daemon's forced stop ends at 3.5 s (3 s polite + 0.5 s grace), plus
/// 1 s for the exits to be reaped and the final batches to commit, inside the 6 s cleanup budget.
pub const CLOSE_DEADLINE_MS: f64 = 4_500.0;

/// The idle sweep's period (`index.ts:146`).
pub const SWEEP_PERIOD_MS: f64 = 30_000.0;

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("Invalid engine limit")]
    InvalidLimit,
    #[error("Invalid idleMs")]
    InvalidIdleMs,
    #[error("engine state is already borrowed")]
    Reentrant,
    #[error("NativeEngineIncomplete: {what} lands in {item}")]
    NotPorted {
        what: &'static str,
        item: &'static str,
    },
    #[error(transparent)]
    Port(#[from] ports::PortError),
    #[error(transparent)]
    Store(#[from] ace_store::Error),
    #[error("The provider isn't ready yet. Check its connection in Settings and try again.")]
    ProviderNotReady,
    #[error("{0}")]
    Registry(String),
    #[error("Engine starting")]
    Starting,
    #[error("Engine closing")]
    Closing,
    #[error("Engine closed")]
    Closed,
}

impl EngineError {
    pub fn not_ported(what: &'static str, item: &'static str) -> EngineError {
        EngineError::NotPorted { what, item }
    }

    /// The error class the binding puts on the JS error, such as `ACE_ENGINE_CLOSED`.
    pub fn code(&self) -> Option<&'static str> {
        match self {
            EngineError::Closed => Some("ACE_ENGINE_CLOSED"),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lifecycle {
    #[default]
    Starting,
    Ready,
    Closing,
    Closed,
}

/// The engine's shared state. It holds no port, no executor and no store handle, so a
/// `with_state` closure cannot call a port, spawn or await.
pub struct State {
    pub limits: limits::EngineLimits,
    pub registry: Registry,
    pub workers: workers::WorkerSet,
    pub lifecycle: Lifecycle,
    /// `flushDepth` (`index.ts:1407`): how many `flush` calls are inside.
    pub flush_depth: u32,
    /// The probe's one stub (E5.1): the recovery-candidate scan answers with no rows so
    /// `ready()` can resolve before E5.3 lands. E5.3 deletes it.
    pub probe_empty_candidates: bool,
    pub actors: actor::Actors,                 // E5.2
    pub repo: repository::Repo,                // E5.3
    pub commands: commands::Commands,          // E5.4
    pub sessions: sessions::Sessions,          // E5.6
    pub recovery: recovery::Recovery,          // E5.8
    pub transitions: transitions::Transitions, // E5.9
    pub liveness: liveness::Liveness,          // E5.10
}

impl Default for State {
    fn default() -> State {
        State {
            limits: limits::EngineLimits::default(),
            registry: Registry::default(),
            workers: workers::WorkerSet::default(),
            lifecycle: Lifecycle::default(),
            flush_depth: 0,
            probe_empty_candidates: false,
            actors: actor::Actors,
            repo: repository::Repo,
            commands: commands::Commands,
            sessions: sessions::Sessions,
            recovery: recovery::Recovery,
            transitions: transitions::Transitions,
            liveness: liveness::Liveness,
        }
    }
}

/// The shared stack the store's shell owns, reached from Rust: one handle per connection.
pub trait EngineStack {
    fn is_open(&self) -> bool;
    /// Inside an open transaction: the token joins the after-commit list and this is true.
    fn after_commit(&self, token: u64) -> bool;
    /// Detaches the after-commit sink at close; whatever it still held is returned.
    fn detach(&self) -> Vec<u64>;
}

/// One open transaction, as the engine's body sees it: a borrow of the connection, nothing
/// storable and nothing to hold across an await.
pub struct Tx<'a> {
    store: &'a EngineStore,
}

impl Tx<'_> {
    /// The batch joins the open context's event list exactly once.
    pub fn append_events(&self, json: &str) -> Result<(), EngineError> {
        self.store
            .ports
            .append_events(json)
            .map_err(EngineError::Port)
    }
}

/// The store seam: the shell's transaction context, any transaction's one lifecycle.
pub struct EngineStore {
    ports: Rc<dyn Ports>,
    stack: Rc<dyn EngineStack>,
    outermost: Cell<bool>,
}

impl EngineStore {
    /// Opens through the shell, runs the body synchronously, then closes. A port the body calls
    /// that runs `Store.atomic` nests as a savepoint in the same context; a Rust `atomic` inside
    /// a JavaScript one gets a nested frame in the JavaScript context.
    pub fn atomic<R>(
        &self,
        run: impl FnOnce(&Tx<'_>) -> Result<R, EngineError>,
    ) -> Result<R, EngineError> {
        let frame = self.ports.open_transaction().map_err(EngineError::Port)?;
        let previous = self.outermost.replace(frame.outermost);
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| run(&Tx { store: self })));
        self.outermost.set(previous);
        match result {
            Ok(Ok(value)) => {
                self.ports
                    .close_transaction(frame.token, None)
                    .map_err(EngineError::Port)?;
                Ok(value)
            }
            Ok(Err(error)) => {
                let _ = self
                    .ports
                    .close_transaction(frame.token, Some(error.to_string()));
                Err(error)
            }
            Err(panic) => {
                let _ = self
                    .ports
                    .close_transaction(frame.token, Some("panic".to_string()));
                std::panic::resume_unwind(panic)
            }
        }
    }

    /// `is_outermost`: whether the frame a Rust body is running in is the top-level one. A frame
    /// never resolves an acknowledgement on a savepoint's release (E5.2 asserts this).
    pub fn is_outermost(&self) -> bool {
        self.outermost.get()
    }

    /// Whether a top-level transaction is open on the shared stack.
    pub fn is_open(&self) -> bool {
        self.stack.is_open()
    }

    /// The only way a synchronous entry starts work: joins the after-commit list of the open
    /// transaction, or releases at once outside one.
    pub fn after_commit(&self, token: u64) -> bool {
        self.stack.after_commit(token)
    }

    fn detach(&self) -> Vec<u64> {
        self.stack.detach()
    }
}

/// What the facade's options carry that construction needs.
#[derive(Debug, Clone, Copy, Default)]
pub struct Inputs {
    pub limits: limits::LimitOverrides,
    pub idle_ms: Option<f64>,
    pub has_preferences: bool,
    pub has_models: bool,
    pub has_providers_activated: bool,
    pub has_resolve_silence: bool,
}

impl Inputs {
    fn any_ready_port(&self) -> bool {
        self.has_preferences
            || self.has_models
            || self.has_providers_activated
            || self.has_resolve_silence
    }
}

type ReadyFuture = Shared<oneshot::Receiver<Result<(), String>>>;

pub struct Core {
    pub executor: Executor,
    pub ports: Rc<dyn Ports>,
    pub store: EngineStore,
    state: RefCell<State>,
    pub after: Rc<AfterCommit>,
    ready: RefCell<Option<ReadyFuture>>,
    ready_tx: RefCell<Option<oneshot::Sender<Result<(), String>>>>,
    inputs: Inputs,
    phase: Cell<&'static str>,
    sweep: Cell<Option<u64>>,
    closing: Cell<bool>,
    admission_closed: Cell<bool>,
    /// Wakes released from the after-commit queue, in order (the probe's log; E5.2 reads it).
    wakes: RefCell<Vec<String>>,
    wakers: RefCell<HashMap<ThreadId, Waker>>,
    /// The probe's close step: awaits a port that may never settle.
    probe_close_stall: RefCell<Option<LocalBoxFuture<'static, ()>>>,
    /// The engine's own long-lived tasks, so `shut` cancels them.
    tasks: RefCell<Vec<async_task::Task<(), TaskId>>>,
}

impl Core {
    /// The only way to reach state. Never re-entered: a borrow already held is
    /// `EngineError::Reentrant`, never a panic.
    pub fn with_state<R>(&self, f: impl FnOnce(&mut State) -> R) -> Result<R, EngineError> {
        let mut state = self
            .state
            .try_borrow_mut()
            .map_err(|_| EngineError::Reentrant)?;
        Ok(f(&mut state))
    }

    pub fn lifecycle(&self) -> Lifecycle {
        self.state
            .try_borrow()
            .map(|state| state.lifecycle)
            .unwrap_or(Lifecycle::Closing)
    }

    pub fn inputs(&self) -> Inputs {
        self.inputs
    }

    /// The readiness future both `flush` and `close` await, shared and cloned per caller.
    pub fn ready_future(&self) -> Option<ReadyFuture> {
        self.ready.borrow().clone()
    }

    /// Wakes released so far, in release order.
    pub fn wakes(&self) -> Vec<String> {
        self.wakes.borrow().clone()
    }

    /// Registers the waker a deferred wake of `thread` reaches (E5.2's actor tasks).
    pub fn register_waker(&self, thread: ThreadId, waker: Waker) {
        self.wakers.borrow_mut().insert(thread, waker);
    }

    /// The only way a synchronous entry starts work: after the outermost commit, never inline.
    pub fn defer(&self, item: Deferred) {
        let token = self.after.defer(item);
        if !self.store.after_commit(token) {
            self.after.release(&[token]);
        }
    }

    /// The probe's close step (E5.1 step 12).
    pub fn set_close_stall(&self, stall: LocalBoxFuture<'static, ()>) {
        *self.probe_close_stall.borrow_mut() = Some(stall);
    }

    fn record_wake(&self, thread: &str) {
        self.wakes.borrow_mut().push(thread.to_string());
        if let Some(waker) = self.wakers.borrow().get(thread) {
            waker.wake_by_ref();
        }
    }

    fn finish_ready(&self, outcome: Result<(), EngineError>) {
        let result = outcome
            .as_ref()
            .map(|_| ())
            .map_err(|error| error.to_string());
        if let Some(sender) = self.ready_tx.borrow_mut().take() {
            let _ = sender.send(result.clone());
        }
        self.ports.resolve_ready(result.err());
    }

    /// `flush`'s loop, for a task that flushes from inside another one: it excludes its own
    /// task and worker run.
    pub async fn flush_to_quiescence(&self, exclude: Option<TaskId>) -> Result<(), EngineError> {
        if let Some(ready) = self.ready_future() {
            match ready.await {
                Ok(Ok(())) => {}
                Ok(Err(message)) => return Err(EngineError::Registry(message)),
                Err(_) => return Err(EngineError::Closed),
            }
        }
        loop {
            let waiters = self.worker_waiters(exclude);
            if waiters.is_empty() && self.executor.idle() && self.quiescent(exclude) {
                return Ok(());
            }
            if !waiters.is_empty() {
                futures::future::join_all(waiters).await;
                continue;
            }
            // One macrotask: the pump runs the work queued behind us, then this task resumes.
            yield_once().await;
        }
    }

    /// The probe's stub: the recovery-candidate scan answers with no rows (E5.3 deletes this).
    pub fn probe_empty_candidates(&self) {
        if let Ok(mut state) = self.state.try_borrow_mut() {
            state.probe_empty_candidates = true;
        }
    }

    /// The readiness sequence of `index.ts:466`–`:487`.
    async fn ready_steps(&self) -> Result<(), EngineError> {
        if self.inputs.any_ready_port() {
            self.ports
                .providers_activated()
                .await
                .map_err(EngineError::Port)?;
            self.with_state(sessions::prepare_silence)??;
            self.with_state(recovery::prepare)??;
            loop {
                let slice =
                    self.with_state(|state| repository::recovery_candidates(state, 256))??;
                if slice.is_empty() {
                    break;
                }
                for thread in slice {
                    self.with_state(|state| recovery::recover_thread(state, &thread))??;
                }
            }
        } else {
            // The synchronous `recover()` of the TypeScript; a fresh home has no candidates.
            loop {
                let slice =
                    self.with_state(|state| repository::recovery_candidates(state, 256))??;
                if slice.is_empty() {
                    break;
                }
                for thread in slice {
                    self.with_state(|state| recovery::recover_thread(state, &thread))??;
                }
            }
        }
        self.with_state(|state| {
            state.lifecycle = Lifecycle::Ready;
        })
    }

    /// Every module's quiescence check, excluding the caller's own task.
    fn quiescent(&self, exclude: Option<TaskId>) -> bool {
        let Ok(state) = self.state.try_borrow() else {
            return false;
        };
        actor::quiescent(&state, exclude)
            && repository::quiescent(&state, exclude)
            && commands::quiescent(&state, exclude)
            && sessions::quiescent(&state, exclude)
            && recovery::quiescent(&state, exclude)
            && transitions::quiescent(&state, exclude)
            && liveness::quiescent(&state, exclude)
    }

    fn worker_waiters(&self, exclude: Option<TaskId>) -> Vec<oneshot::Receiver<()>> {
        let Ok(state) = self.state.try_borrow() else {
            return Vec::new();
        };
        state.workers.waiters(exclude)
    }
}

impl DeferredHost for Core {
    fn wake(&self, thread: &str, _lane: Lane) {
        // A released wake belongs to work admitted before admission closed, so the shutdown
        // join runs it; only `shut` stops new runnables, in the schedule function.
        self.record_wake(thread);
    }

    fn spawn(&self, lane: Lane, future: LocalBoxFuture<'static, ()>) {
        let task = self.executor.spawn(lane, future);
        task.detach();
    }
}

/// The facade's Rust half. Every `#[napi]` member holds this through `Rc` and takes `&self`.
pub struct Engine {
    core: Rc<Core>,
}

impl Engine {
    pub fn new(
        ports: Rc<dyn Ports>,
        stack: Rc<dyn EngineStack>,
        inputs: Inputs,
        registry_json: &str,
        notifier: Box<dyn executor::Notifier>,
    ) -> Result<Engine, EngineError> {
        let limits = limits::resolve(inputs.limits)?;
        let idle_ms = limits::validate_idle_ms(inputs.idle_ms.unwrap_or(0.0))?;
        let after = AfterCommit::new();
        let store = EngineStore {
            ports: Rc::clone(&ports),
            stack,
            outermost: Cell::new(true),
        };
        let mut state = State {
            limits,
            ..State::default()
        };
        state.registry.set_entries(registry_json)?;
        let (ready_tx, ready_rx) = oneshot::channel();
        let core = Rc::new(Core {
            executor: Executor::new(notifier),
            ports: Rc::clone(&ports),
            store,
            state: RefCell::new(state),
            after: Rc::clone(&after),
            ready: RefCell::new(Some(ready_rx.shared())),
            ready_tx: RefCell::new(Some(ready_tx)),
            inputs,
            phase: Cell::new("readiness"),
            sweep: Cell::new(None),
            closing: Cell::new(false),
            admission_closed: Cell::new(false),
            wakes: RefCell::new(Vec::new()),
            wakers: RefCell::new(HashMap::new()),
            probe_close_stall: RefCell::new(None),
            tasks: RefCell::new(Vec::new()),
        });
        let weak: Weak<dyn DeferredHost> = Rc::downgrade(&core) as Weak<dyn DeferredHost>;
        after.attach(weak);
        core.with_state(|state| {
            state.lifecycle = Lifecycle::Starting;
            state.flush_depth = 0;
            let _ = idle_ms;
        })?;
        start_sweep(&core);
        start_ready(Rc::clone(&core));
        Ok(Engine { core })
    }

    pub fn core(&self) -> &Rc<Core> {
        &self.core
    }

    /// The pump's one turn; the shell schedules the continuation on `Rearm`.
    pub fn pump(&self, budget: &mut dyn Budget) -> Pump {
        let store = &self.core.store;
        self.core.executor.pump(budget, &|| store.is_open())
    }

    pub fn stats(&self) -> executor::ExecutorStats {
        self.core.executor.stats()
    }

    pub fn turns(&self) -> Vec<u32> {
        self.core.executor.turns()
    }

    /// Starts `flush`: resolves once the ready promise settled, every worker set is idle, the
    /// ready queues are empty and no task is running, re-checked after each wait.
    pub fn start_flush(self: &Rc<Self>, call: u64) {
        if self.core.closing.get() {
            self.core
                .ports
                .settle_call(call, Some("Engine closed".into()));
            return;
        }
        // The caller's task, so a flush reached through a port excludes it, not the flush task.
        let exclude = self.core.executor.current();
        let core = Rc::clone(&self.core);
        let inner = Rc::clone(&core);
        let task = core.executor.spawn(Lane::Work, async move {
            let core = inner;
            let result = core.flush_to_quiescence(exclude).await;
            core.ports
                .settle_call(call, result.as_ref().err().map(ToString::to_string));
        });
        task.detach();
    }

    /// Starts `close` as one engine task; its promise is the facade's cached one.
    pub fn start_close(self: &Rc<Self>) {
        let core = Rc::clone(&self.core);
        let inner = Rc::clone(&core);
        let task = core.executor.spawn(Lane::Control, async move {
            close_task(inner).await;
        });
        task.detach();
    }

    /// The registry's `observe` listener delivered the changed entries.
    pub fn registry_changed(&self, json: &str) -> Result<(), EngineError> {
        self.core
            .with_state(|state| state.registry.set_entries(json))?
    }

    /// Whether the engine has reached `Ready`.
    pub fn is_ready(&self) -> bool {
        self.core.lifecycle() == Lifecycle::Ready
    }
}

fn start_ready(core: Rc<Core>) {
    let task_core = Rc::clone(&core);
    let task = core.executor.spawn(Lane::Control, async move {
        let outcome = task_core.ready_steps().await;
        task_core.finish_ready(outcome);
    });
    core.tasks.borrow_mut().push(task);
}

fn start_sweep(core: &Rc<Core>) {
    let weak = Rc::downgrade(core);
    let task = core.executor.spawn(Lane::Control, async move {
        loop {
            let Some(core) = weak.upgrade() else { return };
            let timer: Timer = core.ports.set_timer(SWEEP_PERIOD_MS);
            core.sweep.set(Some(timer.key));
            if timer.fired.await.is_err() {
                return;
            }
            core.sweep.set(None);
            if core.closing.get() {
                return;
            }
            let Some(core) = weak.upgrade() else { return };
            match core.with_state(recovery::prune_idle) {
                Ok(Err(error)) | Err(error) => core.ports.report(error.to_string()),
                Ok(Ok(())) => {}
            }
        }
    });
    core.tasks.borrow_mut().push(task);
}

/// One close: the deadline is armed first, the sequence races it, and steps 2 to 6 never await.
async fn close_task(core: Rc<Core>) {
    let deadline = core.ports.set_timer(CLOSE_DEADLINE_MS);
    // The engine is closing from this moment, whichever phase the deadline cuts.
    core.closing.set(true);
    core.with_state(|state| {
        state.lifecycle = Lifecycle::Closing;
        state.flush_depth += 1;
    })
    .ok();
    if let Some(key) = core.sweep.take() {
        core.ports.cancel_timer(key);
    }
    let sequence = Box::pin(close_sequence(Rc::clone(&core)));
    let raced = futures::future::select(sequence, Box::pin(deadline.fired)).await;
    let mut outcome = match raced {
        futures::future::Either::Left((result, _)) => {
            core.ports.cancel_timer(deadline.key);
            result
        }
        futures::future::Either::Right((_, _)) => {
            core.ports.report(format!(
                "Engine close passed its 4.5 s deadline during {}",
                core.phase.get()
            ));
            CloseOutcome::default()
        }
    };
    // Step 2: close admission if the deadline cut the sequence before it.
    if !core.admission_closed.replace(true) {
        drop(core.executor.close_admission());
    }
    // Step 4: detach the after-commit sink, then cancel everything left.
    let stranded = core.store.detach();
    let held = core.after.detach();
    if !stranded.is_empty() || !held.is_empty() {
        core.ports.report(format!(
            "Engine close dropped {} after-commit token(s) still pending",
            stranded.len() + held.len()
        ));
    }
    // Every terminal path: no timer is left armed and no parked task keeps a sender.
    core.ports.cancel_all_timers();
    core.executor.shut();
    core.tasks.borrow_mut().clear();
    // Step 5: every facade promise still pending rejects with Engine closed.
    core.ports.reject_pending();
    core.with_state(|state| {
        state.lifecycle = Lifecycle::Closed;
    })
    .ok();
    // Step 6: settle the close promise from its own result alone.
    outcome.readiness = outcome.readiness.or_else(|| core.ready_error());
    core.ports.resolve_close(
        outcome
            .readiness
            .or(outcome.module)
            .map(|error| error.to_string()),
    );
    core.ports.finish_close();
}

/// Yields once: the next poll returns `Ready`, after the pump has run what was queued.
async fn yield_once() {
    let mut yielded = false;
    futures::future::poll_fn(|cx| {
        if yielded {
            return std::task::Poll::Ready(());
        }
        yielded = true;
        cx.waker().wake_by_ref();
        std::task::Poll::Pending
    })
    .await;
}

#[derive(Default)]
struct CloseOutcome {
    readiness: Option<EngineError>,
    module: Option<EngineError>,
}

impl Core {
    fn ready_error(&self) -> Option<EngineError> {
        let ready = self.ready.borrow().clone()?;
        match ready.now_or_never() {
            Some(Ok(Err(message))) => Some(EngineError::Registry(message)),
            Some(Err(_)) => Some(EngineError::Closed),
            _ => None,
        }
    }
}

async fn close_sequence(core: Rc<Core>) -> CloseOutcome {
    let mut outcome = CloseOutcome::default();
    core.phase.set("readiness");
    if let Some(ready) = core.ready_future() {
        match ready.await {
            Ok(Ok(())) => {}
            Ok(Err(message)) => outcome.readiness = Some(EngineError::Registry(message)),
            Err(_) => outcome.readiness = Some(EngineError::Closed),
        }
    }
    core.phase.set("recovery close");
    if let Ok(Err(error)) = core.with_state(recovery::close) {
        outcome.module = Some(error);
    }
    let stall = core.probe_close_stall.borrow_mut().take();
    if let Some(stall) = stall {
        core.phase.set("probe close");
        stall.await;
    }
    core.phase.set("join");
    if !core.admission_closed.replace(true) {
        let drained = core.executor.close_admission();
        let _ = drained.await;
    }
    outcome
}
