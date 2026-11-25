// SPDX-License-Identifier: Apache-2.0
//! Execution provenance (E5.3 step 6a, `execution-provenance.ts:5`): record ownership when a run
//! starts. A root run's source is the thread's selection with the native session id; a child's
//! is its own provider and model, with the instance only when the provider matches. Items take
//! their run's source.

use ace_core::ThreadState;
use ace_json::{Map, Value};

use crate::repository::collaborators::Selection;

/// Stamp `executionSource` on the payload's run starts and items.
pub fn capture(
    state: &mut ThreadState,
    payloads: &mut [Value],
    selection: &Selection,
    native_session_id: Option<&str>,
) {
    for payload in payloads.iter_mut() {
        let Some(object) = payload.as_object() else {
            continue;
        };
        let kind = object
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match kind {
            "run.started" => capture_run(state, payload, selection, native_session_id),
            "item.created" | "item.updated" => capture_item(state, payload),
            _ => {}
        }
    }
}

fn capture_run(
    state: &mut ThreadState,
    payload: &mut Value,
    selection: &Selection,
    native_session_id: Option<&str>,
) {
    let run = payload.get("run").cloned();
    let Some(run) = run.as_ref().and_then(Value::as_object) else {
        return;
    };
    let agent_id = run
        .get("agentId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let key = state
        .indexes
        .agent_keys_by_id
        .get(agent_id)
        .cloned()
        .unwrap_or_default();
    let agent = state.agents.get(&key).map(|record| record.agent.clone());
    let root = state.root_key.as_deref() == Some(key.as_str());
    let Some(agent) = agent else {
        return;
    };
    let native_id = if root {
        native_session_id.map(str::to_owned)
    } else {
        agent.native.native_id.clone()
    };
    let Some(native_id) = native_id else {
        return;
    };
    let source = source_value(&agent, root, selection, &native_id);
    if let Some(run_value) = payload.get_mut("run").and_then(Value::as_object_mut) {
        run_value.insert("executionSource", source.clone());
    }
    let run_id = run.get("id").and_then(Value::as_str).unwrap_or_default();
    if let Some(stored) = state.runs.get_mut(run_id) {
        stored.execution_source = serde_json::from_str(&ace_json::to_string(&source)).ok();
    }
}

fn source_value(
    agent: &ace_core::state::Agent,
    root: bool,
    selection: &Selection,
    native_id: &str,
) -> Value {
    let mut selected = Map::new();
    let provider = if root {
        selection
            .provider
            .clone()
            .unwrap_or_else(|| agent.native.provider.clone())
    } else {
        agent.native.provider.clone()
    };
    selected.insert("provider", Value::from(provider.as_str()));
    if root {
        if let Some(model) = &selection.model {
            selected.insert("model", Value::from(model.as_str()));
        }
        if let Some(instance) = &selection.instance_id {
            selected.insert("instanceId", Value::from(instance.as_str()));
        }
    } else {
        if let Some(model) = &agent.model {
            selected.insert("model", Value::from(model.as_str()));
        }
        if agent.native.provider == provider
            && let Some(instance) = &agent.native.instance_id
        {
            selected.insert("instanceId", Value::from(instance.as_str()));
        }
    }
    selected.insert("options", Value::from(Map::new()));
    let mut source = Map::new();
    source.insert("nativeSessionId", Value::from(native_id));
    source.insert("selection", Value::from(selected));
    Value::from(source)
}

fn capture_item(state: &ThreadState, payload: &mut Value) {
    let source = payload
        .get("item")
        .and_then(Value::as_object)
        .and_then(|item| item.get("runId"))
        .and_then(Value::as_str)
        .and_then(|run_id| state.runs.get(run_id))
        .and_then(|run| run.execution_source.clone());
    let Some(source) = source else {
        return;
    };
    let source = ace_json::parse(&serde_json::Value::to_string(&source)).unwrap_or_default();
    if let Some(item) = payload.get_mut("item").and_then(Value::as_object_mut)
        && item.get("executionSource").is_none()
    {
        item.insert("executionSource", source);
    }
}
