// SPDX-License-Identifier: Apache-2.0
//! E5.3's side of E5.2's `ActorRepo` (`actor/deps.rs`): the methods the actor calls into the
//! repository, each mapped to the TypeScript line it replaces. Every other method keeps E5.2's
//! `Unported` answer, so an owner that lands later replaces only its own.
//!
//! The actor calls these with no `with_state` borrow held (E5.1 re-entrancy rule 2); each one
//! takes its own `State` borrow through [`Core::with_state`] and drops it before the next port.

use ace_json::Value;

use crate::actor::deps::{ActorRepo, Route, ScheduleView, Unported};
use crate::repository::collaborators::MoveFacts;
use crate::repository::residency::{cell_int, text};
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
        // No state borrow: the transaction's open can flush a pinned live batch for another
        // thread, which re-enters the engine. A failure is reported, never swallowed.
        if let Err(error) =
            crate::repository::reads::clear_incomplete_blobs_store(&core.store, Some(thread))
        {
            core.ports.report(error.to_string());
        }
    }

    fn root_agent_id(&self, core: &Core, thread: &ThreadId) -> Result<Option<String>, EngineError> {
        let found = core.with_state(|state| {
            state
                .repo
                .require_state(&core.store, thread)
                .map(|snapshot| snapshot.borrow().root_agent_id())
        })??;
        if found.is_some() {
            return Ok(found);
        }
        core.apply(thread, "[{\"type\":\"tick\"}]", core.store.now(), None)?;
        core.with_state(|state| {
            state
                .repo
                .require_state(&core.store, thread)
                .map(|snapshot| snapshot.borrow().root_agent_id())
        })?
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

    /// `engineQueueFact` (`repository.ts:586`): the retained work core does not know yet, or
    /// none when core already agrees. The count is the queue's own; the flags are the hold
    /// reasons that ask for a person rather than the agent.
    fn engine_queue_fact(
        &self,
        core: &Core,
        thread: &ThreadId,
    ) -> Result<Option<Value>, EngineError> {
        let count = self.queued_count(core, thread)? as i64;
        let conn = core.store.conn();
        let held = count > 0 && crate::queue::store::held_on_failed_send(conn, thread)?;
        let stopped = count > 0 && !held && crate::queue::store::stopped_by_person(conn, thread)?;
        let snapshot = core.with_state(|state| state.repo.state(&core.store, thread))??;
        if let Some(snapshot) = snapshot {
            let state = snapshot.borrow();
            if state.state.queue_sources.engine == count
                && state.state.queue_held.unwrap_or(false) == held
                && state.state.queue_stopped.unwrap_or(false) == stopped
            {
                return Ok(None);
            }
        }
        let mut fact = ace_json::Map::new();
        fact.insert("type", Value::from("queue.changed"));
        fact.insert("source", Value::from("engine"));
        fact.insert("count", Value::from(count));
        if held {
            fact.insert("held", Value::Bool(true));
        }
        if stopped {
            fact.insert("stopped", Value::Bool(true));
        }
        Ok(Some(Value::Object(fact)))
    }

    /// `repo.queue.get(id).paused` (`actor.ts:470`), with the missing-row defaults.
    fn queue_paused(&self, core: &Core, thread: &ThreadId) -> Result<bool, EngineError> {
        Ok(crate::queue::store::get(&core.store, thread)?.paused)
    }

    /// `repo.queuedCount` (`repository.ts:627`).
    fn queued_count(&self, core: &Core, thread: &ThreadId) -> Result<u64, EngineError> {
        let count = core.with_state(|state| state.queued_count(&core.store, thread))??;
        Ok(count.max(0) as u64)
    }

    /// The actor resumes after the latest generation from either ledger.
    fn latest_generation(&self, core: &Core, thread: &ThreadId) -> Result<u64, EngineError> {
        const REQUESTS: &str = "SELECT COALESCE(MAX(generation),0) AS generation FROM engine_interaction_requests WHERE thread_id=?";
        let conn = core.store.conn();
        let intents = crate::intents::store::latest_generation(conn, thread)?;
        let requests = ace_store::stmt_cache::get_row(conn, REQUESTS, vec![text(thread)])?
            .and_then(|row| row.get("generation").and_then(cell_int))
            .unwrap_or(0);
        Ok(intents.max(requests).max(0) as u64)
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
        core.with_state(|state| state.repo.reserved_slot(&core.store, thread))?
    }

    fn retiring_count(&self, core: &Core) -> Result<usize, EngineError> {
        core.with_state(|state| state.repo.retiring_count())
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

    /// `repo.quiescent(requireState(id))` (`actor.ts:461`, `repository.ts:496`). Transitions
    /// read the same rule, so a first send no run has started keeps both from closing a session.
    pub fn actor_quiescent(
        &mut self,
        store: &crate::EngineStore,
        id: &str,
    ) -> Result<bool, EngineError> {
        let snapshot = self.repo.require_state(store, id)?;
        // A first send the provider accepted but has not started yet is still live work.
        let has_run = snapshot.borrow().state.has_run;
        if !has_run && crate::intents::store::awaiting(store.conn(), id)?.is_some() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::actor::ActorDeps;
    use crate::executor::{Notified, Notifier};
    use crate::frames::live::UnportedLive;
    use crate::repository::testsupport::{Shell, header, home};
    use std::rc::Rc;

    struct ManualPump;

    impl Notifier for ManualPump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    #[test]
    fn the_actor_seed_uses_a_newer_interaction_generation() {
        let thread = "generation".to_owned();
        let conn = home(&thread, &header(&thread));
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,submitted_generation)
             VALUES ('send','generation','thread.send','{}','done',2);
             INSERT INTO engine_interaction_requests
             VALUES ('generation','request','native',NULL,'binding',5,'pending');",
        )
        .unwrap();
        let (_, shell) = Shell::store_with_controls(&conn);
        let engine = crate::Engine::new(
            shell.clone(),
            shell,
            crate::Inputs::default(),
            "[]",
            Box::new(ManualPump),
            &conn,
            Rc::new(ActorDeps::production(Rc::new(UnportedLive), 0.0)),
        )
        .unwrap();
        assert_eq!(
            EngineRepo
                .latest_generation(engine.core(), &thread)
                .unwrap(),
            5
        );
    }
}
