// SPDX-License-Identifier: Apache-2.0
//! Small fact shapes the SDK dispatcher emits (split from `translate.rs`).

use ace_json::{Map, Value};

use super::json::object;
use super::token_counts::token_counts;

pub(crate) fn model_answered(data: &Value) -> bool {
    match token_counts(object(data).get("usage").unwrap_or(&Value::Null)) {
        Some(usage) => usage.input_tokens + usage.output_tokens > 0,
        None => false,
    }
}

pub(crate) fn signal(agent: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type".to_owned(), Value::from("signal".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    Value::Object(map)
}

pub(crate) fn tick_fact() -> Value {
    let mut map = Map::with_capacity(1);
    map.insert("type".to_owned(), Value::from("tick".to_owned()));
    Value::Object(map)
}

pub(crate) fn title_upsert(root: &str, summary: &str) -> Value {
    let mut draft = Map::with_capacity(6);
    draft.insert("type".to_owned(), Value::from("notice".to_owned()));
    draft.insert("code".to_owned(), Value::from("thread_title".to_owned()));
    draft.insert("title".to_owned(), Value::from(summary.to_owned()));
    draft.insert("text".to_owned(), Value::from(summary.to_owned()));
    draft.insert("level".to_owned(), Value::from("info".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(true));
    let mut map = Map::with_capacity(4);
    map.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("item".to_owned(), Value::from("provider:title".to_owned()));
    map.insert("draft".to_owned(), Value::Object(draft));
    Value::Object(map)
}

pub(crate) fn agent_linked(root: &str, model: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from("agent.linked".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("model".to_owned(), Value::from(model.to_owned()));
    Value::Object(map)
}

pub(crate) fn activity(root: &str, name: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from("activity".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("activity".to_owned(), Value::from(name.to_owned()));
    Value::Object(map)
}

pub(crate) fn retry(root: &str, on: &str, message: &str, attempt: Option<i64>) -> Value {
    let mut map = Map::with_capacity(5);
    map.insert("type".to_owned(), Value::from("retry".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("on".to_owned(), Value::from(on.to_owned()));
    map.insert("message".to_owned(), Value::from(message.to_owned()));
    if let Some(a) = attempt {
        map.insert("attempt".to_owned(), Value::Number(a.into()));
    }
    Value::Object(map)
}

pub(crate) fn retry_cleared(root: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type".to_owned(), Value::from("retry.cleared".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    Value::Object(map)
}

pub(crate) fn process_exited(deliberate: bool, message: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from("process.exited".to_owned()));
    map.insert("deliberate".to_owned(), Value::Bool(deliberate));
    map.insert("message".to_owned(), Value::from(message.to_owned()));
    Value::Object(map)
}

pub(crate) fn goal_updated(root: &str, goal: Value) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from("goal.updated".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("goal".to_owned(), goal);
    Value::Object(map)
}

pub(crate) fn goal_cleared(root: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from("goal.updated".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("goal".to_owned(), Value::Null);
    Value::Object(map)
}

pub(crate) fn wake_expected(root: &str, until: i64) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from("wake.expected".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("until".to_owned(), Value::Number(until.into()));
    Value::Object(map)
}

pub(crate) fn ended_error(error: Option<&Value>, result: &str) -> Value {
    let mut map = Map::new();
    if let Some(err) = error {
        for (k, v) in object(err) {
            map.insert(k.clone(), v.clone());
        }
    }
    let kind = map
        .get("kind")
        .and_then(|v| v.as_str())
        .unwrap_or("provider")
        .to_owned();
    let message = map
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_owned();
    let message = if message.is_empty() {
        if result.is_empty() {
            "Claude execution failed".to_owned()
        } else {
            result.to_owned()
        }
    } else {
        message
    };
    // Rebuild in first-seen order: spread error first, then kind,
    // message, details. Overwrites keep their original position.
    let mut ordered = Map::with_capacity(map.len() + 2);
    for (k, v) in map {
        ordered.insert(k, v);
    }
    ordered.insert("kind".to_owned(), Value::from(kind));
    ordered.insert("message".to_owned(), Value::from(message));
    Value::Object(ordered)
}

pub(crate) fn turn_ended(root: &str, outcome: &str, trigger: &str, error: Option<Value>) -> Value {
    let mut map = Map::with_capacity(5);
    map.insert("type".to_owned(), Value::from("turn.ended".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("outcome".to_owned(), Value::from(outcome.to_owned()));
    map.insert("trigger".to_owned(), Value::from(trigger.to_owned()));
    if let Some(e) = error {
        map.insert("error".to_owned(), e);
    }
    Value::Object(map)
}

pub(crate) fn interaction_closed(
    interaction: &str,
    state: &str,
    resolution: Option<Value>,
) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert(
        "type".to_owned(),
        Value::from("interaction.closed".to_owned()),
    );
    map.insert(
        "interaction".to_owned(),
        Value::from(interaction.to_owned()),
    );
    map.insert("state".to_owned(), Value::from(state.to_owned()));
    if let Some(r) = resolution {
        map.insert("resolution".to_owned(), r);
    }
    Value::Object(map)
}
