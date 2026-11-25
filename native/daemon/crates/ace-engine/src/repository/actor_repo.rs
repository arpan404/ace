// SPDX-License-Identifier: Apache-2.0
//! E5.3's side of E5.2's `ActorRepo` (`actor/deps.rs`): the methods the actor calls into the
//! repository, each mapped to the TypeScript line it replaces. Every other method keeps E5.2's
//! `Unported` answer, so an owner that lands later replaces only its own.
//!
//! The actor calls these with no `with_state` borrow held (E5.1 re-entrancy rule 2); each one
//! takes its own `State` borrow through [`Core::with_state`] and drops it before the next port.

use ace_json::Value;

use crate::actor::deps::{ActorRepo, Route, ScheduleView, Unported};
use crate::repository::collaborators::{InputFacts, MoveFacts};
use crate::repository::residency::text;
use crate::{Core, EngineError, State, ThreadId};

/// The production `ActorRepo`: the repository E5.3 ports, over the store's connection.
pub struct EngineRepo;

impl ActorRepo for EngineRepo {
    fn status(&self, core: &Core, thread: &ThreadId) -> Result<Value, EngineError> {
        core.with_state(|state| state.actor_status(&core.store, thread))?
    }

    fn route(&self, core: &Core, thread: &ThreadId) -> Result<Route, EngineError> {
        core.with_state(|state| state.actor_route(&core.store, thread))?
    }

    fn quiescent(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError> {
        core.with_state(|state| state.actor_quiescent(&core.store, thread))?
    }

    fn running_foreground_command(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<bool, EngineError> {
        core.with_state(|state| state.actor_running_foreground_command(&core.store, thread))?
    }

    fn stream(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: &[Value],
        now: f64,
    ) -> Result<bool, EngineError> {
        let json = ace_json::to_string(&Value::Array(facts.to_vec().into()));
        core.stream(thread, &json, now)
    }

    fn apply(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: &[Value],
        now: f64,
        generation: u64,
    ) -> Result<(), EngineError> {
        let json = ace_json::to_string(&Value::Array(facts.to_vec().into()));
        core.apply(thread, &json, now, Some(generation as f64))
    }

    fn deadline(
        &self,
        core: &Core,
        thread: &ThreadId,
        translator: Option<i64>,
    ) -> Result<Option<f64>, EngineError> {
        core.with_state(|state| state.actor_deadline(&core.store, thread, translator))?
    }

    fn schedule_view(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<ScheduleView>, EngineError> {
        core.with_state(|state| state.actor_schedule_view(&core.store, thread))?
    }

    fn evict(&self, core: &Core, thread: &ThreadId) {
        let _ = core.with_state(|state| state.repo.evict(&core.store, thread));
    }

    fn clear_incomplete_blobs(&self, core: &Core, thread: &ThreadId) {
        let _ = core.with_state(|state| state.clear_incomplete_blobs(&core.store, Some(thread)));
    }

    fn root_agent_id(&self, core: &Core, thread: &ThreadId) -> Result<Option<String>, EngineError> {
        core.with_state(|state| state.actor_root_agent_id(&core.store, thread))?
    }

    fn released_thread(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError> {
        core.with_state(|state| state.actor_released_thread(&core.store, thread))?
    }

    fn attachment(
        &self,
        core: &Core,
        thread: &ThreadId,
        hash: &str,
    ) -> Result<Option<Value>, EngineError> {
        let store = &core.store;
        let correlations = crate::frames::correlations::Correlations::on(store.conn());
        correlations.get(thread, hash)
    }

    // The rest stay E5.2's `Unported` answers until their owners land.
    fn engine_queue_fact(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<Value>, EngineError> {
        Unported.engine_queue_fact(core, thread)
    }

    fn queue_paused(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError> {
        Unported.queue_paused(core, thread)
    }

    fn queued_count(&self, core: &Core, thread: &ThreadId) -> Result<u64, EngineError> {
        Unported.queued_count(core, thread)
    }

    fn latest_generation(&self, core: &Core, thread: &ThreadId) -> Result<u64, EngineError> {
        Unported.latest_generation(core, thread)
    }

    fn mark_yielded_end(
        &self,
        core: &Core,
        thread: &ThreadId,
        facts: Vec<Value>,
    ) -> Result<Vec<Value>, EngineError> {
        Unported.mark_yielded_end(core, thread, facts)
    }

    fn session_instance(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<String>, EngineError> {
        Unported.session_instance(core, thread)
    }

    fn reserved_slot(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError> {
        Unported.reserved_slot(core, thread)
    }

    fn retiring_count(&self, core: &Core) -> Result<usize, EngineError> {
        Unported.retiring_count(core)
    }

    fn cursor_record(
        &self,
        core: &Core,
        thread: &ThreadId,
        entries: &[Value],
    ) -> Result<(), EngineError> {
        Unported.cursor_record(core, thread, entries)
    }
}

impl State {
    /// `repo.requireState(id).status` (`actor.ts:375`, `:400`), as the protocol's JSON.
    pub fn actor_status(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
    ) -> Result<Value, EngineError> {
        let snapshot = self.repo.require_state(store, id)?;
        let json = {
            let borrowed = snapshot.borrow();
            ace_json::ser::to_string(&borrowed.state.status)
                .map_err(|error| EngineError::Records(error.to_string()))?
        };
        ace_json::parse(&json).map_err(|error| EngineError::Records(error.to_string()))
    }

    /// `{ provider: requireState(id).config.provider, backend: repo.backend(id) }`
    /// (`actor.ts:371`-`:373`).
    pub fn actor_route(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
    ) -> Result<Route, EngineError> {
        let snapshot = self.repo.require_state(store, id)?;
        let provider = snapshot.borrow().state.config.provider.clone();
        let backend = self.backend(store, id)?;
        Ok(Route { provider, backend })
    }

    /// `repo.quiescent(requireState(id))` (`actor.ts:461`, `repository.ts:496`).
    pub fn actor_quiescent(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
    ) -> Result<bool, EngineError> {
        let snapshot = self.repo.require_state(store, id)?;
        // A first send the provider accepted but has not started yet is still live work.
        let has_run = snapshot.borrow().state.has_run;
        if !has_run && self.awaiting(id)? {
            return Ok(false);
        }
        let agents_ready = self.readiness_agents_ready(id)?;
        let view = snapshot.borrow_mut().quiescence_view()?;
        self.quiescent(&view, agents_ready)
    }

    /// `hasRunningForegroundCommand(requireState(id))` (`core/src/steering.ts:26`).
    pub fn actor_running_foreground_command(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
    ) -> Result<bool, EngineError> {
        let snapshot = self.repo.require_state(store, id)?;
        snapshot.borrow_mut().running_foreground_command()
    }

    /// `repo.apply` (`repository.ts:413`).
    pub fn actor_apply(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
        facts: &[Value],
        now: f64,
        generation: u64,
    ) -> Result<(), EngineError> {
        let json = ace_json::to_string(&Value::Array(facts.to_vec().into()));
        self.apply(store, id, &json, now, Some(generation as f64))
    }

    /// `repo.deadline` (`repository.ts:232`, `actor.ts:552`).
    pub fn actor_deadline(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
        translator: Option<i64>,
    ) -> Result<Option<f64>, EngineError> {
        let deadline = self.repo.deadline(store, id, translator)?;
        Ok(deadline.map(|deadline| deadline as f64))
    }

    /// `repo.state(id)` narrowed to what `schedule` reads (`actor.ts:537`-`:545`).
    pub fn actor_schedule_view(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
    ) -> Result<Option<ScheduleView>, EngineError> {
        let Some(snapshot) = self.repo.state(store, id)? else {
            return Ok(None);
        };
        let done = snapshot.borrow().is_done();
        let left_running = snapshot.borrow_mut().left_running()?;
        Ok(Some(ScheduleView { done, left_running }))
    }

    /// `rootAgent` (`index.ts:856`-`:859`): a prepared thread materializes its root with a tick.
    pub fn actor_root_agent_id(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
    ) -> Result<Option<String>, EngineError> {
        let snapshot = self.repo.require_state(store, id)?;
        let found = snapshot.borrow().root_agent_id();
        if found.is_some() {
            return Ok(found);
        }
        self.apply(store, id, "[{\"type\":\"tick\"}]", store.now(), None)?;
        let snapshot = self.repo.require_state(store, id)?;
        Ok(snapshot.borrow().root_agent_id())
    }

    /// `releasedThread(getThread(id))` (`provider-release.ts:18`): archived or settled.
    pub fn actor_released_thread(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
    ) -> Result<bool, EngineError> {
        const RELEASED: &str = "SELECT 1 AS released FROM threads WHERE id=? AND (archived_at IS NOT NULL OR json_extract(client,'$.settledAt') IS NOT NULL)";
        Ok(ace_store::stmt_cache::get_row(store.conn(), RELEASED, vec![text(id)])?.is_some())
    }
}
