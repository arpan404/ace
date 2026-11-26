// SPDX-License-Identifier: Apache-2.0
//! Run binding (`transcript-inputs.ts:157`-`:226`, E5.4b): which turn each accepted input joins.
//! These are pure over the `ThreadState` they are given and the journal's rows; they mutate the
//! state's item map before returning the event payloads, as the TypeScript does.

use ace_core::ThreadState;
use ace_core::items::Item;
use ace_json::Value;
use std::sync::Arc;

use crate::EngineError;
use crate::inputs::journal;
use crate::snapshot::Snapshot;
use crate::snapshot::touched::Touched;

/// Load the records a binding reads: the state's sections are lazy (E5.3), and an input's item
/// is never named by the frame that starts or consumes its run.
fn hydrate(
    snapshot: &mut Snapshot,
    items: &[String],
    agents: &[String],
    runs: &[String],
) -> Result<(), EngineError> {
    let mut touched = Touched::default();
    touched.items.extend(items.iter().cloned());
    touched.agents.extend(agents.iter().cloned());
    touched.runs.extend(runs.iter().cloned());
    snapshot.hydrate(&touched)
}

/// The root agent's id: `state.agents[state.rootKey ?? ""]?.agent.id`.
fn root_agent(state: &ThreadState) -> Option<String> {
    state
        .agents
        .get(state.root_key.as_deref().unwrap_or(""))
        .map(|record| record.agent.id.clone())
}

/// The message item `key` when it belongs to the root agent.
fn root_message<'a>(state: &'a ThreadState, key: &str) -> Option<&'a Item> {
    let root = root_agent(state)?;
    match state.items.get(key) {
        Some(item @ Item::Message { base, .. }) if base.agent_id == root => Some(item),
        _ => None,
    }
}

/// One item through its JSON, so a re-added `runId` lands at the end where JavaScript puts it.
fn through_json(item: &Item) -> Option<Value> {
    let text = ace_json::ser::to_string(item).ok()?;
    ace_json::parse(&text).ok()
}

/// An item with its run set: `{ runId: _previous, ...rest }` then the new `runId`.
fn with_run(object: &mut Value, run: Option<&str>) {
    let Some(map) = object.as_object_mut() else {
        return;
    };
    map.remove("runId");
    if let Some(run) = run {
        map.insert("runId", Value::from(run));
    }
}

/// The item back into the state, and the event that announces it.
fn store(state: &mut ThreadState, key: &str, value: Value) -> Option<Item> {
    let text = ace_json::to_string(&value);
    let item: Item = ace_json::from_value(&ace_json::parse(&text).ok()?).ok()?;
    state.items.insert(key.to_owned(), item.clone());
    Some(item)
}

/// `bindItemRun`: the input's item joins `run` when it is the root's user message and changed.
pub fn bind_item_run(state: &mut ThreadState, key: &str, run: Option<&str>) -> Option<Value> {
    let item = state.items.get(key)?;
    if !matches!(item, Item::Message { .. }) {
        return None;
    }
    let root = root_agent(state);
    match item {
        Item::Message { base, .. } if Some(&base.agent_id) != root.as_ref() => return None,
        Item::Message { base, .. } if base.run_id.as_deref() == run => return None,
        _ => {}
    }
    let mut value = through_json(item)?;
    with_run(&mut value, run);
    store(state, key, value.clone())?;
    let mut event = ace_json::Map::new();
    event.insert("type", Value::from("item.updated"));
    event.insert("item", value);
    Some(Value::Object(event))
}

/// A root run started in session `generation`: it took every input that session was handed and
/// no run has taken yet. Each joins the run, so the transcript groups it with the answer.
pub fn bind_started_run(
    snapshot: &mut Snapshot,
    conn: &Arc<ace_store::Connection>,
    run: &str,
    generation: Option<f64>,
) -> Result<Vec<Value>, EngineError> {
    let keys = journal::bind_sent(conn, &snapshot.state.thread_id, run, generation)?;
    let root = snapshot.state.root_key.clone().unwrap_or_default();
    hydrate(snapshot, &keys, &[root], &[])?;
    Ok(keys
        .into_iter()
        .filter_map(|key| bind_item_run(&mut snapshot.state, &key, Some(run)))
        .collect())
}

/// The provider says which run took a delivered input: the root's running turn, or with none
/// running, the next one. An input that moves off a finished run was never that run's: it is
/// created again here, at the point it was consumed.
pub fn bind_consumed_input(
    snapshot: &mut Snapshot,
    conn: &Arc<ace_store::Connection>,
    key: &str,
    generation: Option<f64>,
    at: i64,
) -> Result<Vec<Value>, EngineError> {
    let root = snapshot.state.root_key.clone().unwrap_or_default();
    hydrate(snapshot, &[key.to_owned()], &[root], &[])?;
    let Some(item) = root_message(&snapshot.state, key) else {
        return Ok(Vec::new());
    };
    let (run, previous) = match item {
        Item::Message { base, .. } => (
            snapshot
                .state
                .agents
                .get(snapshot.state.root_key.as_deref().unwrap_or(""))
                .and_then(|record| record.active_run.clone()),
            base.run_id.clone(),
        ),
        _ => (None, None),
    };
    if previous == run || !journal::sent_in(conn, &snapshot.state.thread_id, key, generation)? {
        return Ok(Vec::new());
    }
    if let Some(previous) = previous.as_deref() {
        hydrate(snapshot, &[], &[], &[previous.to_owned()])?;
        if snapshot
            .state
            .runs
            .get(previous)
            .is_some_and(|run| run.state == "active")
        {
            return Ok(Vec::new());
        }
    }
    journal::attach_run(conn, &snapshot.state.thread_id, key, run.as_deref())?;
    if previous.is_none() {
        return Ok(bind_item_run(&mut snapshot.state, key, run.as_deref())
            .into_iter()
            .collect());
    }
    let Some(item) = snapshot.state.items.get(key) else {
        return Ok(Vec::new());
    };
    let Some(mut moved) = through_json(item) else {
        return Ok(Vec::new());
    };
    let Some(object) = moved.as_object_mut() else {
        return Ok(Vec::new());
    };
    object.remove("runId");
    object.insert("createdAt", Value::from(at));
    if let Some(run) = run.as_deref() {
        object.insert("runId", Value::from(run));
    }
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let _ = store(&mut snapshot.state, key, moved.clone());
    let mut deleted = ace_json::Map::new();
    deleted.insert("type", Value::from("item.deleted"));
    deleted.insert("itemId", Value::from(id.as_str()));
    let mut created = ace_json::Map::new();
    created.insert("type", Value::from("item.created"));
    created.insert("item", moved);
    Ok(vec![Value::Object(deleted), Value::Object(created)])
}
