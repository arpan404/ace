// SPDX-License-Identifier: Apache-2.0
//! The engine binding (E5.1 step 9). Every `#[napi]` member takes `&self` and holds only
//! `Rc<ace_engine::Engine>`: a port can call back into the engine while the outer call is on the
//! stack. The matrix of members lives per item in `engine/<module>.rs`; this file is E5.1's own:
//! the constructor, the pump, flush and close, the registry reads, the binders it stores, and
//! the terminal cleanup.

pub mod access;
pub mod actor;
pub mod approvals;
pub mod commands;
pub mod cursor_reconcile;
pub mod delegation;
pub mod delivery;
pub mod frames;
pub mod hosts;
pub mod inputs;
pub mod intents;
pub mod js_session;
pub mod liveness;
pub mod meters;
pub mod models;
pub mod moves;
pub mod ports;
#[cfg(feature = "engine-probe")]
pub mod probe;
pub mod queue;
pub mod records;
pub mod recovery;
pub mod release;
pub mod repository;
pub mod restart;
pub mod sessions;
pub mod settle;
pub mod snapshot;
pub mod steering;
pub mod transitions;

use ace_engine::executor::{Budget, Lane, Notified, Notifier, Pump};
use ace_engine::ports::Ports;
use ace_engine::{Engine, EngineStack, Inputs};
use napi::bindgen_prelude::{FunctionRef, JsObjectValue, Object};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi::{Env, Status};
use napi_derive::napi;
use ports::JsPorts;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::{Rc, Weak};
use std::time::{Duration, Instant};

use crate::NativeDatabase;
use crate::writer::transaction::{self, StackState};
use std::sync::{Arc, Mutex};

/// The pump's threadsafe function: strong by default, dynamically ref'd and unref'd by the
/// facade's holder count, with an unbounded queue (at most one call is ever pending).
type PumpTsfn = ThreadsafeFunction<(), (), (), Status, false, false, 0>;

/// The one threadsafe function, shared with the notifier and released at close.
type PumpHandle = Arc<Mutex<Option<PumpTsfn>>>;

/// The notifier over the shell's pump entry: the second holder of the one threadsafe function.
struct Bell {
    pump: PumpHandle,
}

impl Notifier for Bell {
    fn notify(&self) -> Notified {
        let pump = match self.pump.lock() {
            Ok(pump) => pump,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(pump) = pump.as_ref() else {
            return Notified::Closing;
        };
        match pump.call((), ThreadsafeFunctionCallMode::NonBlocking) {
            Status::Ok => Notified::Posted,
            Status::Closing => Notified::Closing,
            _ => Notified::Posted,
        }
    }
}

/// The shared stack the TypeScript shell and the engine both open transactions on.
struct SharedStack {
    state: Rc<RefCell<StackState>>,
}

impl EngineStack for SharedStack {
    fn is_open(&self) -> bool {
        self.state.borrow().is_open()
    }

    fn after_commit(&self, token: u64) -> bool {
        self.state.borrow_mut().after_commit(token)
    }

    fn detach(&self) -> Vec<u64> {
        self.state.borrow_mut().detach()
    }
}

/// The engine's sink: released tokens wake the tasks the synchronous entry deferred.
struct Sink {
    after: Rc<ace_engine::executor::AfterCommit>,
}

impl transaction::AfterCommitSink for Sink {
    fn release(&self, tokens: Vec<u64>) {
        self.after.release(&tokens);
    }

    fn drop_tokens(&self, tokens: Vec<u64>) {
        self.after.drop_tokens(&tokens);
    }
}

/// The turn's budget: 64 runnables or 4 ms, with intake stopping after 2 ms.
struct InstantBudget {
    start: Instant,
}

impl InstantBudget {
    fn new() -> InstantBudget {
        InstantBudget {
            start: Instant::now(),
        }
    }
}

impl Budget for InstantBudget {
    fn start(&mut self) {
        self.start = Instant::now();
    }

    fn spent(&self, started: usize) -> bool {
        started >= 64 || self.start.elapsed() >= Duration::from_millis(4)
    }

    fn intake_spent(&self) -> bool {
        self.start.elapsed() >= Duration::from_millis(2)
    }
}

/// The facade's Rust half.
#[napi]
pub struct NativeEngine {
    engine: Rc<Engine>,
    ports: Rc<JsPorts>,
    /// Kept alive while the engine lives; the stack holds a weak handle to it.
    _sink: Rc<Sink>,
    /// The one threadsafe function, released last by `release`.
    pump: PumpHandle,
    /// Pending facade promises and open session queues, ref'd and unref'd as they change.
    holders: Cell<u32>,
    /// `onLimitPolicy` listeners by id, fired by E5.8.
    limit_policies: RefCell<HashMap<u64, FunctionRef<String, ()>>>,
    /// The probe's marks and its one JS callback (E5.1 step 12), only with `engine-probe`.
    #[cfg(feature = "engine-probe")]
    probe: Rc<RefCell<probe::ProbeState>>,
    /// The connection's stack, for the probe's bookkeeping checks.
    #[cfg(feature = "engine-probe")]
    stack: Rc<RefCell<StackState>>,
}

fn engine_error(error: ace_engine::EngineError) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

#[napi]
impl NativeDatabase {
    /// The native engine over this connection and its one transaction stack.
    #[napi]
    pub fn native_engine(
        &self,
        env: Env,
        bindings: Object,
        pump: napi::bindgen_prelude::Function<(), ()>,
    ) -> napi::Result<NativeEngine> {
        let options_json = bindings
            .get_named_property::<String>("options")
            .map_err(|_| napi::Error::from_reason("engine options are missing"))?;
        let registry_json = bindings
            .get_named_property::<String>("registry")
            .unwrap_or_default();
        let parsed = ace_json::parse(&options_json)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let inputs = read_inputs(&parsed);
        let ports = Rc::new(JsPorts::new(
            env,
            bindings
                .get_named_property("clockNow")
                .map_err(|_| napi::Error::from_reason("clockNow is missing"))?,
            bindings
                .get_named_property("armTimer")
                .map_err(|_| napi::Error::from_reason("armTimer is missing"))?,
            bindings
                .get_named_property("armBatchTimer")
                .map_err(|_| napi::Error::from_reason("armBatchTimer is missing"))?,
            bindings
                .get_named_property("threadId")
                .map_err(|_| napi::Error::from_reason("threadId is missing"))?,
            bindings
                .get_named_property("commandId")
                .map_err(|_| napi::Error::from_reason("commandId is missing"))?,
            bindings
                .get_named_property("nextId")
                .map_err(|_| napi::Error::from_reason("nextId is missing"))?,
            bindings
                .get_named_property("report")
                .map_err(|_| napi::Error::from_reason("report is missing"))?,
            bindings
                .get_named_property("providersActivated")
                .map_err(|_| napi::Error::from_reason("providersActivated is missing"))?,
            bindings
                .get_named_property("waitForProvider")
                .map_err(|_| napi::Error::from_reason("waitForProvider is missing"))?,
            bindings
                .get_named_property("resolveReady")
                .map_err(|_| napi::Error::from_reason("resolveReady is missing"))?,
            bindings
                .get_named_property("resolveClose")
                .map_err(|_| napi::Error::from_reason("resolveClose is missing"))?,
            bindings
                .get_named_property("openTransaction")
                .map_err(|_| napi::Error::from_reason("openTransaction is missing"))?,
            bindings
                .get_named_property("closeTransaction")
                .map_err(|_| napi::Error::from_reason("closeTransaction is missing"))?,
            bindings
                .get_named_property("isTransactionOpen")
                .map_err(|_| napi::Error::from_reason("isTransactionOpen is missing"))?,
            bindings
                .get_named_property("appendEvents")
                .map_err(|_| napi::Error::from_reason("appendEvents is missing"))?,
            bindings
                .get_named_property("settleCall")
                .map_err(|_| napi::Error::from_reason("settleCall is missing"))?,
            bindings
                .get_named_property("rejectPending")
                .map_err(|_| napi::Error::from_reason("rejectPending is missing"))?,
            bindings
                .get_named_property("finishClose")
                .map_err(|_| napi::Error::from_reason("finishClose is missing"))?,
        )?);
        let stack = self.transaction_state();
        let pump: PumpHandle = Arc::new(Mutex::new(Some(
            pump.build_threadsafe_function::<()>()
                .callee_handled::<false>()
                .max_queue_size::<0>()
                .build()?,
        )));
        let bell = Bell {
            pump: Arc::clone(&pump),
        };
        let engine = Engine::new(
            Rc::clone(&ports) as Rc<dyn Ports>,
            Rc::new(SharedStack {
                state: Rc::clone(&stack),
            }),
            inputs,
            &registry_json,
            Box::new(bell),
        )
        .map_err(engine_error)?;
        let sink = Rc::new(Sink {
            after: Rc::clone(&engine.core().after),
        });
        transaction::attach_sink(
            &stack,
            Rc::downgrade(&sink) as Weak<dyn transaction::AfterCommitSink>,
        );
        let engine = Rc::new(engine);
        let native = NativeEngine {
            engine,
            ports,
            _sink: sink,
            pump,
            holders: Cell::new(0),
            limit_policies: RefCell::new(HashMap::new()),
            #[cfg(feature = "engine-probe")]
            probe: Rc::new(RefCell::new(probe::ProbeState::default())),
            #[cfg(feature = "engine-probe")]
            stack,
        };
        let _ = env;
        Ok(native)
    }
}

fn read_inputs(options: &ace_json::Value) -> Inputs {
    let mut inputs = Inputs::default();
    let field = |name: &str| match options {
        ace_json::Value::Object(map) => map.get(name),
        _ => None,
    };
    let number = |name: &str| match field(name) {
        Some(ace_json::Value::Number(value)) => value.as_f64(),
        _ => None,
    };
    if let Some(ace_json::Value::Object(limits)) = field("limits") {
        let limit = |name: &str| match limits.get(name) {
            Some(ace_json::Value::Number(value)) => value.as_f64(),
            _ => None,
        };
        inputs.limits = ace_engine::limits::LimitOverrides {
            max_active_threads: limit("maxActiveThreads"),
            max_queued_frames: limit("maxQueuedFrames"),
            max_queued_bytes: limit("maxQueuedBytes"),
            max_frame_bytes: limit("maxFrameBytes"),
            max_pending_inputs: limit("maxPendingInputs"),
            max_input_bytes: limit("maxInputBytes"),
        };
    }
    inputs.idle_ms = number("idleMs");
    if let Some(ace_json::Value::Object(ready)) = field("inputs") {
        let flag = |name: &str| matches!(ready.get(name), Some(ace_json::Value::Bool(true)));
        inputs.has_preferences = flag("preferences");
        inputs.has_models = flag("models");
        inputs.has_providers_activated = flag("providersActivated");
        inputs.has_resolve_silence = flag("resolveSilenceMs");
    }
    inputs
}

#[napi]
impl NativeEngine {
    /// One pump turn; `"rearm"` covers a spent budget and an open transaction.
    #[napi]
    pub fn pump(&self, env: Env) -> String {
        let _guard = self.ports.enter(env);
        let mut budget = InstantBudget::new();
        match self.engine.pump(&mut budget) {
            Pump::Rearm | Pump::Busy => "rearm".to_string(),
            Pump::Done | Pump::Stale => "done".to_string(),
        }
    }

    /// Starts one flush for the shell's promise `call`.
    #[napi]
    pub fn start_flush(&self, env: Env, call: f64) {
        let _guard = self.ports.enter(env);
        self.engine.start_flush(call as u64);
    }

    /// A facade call settled: drop its holder and settle the shell's promise.
    #[napi]
    pub fn settle_call(&self, env: Env, call: f64, error: Option<String>) {
        let _guard = self.ports.enter(env);
        let _ = env;
        self.ports.settle_call(call as u64, error);
    }

    /// Starts close once; the shell owns the cached promise.
    #[napi]
    pub fn close(&self, env: Env) {
        let _guard = self.ports.enter(env);
        self.engine.start_close();
    }

    /// A timer fired: its waiting task resumes in the next pump.
    #[napi]
    pub fn timer_fired(&self, env: Env, key: f64) {
        let _guard = self.ports.enter(env);
        self.ports.timer_fired(key as u64);
    }

    /// A JavaScript promise the engine awaits settled; `ok` false rejects it.
    #[napi]
    pub fn settle_promise(&self, env: Env, id: f64, ok: bool, message: Option<String>) {
        let _guard = self.ports.enter(env);
        self.ports.settle_promise(id as u64, ok, message);
    }

    /// The registry's `observe` listener delivered the entries.
    #[napi]
    pub fn registry_changed(&self, json: String) -> napi::Result<()> {
        self.engine.registry_changed(&json).map_err(engine_error)
    }

    /// `providerAvailability`, as JSON.
    #[napi]
    pub fn provider_availability(&self, provider: String) -> napi::Result<String> {
        self.engine
            .core()
            .with_state(|state| state.registry.availability(&provider))
            .map_err(engine_error)?
            .map_err(engine_error)
    }

    /// `capabilities(provider, backend?)`, as JSON.
    #[napi]
    pub fn capabilities(&self, provider: String, backend: Option<String>) -> napi::Result<String> {
        self.engine
            .core()
            .with_state(|state| state.registry.capabilities(&provider, backend.as_deref()))
            .map_err(engine_error)?
            .map_err(engine_error)
    }

    /// `ensureProvider`: awaits `waitForProvider` on a task and settles the shell's call.
    #[napi]
    pub fn ensure_provider(&self, env: Env, provider: String, call: f64) {
        let _guard = self.ports.enter(env);
        if self.engine.core().lifecycle() == ace_engine::Lifecycle::Closing
            || self.engine.core().lifecycle() == ace_engine::Lifecycle::Closed
        {
            self.ports
                .settle_call(call as u64, Some("Engine closed".to_string()));
            return;
        }
        let ports = Rc::clone(&self.ports);
        let core = Rc::clone(self.engine.core());
        let task = core.executor.spawn(Lane::Control, async move {
            let message =
                "Engine closed while ensureProvider waited on waitForProvider".to_string();
            let outcome = match ports
                .wait_for_provider_message(&provider, Some(message))
                .await
            {
                Ok(()) => Ok(()),
                Err(ace_engine::ports::PortError::NoEnv) => Ok(()),
                Err(error) => Err(error.to_string()),
            };
            ports.settle_call(call as u64, outcome.err());
        });
        task.detach();
    }

    /// `onLimitPolicy`: the listener fires when a thread's limit policy finished loading (E5.8).
    #[napi]
    pub fn on_limit_policy(&self, id: f64, listener: FunctionRef<String, ()>) {
        self.limit_policies.borrow_mut().insert(id as u64, listener);
    }

    /// The unsubscribe the shell returns.
    #[napi]
    pub fn drop_limit_policy(&self, id: f64) {
        self.limit_policies.borrow_mut().remove(&(id as u64));
    }
}

/// A facade async call's promise id helper: the shell allocates ids.
#[napi(object)]
pub struct EnginePumpStats {
    pub turns: f64,
    pub polls: f64,
    pub longest_poll_us: f64,
    pub slow_polls: f64,
    pub last_turn_polls: f64,
}

#[napi]
impl NativeEngine {
    /// A facade promise (or an open native session queue) became pending: 0 -> 1 refs the
    /// threadsafe function so the process stays up for the work.
    #[napi]
    pub fn hold(&self, env: Env) {
        let holders = self.holders.get();
        if holders == 0
            && let Ok(mut pump) = self.pump.lock()
            && let Some(pump) = pump.as_mut()
        {
            #[allow(deprecated)]
            let _ = pump.refer(&env);
        }
        self.holders.set(holders + 1);
    }

    /// A holder settled: 1 -> 0 unrefs the threadsafe function, so an idle engine never keeps
    /// its process alive.
    #[napi]
    pub fn release_hold(&self, env: Env) {
        let holders = self.holders.get();
        if holders == 0 {
            return;
        }
        let holders = holders - 1;
        self.holders.set(holders);
        if holders == 0
            && let Ok(mut pump) = self.pump.lock()
            && let Some(pump) = pump.as_mut()
        {
            #[allow(deprecated)]
            let _ = pump.unref(&env);
        }
    }

    /// The terminal cleanup: zero the reference count and release the threadsafe function.
    #[napi]
    pub fn release(&self, env: Env) {
        let _ = env;
        self.holders.set(0);
        let pump = match self.pump.lock() {
            Ok(mut pump) => pump.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        // Dropping the last reference releases the function (napi's `abort` is its deprecated
        // spelling).
        drop(pump);
    }

    /// The executor's counters, for the probe and the bench.
    #[napi]
    pub fn pump_stats(&self) -> EnginePumpStats {
        let stats = self.engine.stats();
        EnginePumpStats {
            turns: stats.turns as f64,
            polls: stats.polls as f64,
            longest_poll_us: stats.longest_poll_us as f64,
            slow_polls: stats.slow_polls as f64,
            last_turn_polls: stats.last_turn_polls as f64,
        }
    }
}
