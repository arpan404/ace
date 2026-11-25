// SPDX-License-Identifier: Apache-2.0
//! The engine's shared state: plain data, so no port lives in a `with_state` closure.

use crate::Core;
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
    /// The probe's one stub (E5.1): the recovery-candidate scan answers with no rows so
    /// `ready()` can resolve before E5.3 lands. E5.3 deletes it.
    pub probe_empty_candidates: bool,
    pub actors: actor::Actors, // E5.2
    /// A live-buffer flush task is queued on the pump (E5.2 step 16): the coalescing flag.
    pub live_flush: std::rc::Rc<std::cell::Cell<bool>>,
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
            actors: actor::Actors::default(),
            live_flush: std::rc::Rc::new(std::cell::Cell::new(false)),
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
