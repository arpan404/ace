// SPDX-License-Identifier: Apache-2.0
//! E5.3's `InputFacts`, implemented for 4a's methods: the intents and queue the fold reads
//! through `pending.*`, `queue.*`, `retireEndedTurnInputs` and `goalChange`. The trait is
//! declared in E5.3's `collaborators.rs`; this block replaces its empty `impl`.
//!
//! E5.3's probe runs a fold on a bare `State` with `probe_passthrough` set, where there is no
//! engine to reach the store through; those calls keep E5.3's pass-through answers.

use ace_json::Value;
use std::rc::Rc;

use crate::repository::collaborators::{InputFacts, PendingInfo, ProbeGate, QueueInfo};
use crate::{Core, EngineError, State};

impl State {
    /// The engine this state belongs to. `Ok(None)` is E5.3's probe on a bare `State`; a plain
    /// `State` with no probe fails at the call.
    fn engine(&self) -> Result<Option<Rc<Core>>, EngineError> {
        if let Some(core) = self.engine.upgrade() {
            return Ok(Some(core));
        }
        if self.repo.probe_passthrough {
            return Ok(None);
        }
        Err(EngineError::not_ported("the engine's store", "E5.4a"))
    }

    fn pending_info(header: crate::intents::IntentHeader) -> PendingInfo {
        let continuation = matches!(
            header.kind.as_str(),
            "thread.resume" | "queue.resume" | "thread.limit"
        );
        PendingInfo {
            id: header.id,
            command_id: header.command_id,
            continuation,
        }
    }
}

impl InputFacts for State {
    /// `pending.handedOver` (`intents.ts:325`).
    fn handed_over(&mut self, thread: &str) -> Result<Option<PendingInfo>, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(None);
        };
        Ok(crate::intents::store::handed_over(core.store.conn(), thread)?.map(State::pending_info))
    }

    /// `pending.uncertainContinuation` (`:176`).
    fn uncertain_continuation(&mut self, thread: &str) -> Result<Option<PendingInfo>, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(None);
        };
        Ok(
            crate::intents::store::uncertain_continuation(core.store.conn(), thread)?
                .map(State::pending_info),
        )
    }

    /// `pending.resolvingInteractions` (`:344`).
    fn resolving_interactions(&mut self, thread: &str) -> Result<Vec<String>, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(Vec::new());
        };
        crate::intents::query::resolving_interactions(core.store.conn(), thread)
    }

    /// `pending.finishContinuation` (`:182`).
    fn finish_continuation(&mut self, thread: &str) -> Result<(), EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(());
        };
        crate::intents::store::finish_continuation(core.store.conn(), thread)
    }

    /// `pending.awaiting` (`:315`).
    fn awaiting(&mut self, thread: &str) -> Result<bool, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(false);
        };
        Ok(crate::intents::store::awaiting(core.store.conn(), thread)?.is_some())
    }

    /// `queue.get` (`queue-store.ts:117`).
    fn queue_get(&mut self, thread: &str) -> Result<QueueInfo, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(QueueInfo::default());
        };
        Ok(crate::queue::store::get(&core.store, thread)?.info())
    }

    /// `queue.set` (`:141`).
    fn queue_set(&mut self, thread: &str, json: &str, at: f64) -> Result<(), EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(());
        };
        // The row now, its events after the fold releases the borrow (E5.4a round 2).
        let staged = crate::queue::write::stage(&core.store, thread, json, at)?;
        self.deferred_queue.push(staged);
        Ok(())
    }

    /// `queue.prune` (`:351`).
    fn queue_prune(&mut self, id: i64) -> Result<(), EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(());
        };
        crate::queue::messages::prune(core.store.conn(), id)
    }

    /// `queue.hasUncertain` (`:237`).
    fn queue_has_uncertain(&mut self, thread: &str) -> Result<bool, EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(false);
        };
        crate::queue::store::has_uncertain(core.store.conn(), thread)
    }

    /// `retireEndedTurnInputs` (`stale-inputs.ts:23`).
    fn retire_ended_turn_inputs(
        &mut self,
        thread: &str,
        generation: f64,
        now: f64,
    ) -> Result<(), EngineError> {
        let Some(core) = self.engine()? else {
            return Ok(());
        };
        let staged = crate::queue::stale::retire_ended_turn_inputs(
            &core.store,
            thread,
            generation as i64,
            now,
        )?;
        self.deferred_queue.extend(staged);
        Ok(())
    }

    /// 4b's: the input journal and correlation. 4a leaves E5.3's probe pass-through in place.
    /// `inputs.correlate` (`input-journal.ts:224`). `None` drops the fact.
    fn correlate(
        &mut self,
        thread: &str,
        fact: Value,
        generation: Option<f64>,
    ) -> Result<Option<Value>, EngineError> {
        self.correlate_with(thread, fact, None, generation)
    }

    /// `inputs.keyFor` (`:157`).
    fn input_key_for(
        &mut self,
        thread: &str,
        native_input_id: &str,
    ) -> Result<Option<String>, EngineError> {
        self.input_key_for_with(thread, native_input_id)
    }

    /// `aceInputs.attribute` (`ace-inputs.ts:31`).
    fn attribute_input(&mut self, thread: &str, fact: Value) -> Result<Value, EngineError> {
        self.attribute_input_with(thread, fact)
    }

    /// `aceWaitFact` (`ace-waits.ts:10`).
    fn ace_wait_fact(&mut self, thread: &str, fact: &Value) -> Result<Option<Value>, EngineError> {
        self.ace_wait_fact_with(thread, fact)
    }

    /// `bindConsumedInput` (`transcript-inputs.ts:176`): the generation is the session's own.
    fn bind_consumed_input(
        &mut self,
        thread: &str,
        key: &str,
        generation: Option<f64>,
        now: f64,
    ) -> Result<Vec<Value>, EngineError> {
        self.bind_consumed_input_with(thread, key, generation, now)
    }

    /// `bindStartedRun` (`transcript-inputs.ts:157`).
    fn bind_started_run(
        &mut self,
        thread: &str,
        run: &str,
        generation: Option<f64>,
    ) -> Result<Vec<Value>, EngineError> {
        self.bind_started_run_with(thread, run, generation)
    }

    /// E5.5's `root-run-start.ts`.
    fn root_run_start(
        &mut self,
        trigger: &str,
        _handed: Option<&PendingInfo>,
    ) -> Result<(String, bool), EngineError> {
        self.not_ported("a root run start", "E5.5", (trigger.to_owned(), true))
    }

    /// `goalChange` (`goal-change.ts:14`).
    fn goal_change(
        &mut self,
        current: Option<&Value>,
        goal: Option<&Value>,
    ) -> Result<Option<Value>, EngineError> {
        Ok(match crate::rules::goal_change(current, goal) {
            crate::rules::GoalChange::Unchanged => None,
            crate::rules::GoalChange::Clear => Some(Value::Null),
            crate::rules::GoalChange::Set(goal) => Some(goal),
        })
    }
}
