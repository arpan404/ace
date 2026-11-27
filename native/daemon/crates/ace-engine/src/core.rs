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
use ace_json::Value;
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

    /// `repo.apply` (`repository.ts:413`): the fold in the store's transaction, with the borrow
    /// released around the transaction's open, which can flush a pinned live batch and re-enter
    /// this engine through `persist`/`committed`.
    pub fn apply(
        &self,
        id: &str,
        facts_json: &str,
        now: f64,
        generation: Option<f64>,
    ) -> Result<(), EngineError> {
        let outcome = self.store.atomic(|_tx| {
            // The snapshot loads inside the transaction, as `repository.ts:413` reads it there;
            // opening the frame (which can flush a pinned batch) therefore holds no borrow.
            let fold = self.with_state(|state| {
                state.fold_frame(&self.store, id, facts_json, now, generation)
            })?;
            if fold.is_err() {
                let _ = self.with_state(|state| state.deferred_queue.clear());
            }
            let folded = fold?;
            // Queue writes precede the fold's save in the same transaction. Release the state
            // borrow for the queue writer so its store hooks can re-enter.
            self.flush_deferred()?;
            self.with_state(|state| folded.save(state, &self.store, id, now))?
        });
        if let Err(error) = outcome {
            let _ = self.with_state(|state| state.repo.evict(&self.store, id));
            return Err(error);
        }
        self.observe(id, facts_json, now)?;
        Ok(())
    }

    /// `repo.observe` (`repository.ts:419`): every committed fold reaches recovery's limit and
    /// restart rules. Called after the transaction, so a rule may write its own.
    pub fn observe(&self, id: &str, facts_json: &str, now: f64) -> Result<(), EngineError> {
        let facts = match ace_json::parse(facts_json) {
            Ok(Value::Array(facts)) => facts.into_vec(),
            _ => Vec::new(),
        };
        recovery::observe::observe(self, id, &facts, now)
    }

    /// `repo.stream` (`repository.ts:363`): the live batch's refusals and fold inside one state
    /// borrow, then the store's buffer outside it, since buffering can flush and the flush
    /// re-enters this engine.
    pub fn stream(&self, id: &str, facts_json: &str, now: f64) -> Result<bool, EngineError> {
        let prepared =
            self.with_state(|state| state.prepare_stream(&self.store, id, facts_json, now))??;
        self.flush_deferred()?;
        let Some(prepared) = prepared else {
            return Ok(false);
        };
        // The pin is registered before admission: the buffer may flush synchronously while
        // admitting, and the flush settles this token.
        self.with_state(|state| {
            state.repo.live.insert(
                prepared.token,
                crate::repository::stream::Pin {
                    snapshot: Rc::clone(&prepared.snapshot),
                    events: prepared.events.clone(),
                },
            );
        })?;
        if let Err(error) = self
            .store
            .prepare_live_write(prepared.bytes)
            .and_then(|()| {
                self.store
                    .buffer_live_write(id, &prepared.events, now, prepared.token)
            })
        {
            let _ = self.with_state(|state| state.repo.live.remove(&prepared.token).is_some());
            return Err(error);
        }
        self.observe(id, facts_json, now)?;
        Ok(true)
    }

    /// The live buffer's `persist(token)` (E5.3 step 8): the pinned snapshot's rows.
    pub fn live_persist(&self, token: u64) -> Result<(), EngineError> {
        self.with_state(|state| state.live_persist(&self.store, token))?
    }

    /// The live buffer's `committed(token)`: the pin settles its snapshot and the repository
    /// records the commit.
    pub fn live_committed(&self, token: u64) -> Result<(), EngineError> {
        self.with_state(|state| state.live_committed(&self.store, token))?
    }

    /// The store's quarantine notification for one thread (E5.3 step 8): the pin is already
    /// removed, so the snapshot is evicted and released, then the actor is told.
    pub fn quarantined(&self, thread: &str, message: &str) -> Result<(), EngineError> {
        let evicted = self.with_state(|state| state.quarantined(&self.store, thread));
        // The actor is told however the eviction went: its session is stopped either way.
        if let Some(core) = self.self_rc() {
            crate::actor::failure::quarantine(&core, &thread.to_owned(), message);
        }
        evicted?
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

    /// `silence.forWorkspace(workspaceId)`'s default (`silence.ts:56`): five minutes unless the
    /// engine was given `options.silenceMs`. A workspace's cached override is E5.6's resolver.
    pub fn silence_ms(&self) -> f64 {
        self.inputs.silence_ms.unwrap_or(300_000.0)
    }

    /// The readiness future both `flush` and `close` await, shared and cloned per caller.
    pub fn ready_future(&self) -> Option<ReadyFuture> {
        self.ready.borrow().clone()
    }

    /// Wakes released so far, in release order.
    pub fn wakes(&self) -> Vec<String> {
        self.wakes.borrow().log()
    }

    /// Writes the queue events a fold staged, with no `State` borrow held, so an event-writer
    /// hook can re-enter the engine.
    pub fn flush_deferred(&self) -> Result<(), EngineError> {
        let staged = self.with_state(|state| std::mem::take(&mut state.deferred_queue))?;
        for write in staged {
            crate::queue::write::finish(&self.store, &write)?;
        }
        Ok(())
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
        let actors = self
            .with_state(|state| {
                state
                    .actors
                    .instances()
                    .filter(|actor| actor.borrow().waker.is_some())
                    .count()
            })
            .unwrap_or(0);
        self.wakes.borrow().registered() + actors
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

    /// Releases every deferred the shell's stack has not released yet. The shell releases them
    /// at its commit; a test shell that models the stack's order calls this instead.
    pub fn release_after_commit(&self) {
        let tokens = self.after.tokens();
        self.after.release(&tokens);
    }

    /// Drops deferreds a rolled-back frame held, as the shell's stack does.
    pub fn discard_after_commit(&self, tokens: &[u64]) {
        self.after.discard(tokens);
    }

    /// The probe's close step (E5.1 step 12).
    pub fn set_close_stall(&self, stall: LocalBoxFuture<'static, ()>) {
        *self.probe_close_stall.borrow_mut() = Some(stall);
    }

    pub(crate) fn record_wake(&self, thread: &str) {
        // The waker comes out with the borrow released, so a wake never runs under it.
        let actor = actor::state::current(self, thread);
        let waker = self.wakes.borrow_mut().record(thread);
        let actor_waker = actor.and_then(|actor| actor.borrow().waker.clone());
        if let Some(waker) = actor_waker.or(waker) {
            waker.wake_by_ref();
        }
    }

    pub(crate) fn record_actor_wake(&self, actor: &actor::ActorRef) {
        let (thread, waker) = {
            let state = actor.borrow();
            (state.id.clone(), state.waker.clone())
        };
        self.wakes.borrow_mut().record(&thread);
        if let Some(waker) = waker {
            waker.wake();
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

    /// The readiness sequence of `index.ts:466`–`:487`.
    pub(crate) async fn ready_steps(&self) -> Result<(), EngineError> {
        if self.inputs.any_ready_port() {
            self.ports
                .providers_activated()
                .await
                .map_err(EngineError::Port)?;
            let mut thresholds =
                self.with_state(|state| std::mem::take(&mut state.sessions.silence))?;
            let prepared = sessions::prepare_silence(&mut thresholds).await;
            self.with_state(|state| state.sessions.silence = thresholds)?;
            prepared?;
            if let Some(core) = self.self_rc() {
                recovery::prepare_ready(&core).await?;
            }
        }
        // The restart pass in bounded slices: the same threads, recovered the same way, each
        // slice and each thread's recovery a separate pump step (E5.8, ADR 0170).
        if let Some(core) = self.self_rc() {
            recovery::startup::run(&core).await?;
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
        // E5.4f's sends worker starts from here; this branch has no worker yet.
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
