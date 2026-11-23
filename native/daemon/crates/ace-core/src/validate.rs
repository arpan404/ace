// SPDX-License-Identifier: Apache-2.0
//! The preflight of `validate.ts`: every check reads state but changes
//! nothing. No ids are allocated, no signals refreshed, no rows indexed.
//! Rejected facts report exact reasons; the fold turns them into notices.

use std::collections::HashSet;

use crate::emit::get;
use crate::facts::{Fact, Key};
use crate::json_io::{Json, Map, as_count, as_integer};
use crate::state::ThreadState;

/// The allowed fields of each fact type, like `allowed` in `validate.ts`.
fn allowed_fields(fact_type: &str) -> Option<&'static [&'static str]> {
    Some(match fact_type {
        "agent.external" => &["agent", "threadId", "status"],
        "agent.seen" => &[
            "agent",
            "parent",
            "spawnedBy",
            "origin",
            "fidelity",
            "native",
            "cwd",
            "name",
            "role",
            "model",
            "background",
            "machine",
        ],
        "agent.linked" => &["agent", "parent", "spawnedBy", "background", "name", "model"],
        "input.admitted" => &["agent", "nativeInputId", "commandId"],
        "input.consumed" => &["agent", "nativeInputIds"],
        "turn.started" => &["agent", "nativeTurnId", "trigger", "permissionMode"],
        "turn.ended" => &[
            "agent",
            "nativeTurnId",
            "outcome",
            "endedBy",
            "trigger",
            "error",
            "historical",
        ],
        "activity" => &["agent", "activity", "detail"],
        "item.upsert" => &["agent", "item", "draft"],
        "item.reconciled" => &["agent", "item", "draft"],
        "subagents.waiting" => &["agent", "item", "targets"],
        "item.delta" => &["agent", "item", "field", "append"],
        "interaction.opened" => &["agent", "interaction", "blocking", "request", "item", "raw"],
        "interaction.closed" => &["interaction", "state", "resolution", "resolvedBy", "autoReviewed"],
        "background.started" => &[
            "owner",
            "agent",
            "task",
            "kind",
            "title",
            "item",
            "childAgent",
            "ambient",
            "internal",
            "stoppable",
            "outputPath",
            "wakesAgent",
            "blocksPrompts",
            "endsWithSession",
            "raw",
        ],
        "background.listening" => &["task", "ports"],
        "background.waiting" => &["task", "waiting"],
        "background.ended" => &["task", "status", "uncertain"],
        "agent.disconnected" => &["agent"],
        "agent.reconnected" => &["agent"],
        "retry" => &["agent", "on", "attempt", "until", "message"],
        "retry.cleared" => &["agent"],
        "limit.cleared" => &["agent"],
        "wake.expected" => &["agent", "until"],
        "goal.updated" => &["agent", "goal"],
        "context.sample" => &["agent", "usedTokens", "windowTokens", "sessionId", "model"],
        "usage" => &[
            "agent",
            "inputTokens",
            "outputTokens",
            "cachedInputTokens",
            "contextWindow",
            "contextTokens",
            "contextSessionId",
            "costUsd",
            "reasoningTokens",
            "cacheWriteTokens",
            "cacheWrite1hTokens",
            "model",
            "accountId",
            "billingMode",
            "counterMode",
            "counterKey",
            "usageScope",
        ],
        "signal" => &["agent"],
        "process.exited" => &["deliberate", "message", "unconfirmed"],
        "process.started" => &[],
        "thread.moved" => &["to"],
        "queue.changed" => &["count", "source", "held", "stopped"],
        "tick" => &[],
        _ => return None,
    })
}

fn is_object(value: &Json) -> bool {
    matches!(value, Json::Object(_))
}

fn optional_string(value: Option<&Json>) -> bool {
    matches!(value, None | Some(Json::Null) | Some(Json::String(_)))
}

fn one_of(value: Option<&Json>, values: &[&str]) -> bool {
    value
        .and_then(|value| value.as_str())
        .is_some_and(|text| values.contains(&text))
}

fn relation_error(state: &ThreadState, agent: &str, parent: &str) -> Option<String> {
    if parent == agent {
        return Some("an agent cannot be its own parent".to_owned());
    }
    if state.initial_root.as_ref().is_some_and(|root| root.agent == agent) {
        return Some("a configured root cannot be re-parented".to_owned());
    }
    if state.root_key.as_deref() == Some(agent) {
        let reparentable = get(&state.agents, agent).is_some_and(|record| {
            record.agent.origin == "root" && record.agent.fidelity != "placeholder"
        });
        if reparentable {
            return Some("a known root cannot be re-parented".to_owned());
        }
    }
    let mut visited = HashSet::new();
    let mut key: Option<String> = Some(parent.to_owned());
    while let Some(name) = key {
        if name == agent {
            return Some("agent links cannot create a cycle".to_owned());
        }
        if !visited.insert(name.clone()) {
            break;
        }
        key = get(&state.agents, &name)?.parent_key.clone();
    }
    None
}

fn descends_from(state: &ThreadState, agent: &str, ancestor_id: &str) -> bool {
    let mut visited = HashSet::new();
    let mut key = get(&state.agents, agent).and_then(|record| record.parent_key.clone());
    while let Some(name) = key {
        if !visited.insert(name.clone()) {
            break;
        }
        let record = match get(&state.agents, &name) {
            Some(record) => record,
            None => break,
        };
        if record.agent.id == ancestor_id {
            return true;
        }
        key = record.parent_key.clone();
    }
    false
}
