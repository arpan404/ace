// SPDX-License-Identifier: Apache-2.0
//! The core: the engine's one shared state and the seams around it.

use crate::ThreadId;
use crate::actor;
use crate::actor::task::yield_once;
use crate::error::{EngineError, Lifecycle};
use crate::executor::{AfterCommit, Deferred, DeferredHost, Executor, Lane, TaskId};
use crate::futures::channel::oneshot;
use crate::futures::future::LocalBoxFuture;
use crate::ports::Ports;
use crate::state::{Inputs, ReadyFuture, State};
use crate::store::EngineStore;
use crate::{commands, liveness, recovery, repository, sessions, transitions};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::{Rc, Weak};
use std::task::Waker;

/// The most wake labels the log keeps. The log exists for the probe and E5.2's tests, and an
/// engine lives for days: it keeps a bounded tail rather than every wake it ever released.
pub const WAKE_LOG_CAPACITY: usize = 1024;

/// The released-wake log and the wakers parked actors registered. A long-lived engine must not
/// grow either: the log keeps the newest `WAKE_LOG_CAPACITY` labels, and a thread's waker is
/// removed when its actor goes away.
#[derive(Default)]
pub struct Wakes {
    log: VecDeque<ThreadId>,
    wakers: HashMap<ThreadId, Waker>,
}

impl Wakes {
    /// Records one released wake, keeping the newest labels, and returns the waker it reaches.
    /// The caller wakes outside this borrow.
    pub fn record(&mut self, thread: &str) -> Option<Waker> {
        if self.log.len() == WAKE_LOG_CAPACITY {
            self.log.pop_front();
        }
        self.log.push_back(thread.to_string());
        self.wakers.get(thread).cloned()
    }

    pub fn register(&mut self, thread: ThreadId, waker: Waker) {
        self.wakers.insert(thread, waker);
    }

    /// Drops the waker a thread registered when its actor goes away. Its later wakes are still
    /// logged, and reach nobody.
    pub fn unregister(&mut self, thread: &str) {
        self.wakers.remove(thread);
    }

    pub fn log(&self) -> Vec<String> {
        self.log.iter().cloned().collect()
    }

    pub fn registered(&self) -> usize {
        self.wakers.len()
    }
}

pub struct Core {
    pub executor: Executor,
    pub ports: Rc<dyn Ports>,
    pub store: EngineStore,
    pub(crate) state: RefCell<State>,
    pub after: Rc<AfterCommit>,
    pub(crate) ready: RefCell<Option<ReadyFuture>>,
    pub(crate) ready_tx: RefCell<Option<oneshot::Sender<Result<(), String>>>>,
    pub(crate) inputs: Inputs,
    pub(crate) phase: Cell<&'static str>,
    pub(crate) sweep: Cell<Option<u64>>,
    pub(crate) closing: Cell<bool>,
    pub(crate) admission_closed: Cell<bool>,
    /// Wakes released from the after-commit queue and the wakers parked actors registered.
    pub(crate) wakes: RefCell<Wakes>,
    /// The probe's close step: awaits a port that may never settle.
    pub(crate) probe_close_stall: RefCell<Option<LocalBoxFuture<'static, ()>>>,
    /// The engine's own long-lived tasks, so `shut` cancels them.
    pub(crate) tasks: RefCell<Vec<async_task::Task<(), TaskId>>>,
    /// The actor's dependencies (E5.2 correction 6): one field, set at construction and replaced
    /// by the probe.
    pub actor_deps: RefCell<Rc<actor::ActorDeps>>,
    /// A weak handle to itself, so a synchronous entry can start work on a local task.
    pub(crate) self_weak: RefCell<Weak<Core>>,
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

    /// A strong handle to this engine, for a synchronous entry that starts work.
    pub fn self_rc(&self) -> Option<Rc<Core>> {
        self.self_weak.borrow().upgrade()
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
        self.wakes.borrow().log()
    }

    /// Registers the waker a deferred wake of `thread` reaches (E5.2's actor tasks).
    pub fn register_waker(&self, thread: ThreadId, waker: Waker) {
        self.wakes.borrow_mut().register(thread, waker);
    }

    /// Drops the waker a thread registered when its actor goes away (E5.2 calls this).
    pub fn unregister_waker(&self, thread: &str) {
        self.wakes.borrow_mut().unregister(thread);
    }

    /// Wakers currently registered: the probe's check that a discarded actor left none.
    pub fn registered(&self) -> usize {
        self.wakes.borrow().registered()
    }

    /// The flush depth and how many actor seals flush has asked for (the probe's, E5.1).
    pub fn flush_snapshot(&self) -> (u32, u32) {
        self.state
            .try_borrow()
            .map(|state| (state.flush_depth, state.actors.seals))
            .unwrap_or((0, 0))
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

    pub(crate) fn record_wake(&self, thread: &str) {
        // The waker comes out with the borrow released, so a wake never runs under it.
        let waker = self.wakes.borrow_mut().record(thread);
        if let Some(waker) = waker {
            waker.wake_by_ref();
        }
    }

    pub(crate) fn finish_ready(&self, outcome: Result<(), EngineError>) {
        let result = outcome
            .as_ref()
            .map(|_| ())
            .map_err(|error| error.to_string());
        if let Some(sender) = self.ready_tx.borrow_mut().take() {
            let _ = sender.send(result.clone());
        }
        self.ports.resolve_ready(result.err());
    }

    /// `flush`'s quiescence loop, for a task that flushes from inside another one: it excludes
    /// its own task and worker run. `flushDepth` belongs to the flush task (`start_flush`).
    pub async fn flush_to_quiescence(&self, exclude: Option<TaskId>) -> Result<(), EngineError> {
        if let Some(ready) = self.ready_future() {
            match ready.await {
                Ok(Ok(())) => {}
                Ok(Err(message)) => return Err(EngineError::Registry(message)),
                Err(_) => return Err(EngineError::Closed),
            }
        }
        loop {
            // index.ts:1414 and :1416: seal and flush the actors before and after the worker
            // wait, so a batch arriving during the wait is drained by this same flush.
            if let Some(core) = self.self_rc() {
                actor::flush_all(&core, exclude).await?;
            }
            let waiters = self.worker_waiters(exclude);
            if !waiters.is_empty() {
                futures::future::join_all(waiters).await;
                if let Some(core) = self.self_rc() {
                    actor::flush_all(&core, exclude).await?;
                }
                continue;
            }
            if let Some(core) = self.self_rc() {
                actor::flush_all(&core, exclude).await?;
            }
            if self.executor.idle(exclude) && self.quiescent(exclude) {
                return Ok(());
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
    pub(crate) async fn ready_steps(&self) -> Result<(), EngineError> {
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

    fn run(&self, run: Box<dyn FnOnce()>) {
        run();
    }
}
