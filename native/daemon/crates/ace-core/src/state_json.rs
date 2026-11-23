// SPDX-License-Identifier: Apache-2.0
//! `ThreadState` as `JSON.stringify` writes it. `createThreadState` builds the identity and the
//! empty records in one literal; every optional field the fold later sets is appended at the end
//! of the object, in the order it first appears. That insertion order is what a snapshot's bytes
//! carry, so it is written here field for field.
//!
//! A state restored from JSON has no record of when each field appeared: its keys are written in
//! the canonical order of the same list, so nothing is ever dropped.

use serde::Serialize;
use serde::ser::{SerializeMap, Serializer};

use crate::state::ThreadState;

/// The fields the fold may add after creation, in the order the TypeScript usually sets them.
const OPTIONAL: [&str; 10] = [
    "rootKey",
    "processExit",
    "lastTransportSignalAt",
    "statusObservedAt",
    "runSeq",
    "personTasks",
    "rejectionNotices",
    "queueHeld",
    "queueStopped",
    "movedTo",
];

/// Write one optional field when it is present, whatever order it is reached in.
fn write_optional<S: SerializeMap>(
    map: &mut S,
    state: &ThreadState,
    key: &str,
) -> Result<(), S::Error> {
    match key {
        "rootKey" => {
            if let Some(value) = &state.root_key {
                map.serialize_entry("rootKey", value)?;
            }
        }
        "processExit" => {
            if let Some(value) = &state.process_exit {
                map.serialize_entry("processExit", value)?;
            }
        }
        "lastTransportSignalAt" => {
            if let Some(value) = &state.last_transport_signal_at {
                map.serialize_entry("lastTransportSignalAt", value)?;
            }
        }
        "statusObservedAt" => {
            if let Some(value) = &state.status_observed_at {
                map.serialize_entry("statusObservedAt", value)?;
            }
        }
        "runSeq" => {
            if let Some(value) = &state.run_seq {
                map.serialize_entry("runSeq", value)?;
            }
        }
        "personTasks" => {
            if let Some(value) = &state.person_tasks {
                map.serialize_entry("personTasks", value)?;
            }
        }
        "rejectionNotices" => {
            if let Some(value) = &state.rejection_notices {
                map.serialize_entry("rejectionNotices", value)?;
            }
        }
        "queueHeld" => {
            if let Some(value) = &state.queue_held {
                map.serialize_entry("queueHeld", value)?;
            }
        }
        "queueStopped" => {
            if let Some(value) = &state.queue_stopped {
                map.serialize_entry("queueStopped", value)?;
            }
        }
        "movedTo" => {
            if let Some(value) = &state.moved_to {
                map.serialize_entry("movedTo", value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

/// The state's own key order, exactly as [`Serialize`] writes it: the facade keeps its view's
/// fields in it, so `Object.keys`, a spread and `JSON.stringify` see what the TypeScript sees.
pub fn field_order(state: &ThreadState) -> Vec<&'static str> {
    let mut order: Vec<&'static str> = vec!["threadId", "config"];
    if state.initial_root.is_some() {
        order.push("initialRoot");
    }
    order.extend([
        "agents",
        "runs",
        "items",
        "interactions",
        "tasks",
        "uncertainTasks",
        "interactionHistory",
        "taskHistory",
        "indexes",
        "outcomeOrder",
        "pendingNotices",
        "itemLinks",
        "queueCount",
        "queueSources",
        "hasRun",
        "status",
    ]);
    // A field the fold cleared is absent from the object, so it leaves the order with it.
    for key in &state.appended {
        if present(state, key) {
            order.push(key);
        }
    }
    for key in OPTIONAL {
        if !state.appended.contains(&key) && present(state, key) {
            order.push(key);
        }
    }
    order
}

fn present(state: &ThreadState, key: &str) -> bool {
    match key {
        "rootKey" => state.root_key.is_some(),
        "processExit" => state.process_exit.is_some(),
        "lastTransportSignalAt" => state.last_transport_signal_at.is_some(),
        "statusObservedAt" => state.status_observed_at.is_some(),
        "runSeq" => state.run_seq.is_some(),
        "personTasks" => state.person_tasks.is_some(),
        "rejectionNotices" => state.rejection_notices.is_some(),
        "queueHeld" => state.queue_held.is_some(),
        "queueStopped" => state.queue_stopped.is_some(),
        "movedTo" => state.moved_to.is_some(),
        _ => false,
    }
}

/// The optional fields a record gains as the fold runs, in their common first-set order.
const RECORD_OPTIONAL: [&str; 12] = [
    "spawnedByKey",
    "completionRelevant",
    "nativeRuns",
    "activeRun",
    "lastRun",
    "lastOutcomeOrder",
    "lastSuccessfulOutcomeOrder",
    "externalStatus",
    "lastError",
    "processSettledStatus",
    "detail",
    "disconnectedAt",
];

fn record_field<S: SerializeMap>(
    map: &mut S,
    record: &crate::state::AgentRecord,
    key: &str,
) -> Result<(), S::Error> {
    match key {
        "parentKey" => {
            if let Some(value) = &record.parent_key {
                map.serialize_entry("parentKey", value)?;
            }
        }
        "spawnedByKey" => {
            if let Some(value) = &record.spawned_by_key {
                map.serialize_entry("spawnedByKey", value)?;
            }
        }
        "completionRelevant" => {
            if let Some(value) = &record.completion_relevant {
                map.serialize_entry("completionRelevant", value)?;
            }
        }
        "nativeRuns" => {
            if let Some(value) = &record.native_runs {
                map.serialize_entry("nativeRuns", value)?;
            }
        }
        "activeRun" => {
            if let Some(value) = &record.active_run {
                map.serialize_entry("activeRun", value)?;
            }
        }
        "lastRun" => {
            if let Some(value) = &record.last_run {
                map.serialize_entry("lastRun", value)?;
            }
        }
        "lastOutcomeOrder" => {
            if let Some(value) = &record.last_outcome_order {
                map.serialize_entry("lastOutcomeOrder", value)?;
            }
        }
        "lastSuccessfulOutcomeOrder" => {
            if let Some(value) = &record.last_successful_outcome_order {
                map.serialize_entry("lastSuccessfulOutcomeOrder", value)?;
            }
        }
        "externalStatus" => {
            if let Some(value) = &record.external_status {
                map.serialize_entry("externalStatus", value)?;
            }
        }
        "lastError" => {
            if let Some(value) = &record.last_error {
                map.serialize_entry("lastError", value)?;
            }
        }
        "processSettledStatus" => {
            if let Some(value) = &record.process_settled_status {
                map.serialize_entry("processSettledStatus", value)?;
            }
        }
        "detail" => {
            if let Some(value) = &record.detail {
                map.serialize_entry("detail", value)?;
            }
        }
        "disconnectedAt" => {
            if let Some(value) = &record.disconnected_at {
                map.serialize_entry("disconnectedAt", value)?;
            }
        }
        "limited" => {
            if let Some(value) = &record.limited {
                map.serialize_entry("limited", value)?;
            }
        }
        "retry" => {
            if let Some(value) = &record.retry {
                map.serialize_entry("retry", value)?;
            }
        }
        "wakeUntil" => {
            if let Some(value) = &record.wake_until {
                map.serialize_entry("wakeUntil", value)?;
            }
        }
        _ => {}
    }
    Ok(())
}

impl Serialize for crate::state::AgentRecord {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("agent", &self.agent)?;
        map.serialize_entry("activity", &self.activity)?;
        map.serialize_entry("lastSignalAt", &self.last_signal_at)?;
        for key in &self.appended {
            record_field(&mut map, self, key)?;
        }
        for key in RECORD_OPTIONAL {
            if !self.appended.contains(&key) {
                record_field(&mut map, self, key)?;
            }
        }
        for key in ["limited", "retry", "wakeUntil"] {
            if !self.appended.contains(&key) {
                record_field(&mut map, self, key)?;
            }
        }
        map.end()
    }
}

impl Serialize for ThreadState {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("threadId", &self.thread_id)?;
        map.serialize_entry("config", &self.config)?;
        if let Some(root) = &self.initial_root {
            map.serialize_entry("initialRoot", root)?;
        }
        map.serialize_entry("agents", &self.agents)?;
        map.serialize_entry("runs", &self.runs)?;
        map.serialize_entry("items", &self.items)?;
        map.serialize_entry("interactions", &self.interactions)?;
        map.serialize_entry("tasks", &self.tasks)?;
        map.serialize_entry("uncertainTasks", &self.uncertain_tasks)?;
        map.serialize_entry("interactionHistory", &self.interaction_history)?;
        map.serialize_entry("taskHistory", &self.task_history)?;
        map.serialize_entry("indexes", &self.indexes)?;
        map.serialize_entry("outcomeOrder", &self.outcome_order)?;
        map.serialize_entry("pendingNotices", &self.pending_notices)?;
        map.serialize_entry("itemLinks", &self.item_links)?;
        map.serialize_entry("queueCount", &self.queue_count)?;
        map.serialize_entry("queueSources", &self.queue_sources)?;
        map.serialize_entry("hasRun", &self.has_run)?;
        map.serialize_entry("status", &self.status)?;
        for key in &self.appended {
            write_optional(&mut map, self, key)?;
        }
        // A restored state knows only which fields are present: write the rest in canonical
        // order, so every field still travels.
        for key in OPTIONAL {
            if !self.appended.contains(&key) {
                write_optional(&mut map, self, key)?;
            }
        }
        map.end()
    }
}
