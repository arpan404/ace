// SPDX-License-Identifier: Apache-2.0
//! The preflight of `validate.ts`: every check reads state but changes
//! nothing. No ids are allocated, no signals refreshed, no rows indexed.
//! Rejected facts report exact reasons; the fold turns them into notices.

use std::collections::HashSet;

use crate::emit::get;
use crate::facts::Fact;
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
        "agent.linked" => &[
            "agent",
            "parent",
            "spawnedBy",
            "background",
            "name",
            "model",
        ],
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
        "interaction.closed" => &[
            "interaction",
            "state",
            "resolution",
            "resolvedBy",
            "autoReviewed",
        ],
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
    matches!(value, None | Some(Json::String(_)))
}

fn one_of(value: Option<&Json>, values: &[&str]) -> bool {
    value
        .and_then(|value| value.as_str())
        .is_some_and(|text| values.contains(&text))
}

pub(crate) fn relation_error(state: &ThreadState, agent: &str, parent: &str) -> Option<String> {
    if parent == agent {
        return Some("an agent cannot be its own parent".to_owned());
    }
    if state
        .initial_root
        .as_ref()
        .is_some_and(|root| root.agent == agent)
    {
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

fn as_object_map(value: &Json) -> Option<&Map> {
    match value {
        Json::Object(map) => Some(map),
        _ => None,
    }
}

fn get_str<'a>(map: &'a Map, key: &str) -> Option<&'a str> {
    map.get(key).and_then(|value| value.as_str())
}

fn is_string(value: Option<&Json>) -> bool {
    matches!(value, Some(Json::String(_)))
}

fn valid_run_trigger(value: Option<&Json>) -> bool {
    one_of(
        value,
        &[
            "user",
            "restart",
            "limit_resume",
            "spawn",
            "parent_agent",
            "background_completion",
            "subagent_result",
            "goal",
            "queue",
            "schedule",
            "unknown",
        ],
    )
}

fn valid_permission_mode(value: Option<&Json>) -> bool {
    match value {
        None => true,
        Some(Json::Null) => true,
        Some(Json::String(mode)) => !mode.is_empty() && mode.len() <= 4096,
        _ => false,
    }
}

/// Preflight only reads state. No ids, signals, rows or indexes are changed.
pub fn checked_fact(state: &ThreadState, input: &Json, now: i64) -> Result<Fact, String> {
    if !crate::fact_data::is_fact_data(input) {
        return Err("adapter facts must contain JSON data".to_owned());
    }
    let map = match as_object_map(input) {
        Some(map) => map,
        None => return Err("unknown adapter fact".to_owned()),
    };
    let fact_type = match get_str(map, "type") {
        Some(kind) => kind,
        None => return Err("unknown adapter fact".to_owned()),
    };
    let allowed = match allowed_fields(fact_type) {
        Some(allowed) => allowed,
        None => return Err("unknown adapter fact".to_owned()),
    };
    if map
        .keys()
        .any(|key| key != "type" && !allowed.contains(&key.as_str()))
    {
        return Err("unrecognized fact fields".to_owned());
    }
    for key in ["parent", "spawnedBy", "nativeTurnId", "item", "childAgent"] {
        if allowed.contains(&key) && !optional_string(map.get(key)) {
            return Err(format!("{key} must be a string"));
        }
    }
    if allowed.contains(&"agent") {
        let agent = map.get("agent");
        if fact_type == "signal" {
            if !optional_string(agent) {
                return Err("agent key must be a string".to_owned());
            }
        } else if !is_string(agent) {
            return Err("agent key must be a string".to_owned());
        }
    }
    for key in ["interaction", "task"] {
        if allowed.contains(&key) && !is_string(map.get(key)) {
            return Err(format!("{key} key must be a string"));
        }
    }
    if matches!(
        fact_type,
        "item.upsert" | "item.reconciled" | "item.delta" | "subagents.waiting"
    ) && !is_string(map.get("item"))
    {
        return Err("item key must be a string".to_owned());
    }
    if fact_type == "agent.seen" || fact_type == "agent.linked" {
        let agent = get_str(map, "agent").unwrap_or("");
        if fact_type == "agent.seen"
            && map.get("origin").and_then(|origin| origin.as_str()) == Some("root")
            && map.contains_key("parent")
        {
            return Err("a root cannot have a parent".to_owned());
        }
        if let Some(parent) = get_str(map, "parent")
            && let Some(error) = relation_error(state, agent, parent)
        {
            return Err(error);
        }
        if map.get("spawnedBy").and_then(|key| key.as_str()).is_some() {
            let item = map
                .get("spawnedBy")
                .and_then(|key| key.as_str())
                .and_then(|key| get(&state.items, key));
            let owner = item
                .and_then(|item| get(&state.indexes.agent_keys_by_id, item.agent_id()))
                .cloned();
            if let Some(owner) = owner {
                if let Some(error) = relation_error(state, agent, &owner) {
                    return Err(error);
                }
                if map.get("parent").and_then(|parent| parent.as_str()) != Some(owner.as_str()) {
                    return Err("spawn owner contradicts the parent".to_owned());
                }
            }
        }
    }
    if fact_type == "item.delta" {
        let item_key = map.get("item").and_then(|key| key.as_str()).unwrap_or("");
        let item = get(&state.items, item_key);
        let owner_id = map
            .get("agent")
            .and_then(|key| key.as_str())
            .and_then(|key| get(&state.agents, key))
            .map(|record| record.agent.id.clone());
        if let Some(item) = item
            && Some(item.agent_id()) != owner_id.as_deref()
        {
            return Err("item key has a different owner".to_owned());
        }
        if let Some(item) = item {
            let field = map
                .get("field")
                .and_then(|field| field.as_str())
                .unwrap_or("");
            let valid = (field == "output"
                && matches!(
                    item,
                    crate::items::Item::ToolCall { call, .. } if matches!(&call.detail, crate::item_model::ToolDetail::Shell { .. })
                ))
                || (field == "text" && matches!(item, crate::items::Item::Message { .. }))
                || (field != "output"
                    && matches!(
                        item,
                        crate::items::Item::Reasoning { .. } | crate::items::Item::Notice { .. }
                    ));
            if !valid {
                return Err("delta field contradicts its item".to_owned());
            }
        }
    }
    if matches!(
        fact_type,
        "background.started" | "interaction.opened" | "subagents.waiting"
    ) && is_string(map.get("item"))
    {
        let item_key = map.get("item").and_then(|key| key.as_str()).unwrap_or("");
        let item = get(&state.items, item_key);
        let owner_id = map
            .get("agent")
            .and_then(|key| key.as_str())
            .and_then(|key| get(&state.agents, key))
            .map(|record| record.agent.id.clone());
        if let Some(item) = item {
            if Some(item.agent_id()) != owner_id.as_deref() {
                return Err("referenced item has a different owner".to_owned());
            }
            if !matches!(item, crate::items::Item::ToolCall { .. }) {
                return Err("work links must reference a tool".to_owned());
            }
        } else if fact_type == "subagents.waiting" {
            return Err("wait must reference an existing tool".to_owned());
        }
    }
    if fact_type == "interaction.opened" || fact_type == "background.started" {
        let key = if fact_type == "interaction.opened" {
            get_str(map, "interaction")
        } else {
            get_str(map, "task")
        };
        if let Some(key) = key {
            let (live, owner_id) = if fact_type == "interaction.opened" {
                match get(&state.interactions, key) {
                    Some(interaction) => (
                        interaction.state == "pending",
                        Some(interaction.agent_id.clone()),
                    ),
                    None => (false, None),
                }
            } else {
                match get(&state.tasks, key) {
                    Some(task) => (task.status == "running", Some(task.agent_id.clone())),
                    None => (false, None),
                }
            };
            if live {
                let owner = map
                    .get("agent")
                    .and_then(|key| key.as_str())
                    .and_then(|key| get(&state.agents, key).map(|record| record.agent.id.clone()));
                let narrowed = fact_type == "background.started"
                    && map
                        .get("agent")
                        .and_then(|key| key.as_str())
                        .is_some_and(|agent| {
                            owner_id
                                .as_ref()
                                .is_some_and(|current| descends_from(state, agent, current))
                        });
                if owner != owner_id && !narrowed {
                    return Err("live key has a different owner".to_owned());
                }
            }
        }
    }
    if fact_type == "interaction.closed"
        && let Some(resolution) = map.get("resolution")
        && let Some(object) = as_object_map(resolution)
    {
        let current = map
            .get("interaction")
            .and_then(|key| key.as_str())
            .and_then(|key| get(&state.interactions, key));
        if let Some(current) = current {
            let kinds_match = matches!(
                (
                    &current.request,
                    object.get("kind").and_then(|kind| kind.as_str()),
                ),
                (
                    crate::entity_model::InteractionRequest::Approval { .. },
                    Some("approval"),
                ) | (
                    crate::entity_model::InteractionRequest::Question { .. },
                    Some("question"),
                ) | (
                    crate::entity_model::InteractionRequest::PlanReview { .. },
                    Some("plan_review"),
                ) | (
                    crate::entity_model::InteractionRequest::Elicitation { .. },
                    Some("elicitation"),
                ) | (
                    crate::entity_model::InteractionRequest::BrowserHelp { .. },
                    Some("browser_help"),
                )
            );
            if !kinds_match {
                return Err("resolution contradicts its request".to_owned());
            }
        }
    }
    if fact_type == "background.started"
        && let Some(child) = get_str(map, "childAgent")
        && let Some(agent) = get_str(map, "agent")
        && let Some(error) = relation_error(state, child, agent)
    {
        return Err(error);
    }
    match shape_valid(state, map, fact_type, now) {
        Ok(true) => {}
        Ok(false) => return Err("invalid adapter fact fields".to_owned()),
        Err(_) => return Err("invalid adapter fact data".to_owned()),
    }
    crate::facts::convert(map, fact_type).ok_or_else(|| "invalid adapter fact data".to_owned())
}

use crate::validate_shapes::{
    valid_agent_machine, valid_goal, valid_interaction_request, valid_interaction_resolution,
    valid_native_ref, valid_raw_list, valid_thread_id, valid_thread_lineage, valid_timestamp,
};

fn valid_agent_seen(_state: &ThreadState, map: &Map) -> bool {
    // Origin must be a known agent origin.
    if !matches!(
        map.get("origin").and_then(|origin| origin.as_str()),
        Some("root" | "provider_subagent" | "ace")
    ) {
        return false;
    }
    if !matches!(
        map.get("fidelity").and_then(|fidelity| fidelity.as_str()),
        Some("full" | "summary" | "placeholder")
    ) {
        return false;
    }
    if !valid_native_ref(map.get("native")) {
        return false;
    }
    if !matches!(map.get("cwd"), Some(Json::String(_))) {
        return false;
    }
    for key in ["name", "role", "model"] {
        if !matches!(
            map.get(key),
            None | Some(Json::Null) | Some(Json::String(_))
        ) {
            return false;
        }
    }
    if !matches!(
        map.get("background"),
        None | Some(Json::Null) | Some(Json::Bool(_))
    ) {
        return false;
    }
    if let Some(machine) = map.get("machine")
        && !matches!(machine, Json::Null)
        && !valid_agent_machine(Some(machine))
    {
        return false;
    }
    if let Some(lineage) = map.get("lineage")
        && !matches!(lineage, Json::Null)
        && !valid_thread_lineage(Some(lineage))
    {
        return false;
    }
    true
}

/// The shape half of preflight: every field has the right JSON shape.
/// Returns `Ok(false)` for a shape mismatch and `Err` for unreadable data.
#[allow(clippy::result_unit_err)]
pub fn shape_valid(state: &ThreadState, fact: &Map, fact_type: &str, now: i64) -> Result<bool, ()> {
    let valid = match fact_type {
        "agent.external" => {
            valid_thread_id(fact.get("threadId"))
                && {
                    let status = fact.get("status").cloned().unwrap_or(Json::Null);
                    let text = ace_json::to_string(&status);
                    serde_json::from_str::<crate::status::ThreadStatus>(&text).is_ok()
                }
                && get(&state.agents, fact.get("agent").and_then(|agent| agent.as_str()).unwrap_or(""))
                    .is_some_and(|record| record.agent.origin == "ace")
        }
        "agent.seen" => valid_agent_seen(state, fact),
        "agent.linked" => {
            matches!(
                fact.get("background"),
                None | Some(Json::Null) | Some(Json::Bool(_))
            ) && matches!(fact.get("name"), None | Some(Json::Null) | Some(Json::String(_)))
                && matches!(fact.get("model"), None | Some(Json::Null) | Some(Json::String(_)))
        }
        "turn.started" => {
            valid_run_trigger(fact.get("trigger"))
                && valid_permission_mode(fact.get("permissionMode"))
        }
        "turn.ended" => {
            let outcome = matches!(
                fact.get("outcome").and_then(|outcome| outcome.as_str()),
                Some("completed" | "failed" | "interrupted")
            );
            let ended_by = match fact.get("endedBy") {
                None | Some(Json::Null) => true,
                Some(Json::String(ended)) => {
                    ended == "steer"
                        && fact.get("outcome").and_then(|outcome| outcome.as_str())
                            == Some("interrupted")
                }
                _ => false,
            };
            let historical = matches!(
                fact.get("historical"),
                None | Some(Json::Null) | Some(Json::Bool(_))
            );
            let trigger = match fact.get("trigger") {
                None | Some(Json::Null) => true,
                trigger => valid_run_trigger(trigger),
            };
            let error = match fact.get("error") {
                None | Some(Json::Null) => true,
                Some(_) => crate::validate_shapes::valid_agent_error(fact.get("error")),
            };
            outcome && ended_by && historical && trigger && error
        }
        "input.admitted" => {
            matches!(
                fact.get("nativeInputId"),
                Some(Json::String(id)) if !id.is_empty() && id.len() <= 512
            ) && match fact.get("commandId") {
                None | Some(Json::Null) => true,
                Some(Json::String(id)) => !id.is_empty() && id.len() <= 512,
                _ => false,
            }
        }
        "input.consumed" => match fact.get("nativeInputIds") {
            Some(Json::Array(ids)) => {
                ids.len() <= 64
                    && ids.iter().all(
                        |id| matches!(id, Json::String(id) if !id.is_empty() && id.len() <= 512),
                    )
            }
            _ => false,
        },
        "activity" => {
            matches!(
                fact.get("activity").and_then(|activity| activity.as_str()),
                Some(
                    "thinking"
                        | "responding"
                        | "tool"
                        | "compacting"
                        | "retrying"
                        | "starting_turn"
                )
            ) && optional_string(fact.get("detail"))
        }
        "subagents.waiting" => match fact.get("targets") {
            Some(Json::Array(targets)) => targets
                .iter()
                .all(|target| matches!(target, Json::String(_))),
            _ => false,
        },
        "item.reconciled" | "item.upsert" => {
            return match crate::validate_items::item_error(state, fact, fact_type, now) {
                None => Ok(true),
                Some(_) => Ok(false),
            };
        }
        "item.delta" => {
            matches!(
                fact.get("field").and_then(|field| field.as_str()),
                Some("text" | "reasoning" | "output")
            ) && is_string(fact.get("append"))
        }
        "interaction.opened" => {
            matches!(fact.get("blocking"), Some(Json::Bool(_)))
                && valid_interaction_request(fact.get("request"))
                && valid_raw_list(fact.get("raw"))
        }
        "interaction.closed" => {
            matches!(
                fact.get("state").and_then(|state| state.as_str()),
                Some("resolved" | "cancelled" | "expired")
            ) && match fact.get("resolution") {
                None | Some(Json::Null) => true,
                resolution => valid_interaction_resolution(resolution),
            } && matches!(fact.get("resolvedBy"), None | Some(Json::String(_)))
                && matches!(
                    fact.get("autoReviewed"),
                    None | Some(Json::Null) | Some(Json::Bool(_))
                )
        }
        "background.started" => {
            matches!(
                fact.get("kind").and_then(|kind| kind.as_str()),
                Some("shell" | "monitor" | "subagent" | "other")
            ) && match fact.get("owner") {
                None => true,
                Some(Json::String(owner)) => owner == "ace",
                _ => false,
            } && is_string(fact.get("title"))
                && matches!(fact.get("stoppable"), Some(Json::Bool(_)))
                && matches!(fact.get("ambient"), None | Some(Json::Bool(_)))
                && match fact.get("internal") {
                    None => true,
                    Some(Json::Bool(internal)) => *internal,
                    _ => false,
                }
                && optional_string(fact.get("outputPath"))
                && matches!(fact.get("wakesAgent"), None | Some(Json::Bool(false)))
                && matches!(fact.get("blocksPrompts"), None | Some(Json::Bool(true)))
                && matches!(
                    fact.get("endsWithSession"),
                    None | Some(Json::Bool(true))
                )
                && match fact.get("raw") {
                    None => true,
                    Some(Json::Array(raw)) => {
                        raw.iter().all(crate::validate_shapes::valid_raw_payload)
                    }
                    _ => false,
                }
        }
        "background.listening" => match fact.get("ports") {
            Some(Json::Array(ports)) => {
                ports.len() <= 16
                    && ports.iter().all(|port| {
                        matches!(as_integer(Some(port)), Some(port) if (1..=65_535).contains(&port))
                    })
            }
            _ => false,
        },
        "background.waiting" => matches!(fact.get("waiting"), Some(Json::Bool(_))),
        "background.ended" => {
            let status = matches!(
                fact.get("status").and_then(|status| status.as_str()),
                Some("completed" | "failed" | "stopped" | "unknown")
            );
            let uncertain = matches!(
                fact.get("uncertain"),
                None | Some(Json::Null) | Some(Json::Bool(_))
            );
            let uncertain_rule = match fact.get("uncertain") {
                Some(Json::Bool(true)) => {
                    fact.get("status").and_then(|status| status.as_str()) == Some("unknown")
                }
                _ => true,
            };
            status && uncertain && uncertain_rule
        }
        "retry" => {
            let on = matches!(
                fact.get("on").and_then(|on| on.as_str()),
                Some("rate_limit" | "network" | "upstream")
            );
            let attempt = match fact.get("attempt") {
                None => true,
                Some(attempt) => matches!(as_integer(Some(attempt)), Some(attempt) if attempt > 0),
            };
            let until = match fact.get("until") {
                None => true,
                Some(until) => as_count(Some(until)).is_some(),
            };
            let message = optional_string(fact.get("message"));
            on && attempt && until && message
        }
        "wake.expected" => valid_timestamp(fact.get("until")),
        "goal.updated" => match fact.get("goal") {
            Some(Json::Null) => true,
            Some(Json::Object(goal)) => valid_goal(goal),
            _ => false,
        },
        "context.sample" => {
            ensure_sample_keys(fact)
                && as_count(fact.get("usedTokens")).is_some()
                && match fact.get("windowTokens") {
                    None => true,
                    Some(window) => matches!(as_count(Some(window)), Some(window) if window > 0),
                }
                && optional_string(fact.get("sessionId"))
                && optional_string(fact.get("model"))
        }
        "usage" => {
            // The usage fact is validated as a whole, like the spread the
            // TypeScript parses: counts plus metadata, nothing else.
            as_count(fact.get("inputTokens")).is_some()
                && as_count(fact.get("outputTokens")).is_some()
                && valid_usage_facts(fact)
        }
        "process.exited" => {
            matches!(fact.get("deliberate"), Some(Json::Bool(_)))
                && optional_string(fact.get("message"))
                && matches!(
                    fact.get("unconfirmed"),
                    None | Some(Json::Null) | Some(Json::Bool(_))
                )
        }
        "queue.changed" => {
            as_count(fact.get("count")).is_some()
                && match fact.get("source") {
                    None => true,
                    Some(Json::String(source)) => {
                        ["engine", "provider"].contains(&source.as_str())
                    }
                    _ => false,
                }
                && matches!(
                    fact.get("held"),
                    None | Some(Json::Bool(_))
                )
                && (fact.get("held").is_none()
                    || fact.get("source").and_then(|source| source.as_str()) != Some("provider"))
                && matches!(
                    fact.get("stopped"),
                    None | Some(Json::Bool(_))
                )
                && (fact.get("stopped").is_none()
                    || fact.get("source").and_then(|source| source.as_str()) != Some("provider"))
        }
        "thread.moved" => match fact.get("to") {
            Some(Json::Null) => true,
            Some(Json::Object(to)) => {
                ensure_moved_target(to)
            }
            _ => false,
        },
        "agent.disconnected"
        | "agent.reconnected"
        | "retry.cleared"
        | "limit.cleared"
        | "signal"
        | "tick"
        | "process.started" => true,
        _ => false,
    };
    Ok(valid)
}

fn ensure_sample_keys(fact: &Map) -> bool {
    fact.keys().all(|key| {
        [
            "type",
            "agent",
            "usedTokens",
            "windowTokens",
            "sessionId",
            "model",
        ]
        .contains(&key.as_str())
    })
}

fn valid_usage_facts(fact: &Map) -> bool {
    use crate::validate_shapes::valid_usage_like;
    valid_usage_like(fact, &["type", "agent"])
}

fn ensure_moved_target(to: &Map) -> bool {
    to.keys()
        .all(|key| ["hostId", "name", "threadId"].contains(&key.as_str()))
        && matches!(to.get("hostId"), Some(Json::String(id)) if !id.is_empty())
        && matches!(to.get("name"), Some(Json::String(name)) if !name.is_empty() && name.len() <= 256)
        && matches!(to.get("threadId"), Some(Json::String(id)) if !id.is_empty())
}
