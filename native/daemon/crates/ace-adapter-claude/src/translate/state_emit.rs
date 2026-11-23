// SPDX-License-Identifier: Apache-2.0
//! Small state fact shapes (split from `state.rs`).

use serde_json::{Map, Value};

use super::state::ChildIdentity;

pub(crate) fn fact_type(kind: &str, fill: impl FnOnce(&mut Map<String, Value>)) -> Value {
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::String(kind.to_owned()));
    fill(&mut map);
    Value::Object(map)
}

pub(crate) fn agent_seen(root: &str, session: &str, cwd: &str) -> Value {
    let mut native = Map::new();
    native.insert("provider".to_owned(), Value::String("claude".to_owned()));
    native.insert("nativeId".to_owned(), Value::String(session.to_owned()));
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::String("agent.seen".to_owned()));
    map.insert("agent".to_owned(), Value::String(root.to_owned()));
    map.insert("origin".to_owned(), Value::String("root".to_owned()));
    map.insert("fidelity".to_owned(), Value::String("full".to_owned()));
    map.insert("native".to_owned(), Value::Object(native));
    map.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    Value::Object(map)
}

pub(crate) fn turn_started(agent: &str, turn_id: &str, trigger: &str) -> Value {
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::String("turn.started".to_owned()));
    map.insert("agent".to_owned(), Value::String(agent.to_owned()));
    map.insert("nativeTurnId".to_owned(), Value::String(turn_id.to_owned()));
    map.insert("trigger".to_owned(), Value::String(trigger.to_owned()));
    Value::Object(map)
}

pub(crate) fn child_seen(
    agent: &str,
    owner: &str,
    spawned_by: &str,
    cwd: &str,
    background: bool,
    native: &str,
    identity: &ChildIdentity,
) -> Value {
    let mut native_map = Map::new();
    native_map.insert("provider".to_owned(), Value::String("claude".to_owned()));
    native_map.insert("nativeId".to_owned(), Value::String(native.to_owned()));
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::String("agent.seen".to_owned()));
    map.insert("agent".to_owned(), Value::String(agent.to_owned()));
    map.insert("parent".to_owned(), Value::String(owner.to_owned()));
    map.insert("spawnedBy".to_owned(), Value::String(spawned_by.to_owned()));
    map.insert(
        "origin".to_owned(),
        Value::String("provider_subagent".to_owned()),
    );
    map.insert("fidelity".to_owned(), Value::String("full".to_owned()));
    map.insert("native".to_owned(), Value::Object(native_map));
    map.insert("cwd".to_owned(), Value::String(cwd.to_owned()));
    map.insert("background".to_owned(), Value::Bool(background));
    if let Some(name) = &identity.name
        && !name.is_empty()
    {
        map.insert("name".to_owned(), Value::String(name.clone()));
    }
    if let Some(role) = &identity.role
        && !role.is_empty()
    {
        map.insert("role".to_owned(), Value::String(role.clone()));
    }
    Value::Object(map)
}

pub(crate) fn wake_expected(root: &str, until: i64) -> Value {
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::String("wake.expected".to_owned()));
    map.insert("agent".to_owned(), Value::String(root.to_owned()));
    map.insert("until".to_owned(), Value::Number(until.into()));
    Value::Object(map)
}

pub(crate) fn notice_item(
    agent: &str,
    item: &str,
    level: &str,
    text: &str,
    payload: Value,
) -> Value {
    let mut draft = Map::new();
    draft.insert("type".to_owned(), Value::String("notice".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(true));
    draft.insert("level".to_owned(), Value::String(level.to_owned()));
    draft.insert("text".to_owned(), Value::String(text.to_owned()));
    draft.insert("raw".to_owned(), Value::Array(vec![payload]));
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
    map.insert("agent".to_owned(), Value::String(agent.to_owned()));
    map.insert("item".to_owned(), Value::String(item.to_owned()));
    map.insert("draft".to_owned(), Value::Object(draft));
    Value::Object(map)
}

pub(crate) fn child_turn_ended(child: &str, outcome: &str) -> Value {
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::String("turn.ended".to_owned()));
    map.insert("agent".to_owned(), Value::String(child.to_owned()));
    map.insert("trigger".to_owned(), Value::String("spawn".to_owned()));
    map.insert("outcome".to_owned(), Value::String(outcome.to_owned()));
    Value::Object(map)
}

pub(crate) fn child_turn_failed(child: &str, message: &str) -> Value {
    let mut error = Map::new();
    error.insert("kind".to_owned(), Value::String("provider".to_owned()));
    error.insert("message".to_owned(), Value::String(message.to_owned()));
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::String("turn.ended".to_owned()));
    map.insert("agent".to_owned(), Value::String(child.to_owned()));
    map.insert("trigger".to_owned(), Value::String("spawn".to_owned()));
    map.insert("outcome".to_owned(), Value::String("failed".to_owned()));
    map.insert("error".to_owned(), Value::Object(error));
    Value::Object(map)
}
