// SPDX-License-Identifier: Apache-2.0
//! E5.3's `InputFacts`, implemented for 4a's methods: the intents and queue the fold reads
//! through `pending.*`, `queue.*`, `retireEndedTurnInputs` and `goalChange`. The trait is
//! declared in E5.3's `collaborators.rs`; this block replaces its empty `impl`.
//!
//! E5.3's probe runs a fold on a bare `State` with `probe_passthrough` set, where there is no
//! engine to reach the store through; those calls keep E5.3's pass-through answers.

use ace_json::Value;
use std::rc::Rc;

use crate::repository::collaborators::{InputFacts, PendingInfo, QueueInfo};
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

    /// E5.5's `root-run-start.ts`: the handed-over intent's own kind and trigger come from its
    /// stored row, since `PendingInfo` carries only what the fold needs elsewhere.
    fn root_run_start(
        &mut self,
        trigger: &str,
        handed: Option<&PendingInfo>,
    ) -> Result<(String, bool), EngineError> {
        let handed = match (handed, self.engine()?) {
            (Some(handed), Some(core)) => {
                const SQL: &str = "SELECT kind, trigger FROM intents WHERE id=?";
                let row = ace_store::stmt_cache::get_row(
                    core.store.conn(),
                    SQL,
                    vec![ace_store::Value::Integer(handed.id)],
                )?;
                row.map(|row| crate::delivery::root_run_start::HandedOver {
                    kind: row
                        .get("kind")
                        .and_then(crate::repository::residency::cell_text)
                        .unwrap_or_default()
                        .to_owned(),
                    trigger: row
                        .get("trigger")
                        .and_then(crate::repository::residency::cell_text)
                        .map(str::to_owned),
                })
            }
            _ => None,
        };
        let answer = crate::delivery::root_run_start::root_run_start(trigger, handed.as_ref());
        Ok((answer.trigger, answer.takes_input))
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

#[cfg(test)]
mod tests {
    use crate::executor::{Notified, Notifier};
    use crate::repository::testsupport::{Shell, home};
    use ace_json::Value;

    struct Pump;

    impl Notifier for Pump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    /// A stored home whose root agent is `agent-root`, written the way the TypeScript engine
    /// leaves one: the header, and the index section that names the agent's key.
    fn home_with_root() -> std::sync::Arc<ace_store::Connection> {
        let header = r#"{"engineSnapshot":9,"threadId":"t","config":{"provider":"codex","silenceMs":1000},"rootKey":"root","agents":{"root":{"agent":{"id":"agent-root","threadId":"t","parentId":null,"origin":"person","native":{"provider":"codex","nativeId":"native-root"},"status":{"state":"idle"},"fidelity":"full","cwd":"/tmp","background":false,"createdAt":1},"activity":"idle","lastSignalAt":1}},"runs":{},"items":{},"interactions":{},"tasks":{},"interactionHistory":{},"taskHistory":{},"indexes":{"liveTools":{},"pendingInteractions":{},"runningTasks":{},"agentKeysById":{},"childrenByParent":{},"pendingSpawnLinks":{},"pendingItemLinks":{}},"outcomeOrder":0,"pendingNotices":[],"itemLinks":{},"queueCount":0,"queueSources":{"engine":0,"provider":0},"hasRun":false,"status":{"state":"new"}}"#;
        let conn = home("t", header);
        conn.exec(
            "INSERT INTO engine_state_records VALUES ('t', 'agentKeysById', 'agent-root', '\"root\"')",
        )
        .unwrap();
        conn.exec("INSERT INTO engine_queue (thread_id) VALUES ('t')")
            .unwrap();
        conn
    }

    /// A send the engine handed the provider, with the trigger it was admitted under.
    fn handed_over(conn: &std::sync::Arc<ace_store::Connection>, trigger: Option<&str>) {
        let trigger = trigger
            .map(|trigger| format!("'{trigger}'"))
            .unwrap_or_else(|| "NULL".to_owned());
        conn.exec(&format!(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,attempts,awaiting,ack_target,delivery,trigger,submitted_generation) \
             VALUES ('send','t','thread.send','{{\"id\":\"send\",\"deviceId\":\"device\",\"payload\":{{\"type\":\"thread.send\",\"threadId\":\"t\",\"input\":[{{\"type\":\"text\",\"text\":\"hello\"}}]}}}}','running',0,1,1,'queue',{trigger},1)"
        ))
        .unwrap();
    }

    fn engine_on(conn: &std::sync::Arc<ace_store::Connection>) -> crate::Engine {
        let (_, shell) = Shell::store_with_controls(conn);
        crate::Engine::new(
            shell.clone(),
            shell,
            crate::Inputs::default(),
            "[]",
            Box::new(Pump),
            conn,
            std::rc::Rc::new(crate::actor::ActorDeps::production(
                std::rc::Rc::new(crate::frames::live::UnportedLive),
                0.0,
            )),
        )
        .expect("engine")
    }

    /// Applies one `turn.started` fact and returns the engine.
    fn start_run(conn: &std::sync::Arc<ace_store::Connection>, trigger: &str) -> crate::Engine {
        let engine = engine_on(conn);
        let core = engine.core();
        core.with_state(|state| state.repo.probe_passthrough = true)
            .unwrap();
        let facts = format!(
            r#"[{{"type":"turn.started","agent":"root","trigger":"{trigger}","nativeTurnId":"turn-1"}}]"#
        );
        core.with_state(|state| state.apply(&core.store, "t", &facts, 1_000.0, Some(1.0)))
            .unwrap()
            .unwrap();
        engine
    }

    fn run_trigger(engine: &crate::Engine) -> Option<String> {
        let core = engine.core();
        let snapshot = core
            .with_state(|state| state.repo.require_state(&core.store, "t"))
            .unwrap()
            .unwrap();
        snapshot
            .borrow()
            .state
            .runs
            .values()
            .next()
            .map(|run| run.trigger.clone())
    }

    fn intent(conn: &std::sync::Arc<ace_store::Connection>) -> (bool, bool) {
        let row = ace_store::stmt_cache::get_row(
            conn,
            "SELECT awaiting, acknowledged FROM intents WHERE command_id='send'",
            Vec::new(),
        )
        .unwrap()
        .expect("the intent");
        let int = |key: &str| {
            row.get(key)
                .and_then(crate::repository::residency::cell_int)
                == Some(1)
        };
        (int("awaiting"), int("acknowledged"))
    }

    #[test]
    fn a_given_input_run_takes_the_handed_over_notice_and_carries_its_trigger() {
        let conn = home_with_root();
        handed_over(&conn, Some("background_completion"));
        let engine = start_run(&conn, "user");
        // The root run records the notice's own trigger, not the provider's "user".
        assert_eq!(
            run_trigger(&engine).as_deref(),
            Some("background_completion")
        );
        // And its start takes the input: the provider has it.
        let (awaiting, acknowledged) = intent(&conn);
        assert!(!awaiting, "the input is no longer awaiting");
        assert!(acknowledged, "the input is acknowledged");
    }

    #[test]
    fn a_providers_own_wake_takes_nothing_and_the_input_stays_handed_over() {
        let conn = home_with_root();
        handed_over(&conn, Some("background_completion"));
        let engine = start_run(&conn, "subagent_result");
        // The provider woke for its own reason: the trigger is kept as it reported it.
        assert_eq!(run_trigger(&engine).as_deref(), Some("subagent_result"));
        let (awaiting, acknowledged) = intent(&conn);
        assert!(awaiting, "the input still waits for its run");
        assert!(!acknowledged);
    }

    #[test]
    fn a_persons_message_with_no_trigger_of_its_own_keeps_the_runs_trigger() {
        let conn = home_with_root();
        handed_over(&conn, None);
        let engine = start_run(&conn, "user");
        assert_eq!(run_trigger(&engine).as_deref(), Some("user"));
        let (awaiting, acknowledged) = intent(&conn);
        assert!(!awaiting);
        assert!(acknowledged);
        let _ = value("{}");
    }
}
