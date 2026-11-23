// SPDX-License-Identifier: Apache-2.0
//! Status values from the long-thread index, validated as they are read.

use super::common::{LongError, invalid, js_len};
use serde_json::Value as Json;

fn known_state(state: &str) -> bool {
    matches!(
        state,
        "needs_you"
            | "working"
            | "waiting"
            | "limited"
            | "failed"
            | "unresponsive"
            | "moved"
            | "done"
            | "new"
            | "unknown"
    )
}

/// `ThreadStatus`, with an unknown state kept as `unknown` and its raw body.
pub fn parse_thread_status(text: &str) -> Result<Json, LongError> {
    let value: Json = serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
    let state = value
        .get("state")
        .and_then(|state| state.as_str())
        .ok_or_else(|| invalid("invalid index row"))?;
    if state.is_empty() || js_len(state) > 64 {
        return Err(invalid("invalid index row"));
    }
    if known_state(state) {
        return parse_known_thread_status(&value);
    }
    let mut raw = serde_json::Map::new();
    if let Json::Object(object) = value {
        for (key, val) in object {
            raw.insert(key, val);
        }
    }
    let mut out = serde_json::Map::new();
    out.insert("state".to_owned(), Json::String("unknown".to_owned()));
    out.insert("raw".to_owned(), Json::Object(raw));
    Ok(Json::Object(out))
}

fn parse_known_thread_status(value: &Json) -> Result<Json, LongError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("invalid index row"))?;
    let state = object
        .get("state")
        .and_then(|state| state.as_str())
        .ok_or_else(|| invalid("invalid index row"))?;
    let mut out = serde_json::Map::new();
    out.insert("state".to_owned(), Json::String(state.to_owned()));
    match state {
        "needs_you" => {
            let interactions = object
                .get("interactions")
                .and_then(|value| value.as_i64())
                .ok_or_else(|| invalid("invalid index row"))?;
            if interactions < 1 {
                return Err(invalid("invalid index row"));
            }
            out.insert("interactions".to_owned(), Json::Number(interactions.into()));
        }
        "working" => {
            let agents = object
                .get("agents")
                .and_then(|value| value.as_i64())
                .ok_or_else(|| invalid("invalid index row"))?;
            if agents < 1 {
                return Err(invalid("invalid index row"));
            }
            out.insert("agents".to_owned(), Json::Number(agents.into()));
        }
        "waiting" => {
            let on = object
                .get("on")
                .and_then(|value| value.as_str())
                .ok_or_else(|| invalid("invalid index row"))?;
            if !matches!(
                on,
                "background_task" | "rate_limit" | "network" | "upstream" | "queue"
            ) {
                return Err(invalid("invalid index row"));
            }
            out.insert("on".to_owned(), Json::String(on.to_owned()));
        }
        "limited" => {
            if let Some(until) = object.get("until") {
                let n = until.as_i64().ok_or_else(|| invalid("invalid index row"))?;
                if n < 0 {
                    return Err(invalid("invalid index row"));
                }
                out.insert("until".to_owned(), Json::Number(n.into()));
            }
        }
        "failed" | "unresponsive" | "done" | "new" => {}
        "unknown" => {
            if object.get("raw").is_none() {
                return Err(invalid("invalid index row"));
            }
            if let Some(raw) = object.get("raw") {
                out.insert("raw".to_owned(), raw.clone());
            }
        }
        "moved" => {
            let to = object
                .get("to")
                .ok_or_else(|| invalid("invalid index row"))?;
            out.insert("to".to_owned(), to.clone());
        }
        _ => return Err(invalid("invalid index row")),
    }
    Ok(Json::Object(out))
}

/// `AgentStatus`, with unknown fields stripped. An unknown state fails the read.
pub fn parse_agent_status(text: &str) -> Result<Json, LongError> {
    let value: Json = serde_json::from_str(text).map_err(|_| invalid("invalid index row"))?;
    let object = value
        .as_object()
        .ok_or_else(|| invalid("invalid index row"))?;
    let state = object
        .get("state")
        .and_then(|state| state.as_str())
        .ok_or_else(|| invalid("invalid index row"))?;
    let mut out = serde_json::Map::new();
    out.insert("state".to_owned(), Json::String(state.to_owned()));
    match state {
        "starting" => {}
        "working" => {
            if let Some(activity) = object.get("activity") {
                let activity = activity
                    .as_str()
                    .ok_or_else(|| invalid("invalid index row"))?;
                if !matches!(
                    activity,
                    "thinking"
                        | "responding"
                        | "tool"
                        | "compacting"
                        | "retrying"
                        | "starting_turn"
                ) {
                    return Err(invalid("invalid index row"));
                }
                out.insert("activity".to_owned(), Json::String(activity.to_owned()));
            } else {
                return Err(invalid("invalid index row"));
            }
            if let Some(item) = object.get("itemId") {
                let id = item.as_str().ok_or_else(|| invalid("invalid index row"))?;
                if id.is_empty() {
                    return Err(invalid("invalid index row"));
                }
                out.insert("itemId".to_owned(), Json::String(id.to_owned()));
            }
            if let Some(detail) = object.get("detail") {
                if !detail.is_string() {
                    return Err(invalid("invalid index row"));
                }
                out.insert("detail".to_owned(), detail.clone());
            }
        }
        "blocked" => {
            let on = object
                .get("on")
                .and_then(|on| on.as_str())
                .ok_or_else(|| invalid("invalid index row"))?;
            if !matches!(
                on,
                "human"
                    | "subagents"
                    | "queue"
                    | "background_task"
                    | "rate_limit"
                    | "network"
                    | "upstream"
            ) {
                return Err(invalid("invalid index row"));
            }
            out.insert("on".to_owned(), Json::String(on.to_owned()));
            if let Some(refs) = object.get("refs") {
                out.insert("refs".to_owned(), refs.clone());
            } else {
                out.insert("refs".to_owned(), Json::Array(Vec::new()));
            }
            if let Some(until) = object.get("until") {
                let n = until.as_i64().ok_or_else(|| invalid("invalid index row"))?;
                if n < 0 {
                    return Err(invalid("invalid index row"));
                }
                out.insert("until".to_owned(), Json::Number(n.into()));
            }
            if let Some(attempt) = object.get("attempt") {
                let n = attempt
                    .as_i64()
                    .ok_or_else(|| invalid("invalid index row"))?;
                if n < 1 {
                    return Err(invalid("invalid index row"));
                }
                out.insert("attempt".to_owned(), Json::Number(n.into()));
            }
            if let Some(message) = object.get("message") {
                if !message.is_string() {
                    return Err(invalid("invalid index row"));
                }
                out.insert("message".to_owned(), message.clone());
            }
        }
        "idle" | "interrupted" => {}
        "failed" => {
            if object.get("error").is_none() {
                return Err(invalid("invalid index row"));
            }
            if let Some(error) = object.get("error") {
                out.insert("error".to_owned(), error.clone());
            }
        }
        "unresponsive" => {
            let at = object
                .get("lastSignalAt")
                .and_then(|value| value.as_i64())
                .ok_or_else(|| invalid("invalid index row"))?;
            if at < 0 {
                return Err(invalid("invalid index row"));
            }
            out.insert("lastSignalAt".to_owned(), Json::Number(at.into()));
        }
        _ => return Err(invalid("invalid index row")),
    }
    Ok(Json::Object(out))
}

/// An agent's status as the thread list shows it.
pub fn agent_thread_status(status: &Json) -> Result<Json, LongError> {
    let object = status
        .as_object()
        .ok_or_else(|| invalid("invalid index row"))?;
    let state = object
        .get("state")
        .and_then(|state| state.as_str())
        .ok_or_else(|| invalid("invalid index row"))?;
    let mut out = serde_json::Map::new();
    match state {
        "idle" | "interrupted" => {
            out.insert("state".to_owned(), Json::String("done".to_owned()));
        }
        "failed" | "unresponsive" => {
            out.insert("state".to_owned(), Json::String(state.to_owned()));
        }
        "blocked" => {
            let on = object
                .get("on")
                .and_then(|on| on.as_str())
                .ok_or_else(|| invalid("invalid index row"))?;
            match on {
                "human" => {
                    out.insert("state".to_owned(), Json::String("needs_you".to_owned()));
                    out.insert("interactions".to_owned(), Json::Number(1.into()));
                }
                "subagents" => {
                    out.insert("state".to_owned(), Json::String("working".to_owned()));
                    out.insert("agents".to_owned(), Json::Number(1.into()));
                }
                "rate_limit" => {
                    out.insert("state".to_owned(), Json::String("limited".to_owned()));
                    if let Some(until) = object.get("until") {
                        out.insert("until".to_owned(), until.clone());
                    }
                }
                _ => {
                    out.insert("state".to_owned(), Json::String("waiting".to_owned()));
                    out.insert("on".to_owned(), Json::String(on.to_owned()));
                }
            }
        }
        _ => {
            out.insert("state".to_owned(), Json::String("working".to_owned()));
            out.insert("agents".to_owned(), Json::Number(1.into()));
        }
    }
    Ok(Json::Object(out))
}

pub fn status_state(status: &Json) -> &str {
    status
        .as_object()
        .and_then(|object| object.get("state"))
        .and_then(|state| state.as_str())
        .unwrap_or("")
}

/// A newer daemon's state never reads as settled.
pub fn turn_is_settled(status: &Json) -> bool {
    let state = status_state(status);
    state != "working" && state != "unknown"
}

fn counter_number(counters: &super::digests::Counters, key: &str) -> i64 {
    counters.get(key).copied().unwrap_or(0)
}

/// Historical turns combine their own live activity, not a later root turn's status.
pub fn turn_activity_status(
    counters: &super::digests::Counters,
    candidates: &[Json],
) -> Option<Json> {
    let mut interactions = counter_number(counters, "live:interactions");
    for candidate in candidates {
        if status_state(candidate) == "needs_you"
            && let Some(count) = candidate
                .as_object()
                .and_then(|object| object.get("interactions"))
                .and_then(|value| value.as_i64())
        {
            interactions = interactions.max(count);
        }
    }
    if interactions > 0 {
        let mut out = serde_json::Map::new();
        out.insert("state".to_owned(), Json::String("needs_you".to_owned()));
        out.insert("interactions".to_owned(), Json::Number(interactions.into()));
        return Some(Json::Object(out));
    }
    if candidates
        .iter()
        .any(|status| status_state(status) == "working")
    {
        let mut out = serde_json::Map::new();
        out.insert("state".to_owned(), Json::String("working".to_owned()));
        let agents = counter_number(counters, "live:agents").max(1);
        out.insert("agents".to_owned(), Json::Number(agents.into()));
        return Some(Json::Object(out));
    }
    if let Some(limited) = candidates
        .iter()
        .find(|status| status_state(status) == "limited")
    {
        return Some(limited.clone());
    }
    for reason in ["network", "upstream"] {
        if candidates.iter().any(|status| {
            status_state(status) == "waiting"
                && status
                    .as_object()
                    .and_then(|object| object.get("on"))
                    .and_then(|on| on.as_str())
                    == Some(reason)
        }) {
            let mut out = serde_json::Map::new();
            out.insert("state".to_owned(), Json::String("waiting".to_owned()));
            out.insert("on".to_owned(), Json::String(reason.to_owned()));
            return Some(Json::Object(out));
        }
    }
    if counter_number(counters, "live:tasks") > 0
        || counter_number(counters, "live:tools") > 0
        || candidates.iter().any(|status| {
            status_state(status) == "waiting"
                && status
                    .as_object()
                    .and_then(|object| object.get("on"))
                    .and_then(|on| on.as_str())
                    == Some("background_task")
        })
    {
        let mut out = serde_json::Map::new();
        out.insert("state".to_owned(), Json::String("waiting".to_owned()));
        out.insert("on".to_owned(), Json::String("background_task".to_owned()));
        return Some(Json::Object(out));
    }
    if candidates
        .iter()
        .any(|status| status_state(status) == "unresponsive")
    {
        let mut out = serde_json::Map::new();
        out.insert("state".to_owned(), Json::String("unresponsive".to_owned()));
        return Some(Json::Object(out));
    }
    if let Some(waiting) = candidates
        .iter()
        .find(|status| status_state(status) == "waiting")
    {
        return Some(waiting.clone());
    }
    if counter_number(counters, "live:agents") > 0 || counter_number(counters, "live:runs") > 0 {
        let mut out = serde_json::Map::new();
        out.insert("state".to_owned(), Json::String("working".to_owned()));
        let agents = counter_number(counters, "live:agents").max(1);
        out.insert("agents".to_owned(), Json::Number(agents.into()));
        return Some(Json::Object(out));
    }
    None
}
