// SPDX-License-Identifier: Apache-2.0
//! The facade's Rust half: every exported entry point at its final timing.

use crate::actor;
use crate::close::{CloseOutcome, close_sequence};
use crate::core::Core;
use crate::core::Wakes;
use crate::error::EngineError;
use crate::error::Lifecycle;
use crate::executor;
use crate::executor::{AfterCommit, Budget, DeferredHost, Executor, Lane, Pump};
use crate::futures::channel::oneshot;
use crate::futures::future::FutureExt;
use crate::limits;
use crate::ports::{Ports, Timer};
use crate::recovery;
use crate::state::{EngineStack, FlushDepth, Inputs, State};
use crate::store::EngineStore;
use crate::{CLOSE_DEADLINE_MS, SWEEP_PERIOD_MS};
use std::cell::{Cell, RefCell};
use std::rc::{Rc, Weak};

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
        connection: &std::sync::Arc<ace_store::Connection>,
        actor_deps: Rc<actor::ActorDeps>,
    ) -> Result<Engine, EngineError> {
        let limits = limits::resolve(inputs.limits)?;
        let idle_ms = limits::validate_idle_ms(inputs.idle_ms.unwrap_or(0.0))?;
        let after = AfterCommit::new();
        let store = EngineStore {
            ports: Rc::clone(&ports),
            stack,
            outermost: Cell::new(true),
            conn: std::sync::Arc::clone(connection),
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
            wakes: RefCell::new(Wakes::default()),
            probe_close_stall: RefCell::new(None),
            tasks: RefCell::new(Vec::new()),
            actor_deps: RefCell::new(actor_deps),
            self_weak: RefCell::new(Weak::new()),
        });
        *core.self_weak.borrow_mut() = Rc::downgrade(&core);
        let weak: Weak<dyn DeferredHost> = Rc::downgrade(&core) as Weak<dyn DeferredHost>;
        after.attach(weak);
        core.with_state(|state| {
            state.engine = Rc::downgrade(&core);
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
        let task = core.executor.spawn_barrier(Lane::Work, async move {
            let core = inner;
            // The guard restores the depth even when shutdown cancels this task mid-flush.
            let _depth = match FlushDepth::enter(&core) {
                Ok(depth) => depth,
                Err(error) => {
                    core.ports.settle_call(call, Some(error.to_string()));
                    return;
                }
            };
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
        let task = core.executor.spawn_barrier(Lane::Control, async move {
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
    actor::finish_close(&core);
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
