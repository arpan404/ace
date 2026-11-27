// SPDX-License-Identifier: Apache-2.0
//! The fold's persistence frame (E5.3 step 7, `provider-facts.ts:32`-`:328`): the snapshot's
//! `begin`, the `FactBatch` over `ace-core` with the snapshot's deadline, the per-fact
//! corrections, the batch's apply and flush, the failed-status shaping, the admission and
//! acknowledgement block, the queue updates, the deadlines, then `save`. Every step stays in
//! the TypeScript's order. Calls into modules other items own go through the collaborator traits.

use ace_core::reduce::FactBatch;
use ace_core::state::{ApplyContext, IdSource};
use ace_json::Value;
use std::collections::HashMap;

use crate::repository::apply::{FoldedFrame, ended_root_run};
use crate::repository::collaborators::{
    AccessFacts, FrameFacts, InputFacts, MoveFacts, SessionFacts,
};
use crate::{EngineError, EngineStore, State};

mod helpers;
mod hydrate;
mod run_trigger;
mod settle;

use helpers::{events_of, needs_shaping, text_carrier};
pub(super) use helpers::{kind, set, text_field};

pub(crate) struct StoreIds<'a>(&'a EngineStore);

/// The id service a fold allocates through.
pub(crate) fn store_ids(store: &EngineStore) -> StoreIds<'_> {
    StoreIds(store)
}

impl IdSource for StoreIds<'_> {
    fn next(&mut self, kind: &str) -> Option<String> {
        Some(self.0.next_id(kind))
    }
}

impl State {
    /// `foldProviderFacts` (`provider-facts.ts:32`).
    pub(crate) fn fold_frame(
        &mut self,
        store: &EngineStore,
        id: &str,
        facts_json: &str,
        now: f64,
        generation: Option<f64>,
    ) -> Result<FoldedFrame, EngineError> {
        let snapshot = self.repo.require_state(store, id)?;
        snapshot.borrow_mut().begin()?;
        let deadline = snapshot.borrow_mut().deadline(None);
        let mut batch = FactBatch::new(Some(deadline));
        let opening = self.repo.opening.contains(id);
        let root = self.root_key(&snapshot);
        let facts = Self::facts(facts_json)?;
        let facts = self.coalesce_facts(facts)?;
        self.hydrate_facts(&snapshot, &facts)?;
        let replayed = if opening {
            self.fork_replay_source(id)?
        } else {
            None
        };
        let mut continuation_started = false;
        let mut takes_input: HashMap<String, bool> = HashMap::new();
        let mut emitted: Vec<Value> = Vec::new();
        let process_started = facts.iter().any(|fact| kind(fact) == "process.started");
        for input in facts {
            if self.interactions_obsolete(id, &input)? {
                continue;
            }
            let input = match &replayed {
                Some(source) => {
                    let state = snapshot.borrow();
                    self.inherited_replay(input, source, &state.state)?
                }
                None => input,
            };
            // The provider's title and goal corrections call the store through ports, not a
            // collaborator (`provider-facts.ts:51`-`:76`).
            if self.title_correction(store, id, &root, &input, now)? {
                continue;
            }
            if self.goal_correction(store, id, &root, &input, now)? {
                continue;
            }
            // `provider-facts.ts:78`-`:85`: an echoed native input binds its transcript item to
            // the run that consumed it. A reopen replays the stored transcript and never rebinds.
            if kind(&input) == "input.consumed" {
                if opening || text_field(&input, "agent") != Some(root.as_str()) {
                    continue;
                }
                let native_ids: Vec<String> = match input.get("nativeInputIds") {
                    Some(Value::Array(ids)) => ids
                        .iter()
                        .filter_map(|id| id.as_str().map(str::to_owned))
                        .collect(),
                    _ => Vec::new(),
                };
                for native_id in native_ids {
                    if let Some(key) = self.input_key_for(id, &native_id)? {
                        // The binding's payloads are events, not facts: they name the item's new
                        // run for the clients and mark the record the save persists.
                        emitted.extend(self.bind_consumed_input(id, &key, generation, now)?);
                    }
                }
                continue;
            }
            let queue = if kind(&input) == "turn.started" {
                Some(self.queue_get(id)?)
            } else {
                None
            };
            let mut input = input;
            if kind(&input) == "turn.started"
                && text_field(&input, "agent") == Some(root.as_str())
                && let Some(trigger) = queue.as_ref().and_then(|queue| queue.trigger.clone())
                && self.handed_over(id)?.is_some()
            {
                set(&mut input, "trigger", Value::from(trigger.as_str()));
            }
            if opening
                && kind(&input) == "item.upsert"
                && input
                    .get("draft")
                    .and_then(|draft| draft.get("type"))
                    .and_then(Value::as_str)
                    == Some("tool_call")
            {
                set(&mut input, "type", Value::from("item.reconciled"));
            }
            let echo_generation = if opening { None } else { generation };
            let Some(correlated) = self.correlate(id, input, echo_generation)? else {
                continue;
            };
            let attributed = self.attribute_input(id, correlated)?;
            let mut fact = self.attribute_ace_action(id, attributed)?;
            if needs_shaping(&fact) {
                let model = self.session(store, id)?.model;
                let state = snapshot.borrow();
                fact = self.shape_provider_error(
                    fact,
                    &state.state.config.provider,
                    model.as_deref(),
                )?;
            }
            let fact_item = text_field(&fact, "item").map(str::to_owned);
            let previous_call = fact_item.as_deref().and_then(|item| {
                match snapshot.borrow().state.items.get(item) {
                    Some(ace_core::items::Item::ToolCall { call, .. }) => Some(call.clone()),
                    _ => None,
                }
            });
            fact = self.cap_fact(store, id, fact, previous_call.as_ref())?;
            let mut start_takes_input = None;
            if kind(&fact) == "turn.started" && text_field(&fact, "agent") == Some(root.as_str()) {
                let trigger = text_field(&fact, "trigger").unwrap_or_default().to_owned();
                let handed = self.handed_over(id)?;
                let (trigger, takes) = self.root_run_start(&trigger, handed.as_ref())?;
                set(&mut fact, "trigger", Value::from(trigger.as_str()));
                start_takes_input = Some(takes);
            }
            if kind(&fact) == "turn.ended" && text_field(&fact, "agent") == Some(root.as_str()) {
                let trigger = self.root_turn_trigger(&snapshot, &fact);
                if let Some(trigger) = trigger {
                    set(&mut fact, "trigger", Value::from(trigger.as_str()));
                }
            }
            let item = text_field(&fact, "item").unwrap_or_default().to_owned();
            let field = text_field(&fact, "field").unwrap_or_default().to_owned();
            let delta = kind(&fact) == "item.delta";
            if delta {
                snapshot.borrow_mut().prepare(&item, &field)?;
            }
            let mut events: Vec<Value>;
            {
                let mut ids = StoreIds(store);
                let resolving = if kind(&fact) == "turn.ended" {
                    Some(self.resolving_interactions(id)?)
                } else {
                    None
                };
                let mut context = ApplyContext {
                    now: now as i64,
                    ids: &mut ids,
                    resolving_interactions: resolving.map(|list| list.into_iter().collect()),
                };
                let owned = fact.clone();
                let mut core_events = Vec::new();
                let applied = {
                    let mut borrowed = snapshot.borrow_mut();
                    batch.apply(&mut borrowed.state, &owned, &mut context, &mut core_events)
                };
                if applied.is_none() {
                    return Err(EngineError::InvalidRecord);
                }
                events = events_of(&core_events);
            }
            if let Some(waiting) = self.ace_wait_fact(id, &fact)? {
                let mut ids = StoreIds(store);
                let mut context = ApplyContext {
                    now: now as i64,
                    ids: &mut ids,
                    resolving_interactions: None,
                };
                let mut core_events = Vec::new();
                let mut borrowed = snapshot.borrow_mut();
                batch.apply(
                    &mut borrowed.state,
                    &waiting.clone(),
                    &mut context,
                    &mut core_events,
                );
                events.extend(events_of(&core_events));
            }
            self.interactions_opened(id, &fact, generation)?;
            self.settle_interactions(store, id, &snapshot, &mut batch, &mut events, now)?;
            self.interactions_observe(id, &events)?;
            if observes_meters(process_started, &events) {
                let instance = crate::sessions::metadata::session(store, id)
                    .ok()
                    .and_then(|metadata| metadata.instance_id);
                self.observe_context(
                    store,
                    id,
                    process_started,
                    &events,
                    now,
                    instance.as_deref(),
                )?;
            }
            if let Some(takes) = start_takes_input {
                for event in &events {
                    if kind(event) == "run.started"
                        && let Some(run) = event
                            .get("run")
                            .and_then(|run| run.get("id"))
                            .and_then(Value::as_str)
                    {
                        takes_input.insert(run.to_owned(), takes);
                    }
                }
            }
            if kind(&fact) == "turn.ended"
                && let Some(error) = fact.get("error").cloned()
            {
                for event in events.iter_mut() {
                    if kind(event) == "run.ended" {
                        set(event, "error", error.clone());
                        if let Some(run_id) = text_field(event, "runId") {
                            let mut borrowed = snapshot.borrow_mut();
                            if let Some(run) = borrowed.state.runs.get_mut(run_id) {
                                run.error = ace_json::from_value(&error).ok();
                            }
                        }
                    }
                }
            }
            if kind(&fact) == "turn.started"
                && matches!(
                    text_field(&fact, "trigger"),
                    Some("restart") | Some("limit_resume")
                )
                && events.iter().any(|event| kind(event) == "run.started")
            {
                continuation_started = true;
            }
            if delta
                && events.iter().any(|event| kind(event) == "item.delta")
                && let Some(append) = text_carrier(&fact, "append")
            {
                snapshot.borrow_mut().delta(&item, &append, true)?;
            }
            snapshot
                .borrow_mut()
                .remember(kind(&fact), &item, &events)?;
            if delta {
                snapshot.borrow_mut().finish_prepare(&item);
            }
            if kind(&fact) == "tick" {
                // The hook reads the snapshot's records: release the fold's borrow first.
                let thread = snapshot.borrow().state.thread_id.clone();
                self.refresh_blocked_now(&thread, now as i64)?;
            }
            emitted.extend(events);
        }
        {
            let mut borrowed = snapshot.borrow_mut();
            let flushed = batch.flush(&mut borrowed.state);
            emitted.extend(events_of(&flushed));
        }
        self.shape_failed_statuses(&snapshot, &mut emitted)?;
        self.admission_block(
            store,
            id,
            &snapshot,
            &root,
            &mut emitted,
            &takes_input,
            opening,
            generation,
            continuation_started,
            now,
        )?;
        if continuation_started && self.queue_get(id)?.trigger.is_some() {
            self.queue_set(id, "{\"continuation\":null,\"trigger\":null}", now)?;
            self.finish_continuation(id)?;
        }
        if let Some(generation) = generation
            && !opening
            && ended_root_run(&snapshot.borrow().state, &root, &emitted)
        {
            self.retire_ended_turn_inputs(id, generation, now)?;
        }
        let raw_facts = Self::facts(facts_json)?;
        snapshot
            .borrow_mut()
            .update_deadlines(&raw_facts, &emitted, now as i64);
        Ok(FoldedFrame::new(snapshot, raw_facts, emitted))
    }
}

/// Whether a batch can move a context meter (`index.ts:381`-`:396`).
fn observes_meters(process_started: bool, events: &[Value]) -> bool {
    process_started
        || events.iter().any(|event| {
            matches!(
                kind(event),
                "usage.updated" | "context.sampled" | "agent.updated"
            ) || matches!(kind(event), "item.created" | "item.updated")
                && event
                    .get("item")
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    == Some("compaction")
                || kind(event) == "agent.status"
                    && event.get("status").is_some_and(|status| {
                        status.get("state").and_then(Value::as_str) == Some("working")
                            && status.get("activity").and_then(Value::as_str) == Some("compacting")
                    })
        })
}

#[cfg(test)]
mod tests {
    use crate::actor::ActorDeps;
    use crate::executor::{Notified, Notifier};
    use crate::frames::live::UnportedLive;
    use crate::repository::testsupport::{Shell, header, home};
    use crate::{Engine, Inputs};
    use std::rc::Rc;
    use std::sync::Arc;

    struct ManualPump;

    impl Notifier for ManualPump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    fn engine(conn: &Arc<ace_store::Connection>) -> Engine {
        let (_, shell) = Shell::store_with_controls(conn);
        Engine::new(
            shell.clone(),
            shell,
            Inputs::default(),
            "[]",
            Box::new(ManualPump),
            conn,
            Rc::new(ActorDeps::production(Rc::new(UnportedLive), 0.0)),
        )
        .expect("the test engine constructs")
    }

    /// The root agent's id and its active run, after a turn started.
    fn root_agent(engine: &Engine, thread: &str) -> (String, String) {
        engine
            .core()
            .with_state(|state| {
                let snapshot = state
                    .repo
                    .require_state(&engine.core().store, thread)
                    .expect("the resident snapshot");
                let borrowed = snapshot.borrow();
                let record = &borrowed.state.agents["root"];
                (
                    record.agent.id.clone(),
                    record.active_run.clone().expect("the turn started a run"),
                )
            })
            .expect("the state is free")
    }

    /// A thread whose root has an active run: the E5.5 call a root turn start reaches is still
    /// unported, so the probe scaffolding answers it. The journal rows are written afterwards,
    /// so the turn start's `bindStartedRun` does not take the input first.
    fn started_engine(thread: &str) -> (Arc<ace_store::Connection>, Engine) {
        let conn = home(thread, &header(thread));
        let engine = engine(&conn);
        engine
            .core()
            .with_state(|state| state.repo.probe_passthrough = true)
            .expect("the state is free");
        engine
            .core()
            .apply(
                thread,
                r#"[{"type":"turn.started","agent":"root","trigger":"user","nativeTurnId":"turn-1"}]"#,
                1.0,
                None,
            )
            .expect("the turn starts");
        (conn, engine)
    }

    /// The transcript's input message and its journal rows: a native id names it, and the
    /// session was handed it with no run yet.
    fn seed_input(conn: &Arc<ace_store::Connection>, thread: &str, agent: &str) {
        conn.exec(&format!(
            r#"INSERT INTO engine_state_records VALUES ('{thread}','items','input:send',
                 '{{"id":"m1","threadId":"{thread}","agentId":"{agent}","createdAt":1,"complete":true,"type":"message","role":"user","parts":[{{"type":"text","text":"q"}}]}}');
               INSERT INTO engine_input_identities VALUES ('{thread}','native:send','send');
               INSERT INTO engine_inputs VALUES (1,'{thread}','input:send','sig','{{"kind":"person"}}',1,0,NULL,NULL);"#
        ))
        .expect("the input's rows");
    }

    fn echo(engine: &Engine, thread: &str) {
        engine
            .core()
            .apply(
                thread,
                r#"[{"type":"input.consumed","agent":"root","nativeInputIds":["native:send"]}]"#,
                2.0,
                None,
            )
            .expect("the echo folds");
    }

    fn stored_input_run(conn: &Arc<ace_store::Connection>, thread: &str) -> Option<String> {
        let row = ace_store::stmt_cache::get_row(
            conn,
            "SELECT run_id FROM engine_inputs WHERE thread_id=? AND item_key='input:send'",
            vec![ace_store::Value::Text(thread.to_owned())],
        )
        .expect("the journal row")
        .expect("the input's row");
        match row.get("run_id") {
            Some(ace_store::Value::Text(run)) => Some(run.clone()),
            _ => None,
        }
    }

    fn stored_item(conn: &Arc<ace_store::Connection>, thread: &str) -> String {
        let row = ace_store::stmt_cache::get_row(
            conn,
            "SELECT value FROM engine_state_records WHERE thread_id=? AND section='items' AND key='input:send'",
            vec![ace_store::Value::Text(thread.to_owned())],
        )
        .expect("the item's row")
        .expect("the stored item");
        match row.get("value") {
            Some(ace_store::Value::Text(json)) => json.clone(),
            other => panic!("expected the item's JSON, got {other:?}"),
        }
    }

    #[test]
    fn an_echoed_input_binds_its_message_to_the_run_that_consumed_it() {
        let thread = "consumed";
        let (conn, engine) = started_engine(thread);
        let (agent, run) = root_agent(&engine, thread);
        seed_input(&conn, thread, &agent);
        echo(&engine, thread);
        assert_eq!(stored_input_run(&conn, thread), Some(run.clone()));
        assert!(
            stored_item(&conn, thread).contains(&format!(r#""runId":"{run}""#)),
            "{}",
            stored_item(&conn, thread)
        );
    }

    #[test]
    fn a_reopen_replays_a_consumed_input_without_rebinding_it() {
        let thread = "reopened";
        let (conn, engine) = started_engine(thread);
        let (agent, _) = root_agent(&engine, thread);
        seed_input(&conn, thread, &agent);
        engine
            .core()
            .with_state(|state| state.repo.opening.insert(thread.to_owned()))
            .expect("the state is free");
        echo(&engine, thread);
        assert_eq!(stored_input_run(&conn, thread), None);
        assert!(!stored_item(&conn, thread).contains("runId"));
    }
}
