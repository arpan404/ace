// SPDX-License-Identifier: Apache-2.0
//! The fold's persistence frame (E5.3 step 7, `provider-facts.ts:32`-`:328`): the snapshot's
//! `begin`, the `FactBatch` over `ace-core` with the snapshot's deadline, the per-fact
//! corrections, the batch's apply and flush, the failed-status shaping, the admission and
//! acknowledgement block, the queue updates, the deadlines, then `save`. Every step stays in
//! the TypeScript's order. Calls into modules other items own go through the collaborator traits.

use ace_core::reduce::FactBatch;
use ace_core::state::{ApplyContext, IdSource};
use ace_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use crate::repository::collaborators::{
    AccessFacts, FrameFacts, InputFacts, MoveFacts, SessionFacts,
};
use crate::snapshot::Snapshot;
use crate::{EngineError, EngineStore, State};

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

pub(super) fn kind(value: &Value) -> &str {
    value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default()
}

pub(super) fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Text as JSON carries it, a lone surrogate included (`JsString::to_rust`).
pub(super) fn text_carrier(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(text)) => Some(text.to_rust().into_owned()),
        _ => None,
    }
}

impl State {
    fn root_key(&self, snapshot: &Rc<RefCell<Snapshot>>) -> String {
        snapshot
            .borrow()
            .state
            .root_key
            .clone()
            .unwrap_or_else(|| "root".to_owned())
    }

    /// `foldProviderFacts` (`provider-facts.ts:32`).
    pub(crate) fn fold_frame(
        &mut self,
        store: &EngineStore,
        id: &str,
        snapshot: &Rc<RefCell<Snapshot>>,
        facts_json: &str,
        now: f64,
        generation: Option<f64>,
    ) -> Result<(), EngineError> {
        snapshot.borrow_mut().begin();
        let deadline = snapshot.borrow_mut().deadline(None);
        let mut batch = FactBatch::new(Some(deadline));
        let opening = self.repo.opening.contains(id);
        let root = self.root_key(snapshot);
        let facts = Self::facts(facts_json)?;
        let facts = self.coalesce_facts(facts)?;
        {
            // The lazy sections are the one record cache: load what this batch names so the
            // core folds onto the stored records, then hand the changes back in `save`.
            let named = crate::snapshot::touched::Touched::values(&facts, &[]);
            snapshot.borrow_mut().hydrate(&named)?;
        }
        let replayed = if opening {
            self.fork_replay_source(id)?
        } else {
            None
        };
        let mut continuation_started = false;
        let mut takes_input: HashMap<String, bool> = HashMap::new();
        let mut emitted: Vec<Value> = Vec::new();
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
            let Some(correlated) = self.correlate(id, input)? else {
                continue;
            };
            let attributed = self.attribute_input(id, correlated)?;
            let mut fact = self.attribute_ace_action(id, attributed)?;
            if needs_shaping(&fact) {
                let model = self.session(id)?.model;
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
                let trigger = self.root_turn_trigger(snapshot, &fact);
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
            for event in events.clone() {
                if kind(&event) == "interaction.closed" {
                    let settled = self.interactions_closed(&event)?;
                    let mut ids = StoreIds(store);
                    let mut context = ApplyContext {
                        now: now as i64,
                        ids: &mut ids,
                        resolving_interactions: None,
                    };
                    let mut core_events = Vec::new();
                    let mut borrowed = snapshot.borrow_mut();
                    for fact in settled {
                        batch.apply(&mut borrowed.state, &fact, &mut context, &mut core_events);
                    }
                    events.extend(events_of(&core_events));
                }
            }
            self.interactions_observe(id, &events)?;
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
                let state = snapshot.borrow();
                self.readiness_refresh_blocked(&state.state)?;
            }
            emitted.extend(events);
        }
        {
            let mut borrowed = snapshot.borrow_mut();
            let flushed = batch.flush(&mut borrowed.state);
            emitted.extend(events_of(&flushed));
        }
        self.shape_failed_statuses(snapshot, &mut emitted)?;
        self.admission_block(
            store,
            id,
            snapshot,
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
        if generation.is_some()
            && !opening
            && emitted.iter().any(|event| kind(event) == "run.ended")
        {
            let ended_root = emitted.iter().any(|event| {
                kind(event) == "run.ended"
                    && text_field(event, "runId").is_some_and(|run_id| {
                        snapshot
                            .borrow()
                            .state
                            .runs
                            .get(run_id)
                            .is_some_and(|run| run.agent_id == root)
                    })
            });
            if ended_root && let Some(generation) = generation {
                self.retire_ended_turn_inputs(id, generation, now)?;
            }
        }
        {
            let raw = Self::facts(facts_json)?;
            let borrowed_events = emitted.clone();
            snapshot
                .borrow_mut()
                .update_deadlines(&raw, &borrowed_events, now as i64);
        }
        let raw_facts = Self::facts(facts_json)?;
        let touched = crate::snapshot::touched::Touched::values(&raw_facts, &emitted);
        let events_json = ace_json::to_string(&Value::Array(emitted.into()));
        self.save(store, id, snapshot, &events_json, now, &touched)?;
        Ok(())
    }

    /// `provider-facts.ts:131`-`:137`: a root turn's run trigger says why it ended.
    fn root_turn_trigger(
        &mut self,
        snapshot: &Rc<RefCell<Snapshot>>,
        fact: &Value,
    ) -> Option<String> {
        let borrowed = snapshot.borrow();
        let record = borrowed.state.agents.get(&self.root_key(snapshot))?;
        let run_id = match fact.get("nativeTurnId").and_then(Value::as_str) {
            Some(native) => record
                .native_runs
                .as_ref()
                .and_then(|runs| runs.get(native))
                .cloned(),
            None => record.active_run.clone(),
        }?;
        let run = borrowed.state.runs.get(&run_id)?;
        ["spawn", "parent_agent", "subagent_result", "schedule"]
            .contains(&run.trigger.as_str())
            .then(|| run.trigger.clone())
    }
}

pub(super) fn set(value: &mut Value, key: &str, next: Value) {
    if let Some(object) = value.as_object_mut() {
        object.insert(key, next);
    }
}

fn needs_shaping(fact: &Value) -> bool {
    match kind(fact) {
        "item.upsert" | "item.reconciled" => {
            fact.get("draft")
                .and_then(|draft| draft.get("type"))
                .and_then(Value::as_str)
                == Some("notice")
        }
        "turn.ended" => fact.get("error").is_some(),
        "process.exited" => fact.get("message").is_some(),
        _ => false,
    }
}

fn events_of(events: &[ace_core::emit::Event]) -> Vec<Value> {
    let mut json = String::new();
    ace_core::event_json::write_events(events, &mut json);
    match ace_json::parse(&json) {
        Ok(Value::Array(items)) => items.into_vec(),
        _ => Vec::new(),
    }
}
