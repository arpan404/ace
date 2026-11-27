// SPDX-License-Identifier: Apache-2.0
//! Small state fact shapes (split from `state.rs`).

use ace_json::{Map, Value};

use super::state::ChildIdentity;

pub(crate) fn fact_type(kind: &str, fill: impl FnOnce(&mut Map)) -> Value {
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::from(kind.to_owned()));
    fill(&mut map);
    Value::Object(map)
}

pub(crate) fn agent_seen(root: &str, session: &str, cwd: &str) -> Value {
    let mut native = Map::new();
    native.insert("provider".to_owned(), Value::from("claude".to_owned()));
    native.insert("nativeId".to_owned(), Value::from(session.to_owned()));
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::from("agent.seen".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("origin".to_owned(), Value::from("root".to_owned()));
    map.insert("fidelity".to_owned(), Value::from("full".to_owned()));
    map.insert("native".to_owned(), Value::Object(native));
    map.insert("cwd".to_owned(), Value::from(cwd.to_owned()));
    Value::Object(map)
}

pub(crate) fn turn_started(agent: &str, turn_id: &str, trigger: &str) -> Value {
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::from("turn.started".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    map.insert("nativeTurnId".to_owned(), Value::from(turn_id.to_owned()));
    map.insert("trigger".to_owned(), Value::from(trigger.to_owned()));
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
    native_map.insert("provider".to_owned(), Value::from("claude".to_owned()));
    native_map.insert("nativeId".to_owned(), Value::from(native.to_owned()));
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::from("agent.seen".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    map.insert("parent".to_owned(), Value::from(owner.to_owned()));
    map.insert("spawnedBy".to_owned(), Value::from(spawned_by.to_owned()));
    map.insert(
        "origin".to_owned(),
        Value::from("provider_subagent".to_owned()),
    );
    map.insert("fidelity".to_owned(), Value::from("full".to_owned()));
    map.insert("native".to_owned(), Value::Object(native_map));
    map.insert("cwd".to_owned(), Value::from(cwd.to_owned()));
    map.insert("background".to_owned(), Value::Bool(background));
    if let Some(name) = &identity.name
        && !name.is_empty()
    {
        map.insert("name".to_owned(), Value::from(name.clone()));
    }
    if let Some(role) = &identity.role
        && !role.is_empty()
    {
        map.insert("role".to_owned(), Value::from(role.clone()));
    }
    Value::Object(map)
}

pub(crate) fn wake_expected(root: &str, until: i64) -> Value {
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::from("wake.expected".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
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
    draft.insert("type".to_owned(), Value::from("notice".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(true));
    draft.insert("level".to_owned(), Value::from(level.to_owned()));
    draft.insert("text".to_owned(), Value::from(text.to_owned()));
    draft.insert("raw".to_owned(), Value::from(vec![payload]));
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    map.insert("item".to_owned(), Value::from(item.to_owned()));
    map.insert("draft".to_owned(), Value::Object(draft));
    Value::Object(map)
}

pub(crate) fn child_turn_ended(child: &str, outcome: &str) -> Value {
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::from("turn.ended".to_owned()));
    map.insert("agent".to_owned(), Value::from(child.to_owned()));
    map.insert("trigger".to_owned(), Value::from("spawn".to_owned()));
    map.insert("outcome".to_owned(), Value::from(outcome.to_owned()));
    Value::Object(map)
}

pub(crate) fn child_turn_failed(child: &str, message: &str) -> Value {
    let mut error = Map::new();
    error.insert("kind".to_owned(), Value::from("provider".to_owned()));
    error.insert("message".to_owned(), Value::from(message.to_owned()));
    let mut map = Map::new();
    map.insert("type".to_owned(), Value::from("turn.ended".to_owned()));
    map.insert("agent".to_owned(), Value::from(child.to_owned()));
    map.insert("trigger".to_owned(), Value::from("spawn".to_owned()));
    map.insert("outcome".to_owned(), Value::from("failed".to_owned()));
    map.insert("error".to_owned(), Value::Object(error));
    Value::Object(map)
}
