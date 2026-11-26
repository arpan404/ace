// SPDX-License-Identifier: Apache-2.0
//! The preflight of `validate.ts`: every check reads state but changes
//! nothing. No ids are allocated, no signals refreshed, no rows indexed.
//! Rejected facts report exact reasons; the fold turns them into notices.

use std::collections::HashSet;

use crate::emit::get;
use crate::facts::Fact;
use crate::json_io::{Json, Map};
use crate::state::ThreadState;

mod fields;
mod shapes;
use fields::allowed_fields;
pub use shapes::shape_valid;

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
    crate::facts::convert(input).ok_or_else(|| "invalid adapter fact data".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn input_fact_ids_fit_the_first_512_utf16_units() {
        let state = crate::state::create_thread_state(
            "thread".to_owned(),
            None,
            crate::state::CoreConfig {
                provider: "codex".to_owned(),
                silence_ms: 30_000.0,
                liveness: None,
            },
        )
        .expect("empty thread");
        for (field, kind) in [
            ("nativeInputId", "input.admitted"),
            ("commandId", "input.admitted"),
            ("nativeInputIds", "input.consumed"),
        ] {
            for length in [256, 257] {
                let id = "😀".repeat(length);
                let mut fact = Map::new();
                fact.insert("nativeInputId", Json::from("input"));
                fact.insert(
                    field,
                    if field == "nativeInputIds" {
                        ace_json::json!([id])
                    } else {
                        Json::from(id)
                    },
                );
                assert_eq!(
                    shape_valid(&state, &fact, kind, 0),
                    Ok(length == 256),
                    "{field}"
                );
            }
        }
    }

    #[test]
    fn turn_permission_mode_and_moved_names_count_code_points() {
        let state = crate::state::create_thread_state(
            "thread".to_owned(),
            None,
            crate::state::CoreConfig {
                provider: "codex".to_owned(),
                silence_ms: 30_000.0,
                liveness: None,
            },
        )
        .expect("empty thread");
        for length in [4096, 4097] {
            let fact = ace_json::json!({
                "type":"turn.started", "trigger":"user", "permissionMode":"😀".repeat(length)
            });
            assert_eq!(
                shape_valid(&state, fact.as_object().expect("object"), "turn.started", 0),
                Ok(length == 4096),
                "permissionMode"
            );
        }
        for length in [256, 257] {
            let fact = ace_json::json!({
                "type":"thread.moved",
                "to":{"hostId":"h","name":"😀".repeat(length),"threadId":"t"}
            });
            assert_eq!(
                shape_valid(&state, fact.as_object().expect("object"), "thread.moved", 0),
                Ok(length == 256),
                "moved name"
            );
        }
    }
}
