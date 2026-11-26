// SPDX-License-Identifier: Apache-2.0
//! The engine's shared state: plain data, so no port lives in a `with_state` closure.

use crate::actor;
use crate::commands;
use crate::error::{EngineError, Lifecycle};
use crate::futures::channel::oneshot;
use crate::futures::future::Shared;
use crate::limits::{self};
use crate::liveness;
use crate::recovery;
use crate::registry::Registry;
use crate::repository;
use crate::sessions;
use crate::transitions;
use crate::workers;
use crate::{Core, ThreadId};
use std::rc::Rc;

/// The engine's shared state. It holds no port, no executor and no store handle, so a
/// `with_state` closure cannot call a port, spawn or await.
pub struct State {
    pub limits: limits::EngineLimits,
    pub registry: Registry,
    pub workers: workers::WorkerSet,
    pub lifecycle: Lifecycle,
    /// `flushDepth` (`index.ts:1407`): how many `flush` calls are inside.
    pub flush_depth: u32,
    pub actors: actor::Actors, // E5.2
    /// A live-buffer flush task is queued on the pump (E5.2 step 16): the coalescing flag.
    pub live_flush: std::rc::Rc<std::cell::Cell<bool>>,
    pub repo: repository::Repo,                // E5.3
    pub commands: commands::Commands,          // E5.4
    pub sessions: sessions::Sessions,          // E5.6
    pub recovery: recovery::Recovery,          // E5.8
    pub transitions: transitions::Transitions, // E5.9
    pub liveness: liveness::Liveness,          // E5.10
    /// The steer-yield records E5.5's lane writes (E5.2's actor carries none).
    pub steering: crate::steering::Steering, // E5.5
    /// The engine this state belongs to, so the fold's collaborators reach the store without a
    /// trait signature change (E5.4a). A bare `State` in a unit test has none.
    pub(crate) engine: std::rc::Weak<Core>,
    /// Queue changes the fold staged: their rows are written, their events wait for the borrow
    /// to be released (E5.4a round 2).
    pub(crate) deferred_queue: Vec<crate::queue::write::StagedEvent>,
    /// Threads whose wake waits for the store to stop publishing history (E5.4f's `wake`).
    pub(crate) deferred_wakes: std::collections::HashSet<ThreadId>,
}

impl Default for State {
    fn default() -> State {
        State {
            limits: limits::EngineLimits::default(),
            registry: Registry::default(),
            workers: workers::WorkerSet::default(),
            lifecycle: Lifecycle::default(),
            flush_depth: 0,
            actors: actor::Actors::default(),
            live_flush: std::rc::Rc::new(std::cell::Cell::new(false)),
            repo: repository::Repo::default(),
            commands: commands::Commands,
            sessions: sessions::Sessions,
            recovery: recovery::Recovery::default(),
            transitions: transitions::Transitions,
            liveness: liveness::Liveness,
            steering: crate::steering::Steering::default(),
            engine: std::rc::Weak::new(),
            deferred_queue: Vec::new(),
            deferred_wakes: std::collections::HashSet::new(),
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
    pub(crate) fn any_ready_port(&self) -> bool {
        self.has_preferences
            || self.has_models
            || self.has_providers_activated
            || self.has_resolve_silence
    }
}

pub(crate) type ReadyFuture = Shared<oneshot::Receiver<Result<(), String>>>;

/// Raises `flush_depth` for one flush task's whole run (`index.ts:1411`). Dropping it restores
/// the depth, so a flush cancelled at shutdown cannot leave it raised.
pub struct FlushDepth(Rc<Core>);

impl FlushDepth {
    pub(crate) fn enter(core: &Rc<Core>) -> Result<FlushDepth, EngineError> {
        core.with_state(|state| state.flush_depth += 1)?;
        Ok(FlushDepth(Rc::clone(core)))
    }
}

impl Drop for FlushDepth {
    fn drop(&mut self) {
        let _ = self.0.with_state(|state| {
            state.flush_depth = state.flush_depth.saturating_sub(1);
        });
    }
}
