// SPDX-License-Identifier: Apache-2.0
//! Child expiry on cancellation deadlines (`children.ts` expiry half).

use crate::translate::state::TranslationState;
use serde_json::{Map, Value};

pub fn expire_children(state: &mut TranslationState, now: i64) -> Vec<Value> {
    let mut facts = Vec::new();
    let cancelling: Vec<String> = state.cancelling.iter().cloned().collect();
    for agent_key in cancelling {
        let (terminal, cancel_at, native_id) = if agent_key == state.root.key {
            (
                state.root.terminal,
                state.root.cancel_at,
                state.root.native_id.clone(),
            )
        } else {
            match state.agents.values().find(|agent| agent.key == *agent_key) {
                Some(agent) => (agent.terminal, agent.cancel_at, agent.native_id.clone()),
                None => {
                    state.disarm_cancel(&agent_key);
                    continue;
                }
            }
        };
        if terminal {
            state.disarm_cancel(&agent_key);
            continue;
        }
        if cancel_at.is_none_or(|at| now < at) {
            continue;
        }
        state.start(&agent_key, &mut facts, "spawn");
        state.end(&agent_key, &mut facts, "interrupted", None);
        if agent_key == state.root.key {
            state.root.terminal = true;
        } else if let Some(agent) = state
            .agents
            .values_mut()
            .find(|agent| agent.key == *agent_key)
        {
            agent.terminal = true;
        }
        state.disarm_cancel(&agent_key);
        finish_child_tasks(state, &native_id, "unknown", &mut facts);
        let mut detail = Map::with_capacity(2);
        detail.insert("deadline".to_owned(), Value::from(now));
        detail.insert("nativeId".to_owned(), Value::String(native_id.clone()));
        state.notice(
            &mut facts,
            &Value::Object(detail),
            "ace/cancel-timeout",
            Some("No child cancellation update within 12 seconds"),
            Some(&agent_key),
        );
    }
    facts
}

pub(crate) fn finish_child_tasks(
    state: &mut TranslationState,
    child_native_id: &str,
    status: &str,
    facts: &mut Vec<Value>,
) {
    let Some(tools) = state.child_background_tools.get(child_native_id).cloned() else {
        return;
    };
    for tool_key in tools {
        if let Some(task) = state
            .tools
            .get(&tool_key)
            .and_then(|tool| tool.task.clone())
        {
            let mut fact = Map::with_capacity(3);
            fact.insert(
                "type".to_owned(),
                Value::String("background.ended".to_owned()),
            );
            fact.insert("task".to_owned(), Value::String(task));
            fact.insert("status".to_owned(), Value::String(status.to_owned()));
            facts.push(Value::Object(fact));
        }
        state.background_tools.shift_remove(&tool_key);
        if status != "unknown" {
            let owner_key = state
                .tools
                .get(&tool_key)
                .map(|tool| tool.owner_key.clone());
            if let Some(owner_key) = owner_key {
                let suspended = if owner_key == state.root.key {
                    state.root.suspended
                } else {
                    state
                        .agents
                        .values()
                        .find(|agent| agent.key == *owner_key)
                        .is_some_and(|agent| agent.suspended)
                };
                if suspended {
                    if owner_key == state.root.key {
                        state.root.suspended = false;
                    } else if let Some(owner) = state
                        .agents
                        .values_mut()
                        .find(|agent| agent.key == *owner_key)
                    {
                        owner.suspended = false;
                    }
                    state.start(&owner_key, facts, "subagent_result");
                }
            }
        }
    }
    if status != "unknown" {
        state.child_background_tools.shift_remove(child_native_id);
    }
}
