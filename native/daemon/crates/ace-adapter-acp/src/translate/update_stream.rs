// SPDX-License-Identifier: Apache-2.0
//! Streaming message chunks and usage (part of `translator.ts` `update`).

use crate::translate::data::{object, raw, string};
use crate::translate::state::TranslationState;
use crate::translate::tool_raw::retain_tool_raw;
use crate::translate::tools::todos;
use crate::translate::update::{plan_update, waits_on_background_child};
use serde_json::{Map, Value};

/// Handle message chunks, plan tool refreshes and usage updates.
/// Returns true when the frame is handled, false for usage (which also notes).
pub fn handle_stream(
    state: &mut TranslationState,
    agent_key: &str,
    update: &Value,
    frame: &Value,
    facts: &mut Vec<Value>,
) -> Option<bool> {
    let update_map = object(update);
    let kind = string(update_map.get("sessionUpdate").unwrap_or(&Value::Null)).to_owned();
    if [
        "agent_message_chunk",
        "agent_thought_chunk",
        "user_message_chunk",
    ]
    .contains(&kind.as_str())
    {
        // User echo while the prompt is open retains raw only.
        let input_key = if agent_key == state.root.key {
            state.root.input_key.clone()
        } else {
            state
                .agents
                .values()
                .find(|agent| agent.key == *agent_key)
                .and_then(|agent| agent.input_key.clone())
        };
        if kind == "user_message_chunk" && input_key.is_some() && state.prompt_open {
            let mut draft = Map::with_capacity(3);
            draft.insert("type".to_owned(), Value::String("message".to_owned()));
            draft.insert("role".to_owned(), Value::String("user".to_owned()));
            draft.insert(
                "raw".to_owned(),
                Value::Array(vec![raw(frame, "session/update", None)]),
            );
            let mut fact = Map::with_capacity(4);
            fact.insert(
                "type".to_owned(),
                Value::String("item.reconciled".to_owned()),
            );
            fact.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
            fact.insert(
                "item".to_owned(),
                Value::String(input_key.unwrap_or_default()),
            );
            fact.insert("draft".to_owned(), Value::Object(draft));
            facts.push(Value::Object(fact));
            return Some(true);
        }
        let content = object(update_map.get("content").unwrap_or(&Value::Null)).clone();
        if kind == "agent_message_chunk"
            && agent_key == state.root.key
            && state.root_cancelled
            && content.get("type").and_then(Value::as_str) == Some("text")
            && state
                .quirks
                .cancel_notice(string(content.get("text").unwrap_or(&Value::Null)))
        {
            state.notice(facts, frame, "session/update", None, Some(agent_key));
            return Some(true);
        }
        let suspended = if agent_key == state.root.key {
            state.root.suspended
        } else {
            state
                .agents
                .values()
                .find(|agent| agent.key == *agent_key)
                .is_some_and(|agent| agent.suspended)
        };
        let active = if agent_key == state.root.key {
            state.root.active
        } else {
            state
                .agents
                .values()
                .find(|agent| agent.key == *agent_key)
                .is_some_and(|agent| agent.active)
        };
        let is_root = agent_key == state.root.key;
        if !suspended
            && kind != "user_message_chunk"
            && (agent_key != state.root.key || state.prompt_open || active)
        {
            let trigger = if is_root { "unknown" } else { "spawn" };
            state.start(agent_key, facts, trigger);
        }
        if content.get("type").and_then(Value::as_str) != Some("text") {
            state.finish_stream(agent_key, facts);
        }
        // Switch streams when the kind changes.
        let needs_switch = {
            let current = if agent_key == state.root.key {
                state.root.stream.clone()
            } else {
                state
                    .agents
                    .values()
                    .find(|agent| agent.key == *agent_key)
                    .and_then(|agent| agent.stream.clone())
            };
            current.as_ref().is_none_or(|stream| stream.kind != kind)
        };
        if needs_switch {
            state.finish_stream(agent_key, facts);
            let stream_key = state.key("stream");
            let stream = crate::translate::state::StreamState {
                key: stream_key,
                kind: kind.clone(),
            };
            if agent_key == state.root.key {
                state.root.stream = Some(stream);
            } else if let Some(agent) = state
                .agents
                .values_mut()
                .find(|agent| agent.key == *agent_key)
            {
                agent.stream = Some(stream);
            }
        }
        let stream = if agent_key == state.root.key {
            state.root.stream.clone()
        } else {
            state
                .agents
                .values()
                .find(|agent| agent.key == *agent_key)
                .and_then(|agent| agent.stream.clone())
        };
        let Some(stream) = stream else {
            return Some(false);
        };
        let thought = kind == "agent_thought_chunk";
        // item.upsert for the stream.
        {
            let mut draft = Map::with_capacity(4);
            if thought {
                draft.insert("type".to_owned(), Value::String("reasoning".to_owned()));
                draft.insert(
                    "raw".to_owned(),
                    Value::Array(vec![raw(frame, "session/update", None)]),
                );
                draft.insert("complete".to_owned(), Value::Bool(false));
                // Order: type, raw, complete (as TS literal order).
                let mut ordered = Map::with_capacity(3);
                ordered.insert("type".to_owned(), Value::String("reasoning".to_owned()));
                ordered.insert(
                    "raw".to_owned(),
                    Value::Array(vec![raw(frame, "session/update", None)]),
                );
                ordered.insert("complete".to_owned(), Value::Bool(false));
                let mut fact = Map::with_capacity(4);
                fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
                fact.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
                fact.insert("item".to_owned(), Value::String(stream.key.clone()));
                fact.insert("draft".to_owned(), Value::Object(ordered));
                facts.push(Value::Object(fact));
                let _ = draft;
            } else {
                let mut ordered = Map::with_capacity(5);
                ordered.insert("type".to_owned(), Value::String("message".to_owned()));
                ordered.insert(
                    "role".to_owned(),
                    Value::String(
                        if kind == "user_message_chunk" {
                            "user"
                        } else {
                            "assistant"
                        }
                        .to_owned(),
                    ),
                );
                if content.get("type").and_then(Value::as_str) != Some("text") {
                    let parts =
                        crate::translate::content::decode_content(&Value::Object(content.clone()));
                    if !parts.is_empty() {
                        ordered.insert("parts".to_owned(), Value::Array(parts));
                    }
                }
                ordered.insert(
                    "raw".to_owned(),
                    Value::Array(vec![raw(frame, "session/update", None)]),
                );
                ordered.insert("complete".to_owned(), Value::Bool(false));
                let mut fact = Map::with_capacity(4);
                fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
                fact.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
                fact.insert("item".to_owned(), Value::String(stream.key.clone()));
                fact.insert("draft".to_owned(), Value::Object(ordered));
                facts.push(Value::Object(fact));
            }
        }
        if content.get("type").and_then(Value::as_str) == Some("text") {
            let text = string(content.get("text").unwrap_or(&Value::Null)).to_owned();
            let mut delta = Map::with_capacity(5);
            delta.insert("type".to_owned(), Value::String("item.delta".to_owned()));
            delta.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
            delta.insert("item".to_owned(), Value::String(stream.key.clone()));
            delta.insert(
                "field".to_owned(),
                Value::String(if thought { "reasoning" } else { "text" }.to_owned()),
            );
            delta.insert("append".to_owned(), Value::String(text.clone()));
            facts.push(Value::Object(delta));
            if !thought && kind != "user_message_chunk" {
                let append_len = text.len().min(8192);
                // Segment is capped at 8192 chars in TypeScript (slice by chars).
                let to_add: String = text.chars().take(append_len).collect();
                // Respect the 8192 cap.
                if agent_key == state.root.key {
                    let remaining = 8192usize.saturating_sub(state.root.segment.len());
                    let add: String = to_add.chars().take(remaining).collect();
                    state.root.segment.push_str(&add);
                } else if let Some(agent) = state
                    .agents
                    .values_mut()
                    .find(|agent| agent.key == *agent_key)
                {
                    let remaining = 8192usize.saturating_sub(agent.segment.len());
                    let add: String = to_add.chars().take(remaining).collect();
                    agent.segment.push_str(&add);
                }
            }
        }
        if agent_key == state.root.key
            && kind == "agent_message_chunk"
            && state.root.active
            && waits_on_background_child(state, agent_key)
        {
            state.end(agent_key, facts, "completed", None);
            state.root.suspended = true;
        }
        return Some(true);
    }
    // Plan tool refresh.
    let plan_tool_key = if agent_key == state.root.key {
        state.root.plan_tool_key.clone()
    } else {
        state
            .agents
            .values()
            .find(|agent| agent.key == *agent_key)
            .and_then(|agent| agent.plan_tool_key.clone())
    };
    if kind == "plan" {
        if let Some(plan_tool) = plan_tool_key {
            let payload = raw(frame, "session/update", None);
            let update_clone = update.clone();
            if let Some(tool) = state.tools.get_mut(&plan_tool) {
                let mut owned = tool.clone();
                retain_tool_raw(&mut owned, payload, &update_clone);
                *tool = owned;
            }
            if let Some(tool) = state.tools.get(&plan_tool) {
                let mut detail = Map::with_capacity(2);
                detail.insert("kind".to_owned(), Value::String("plan".to_owned()));
                detail.insert(
                    "todos".to_owned(),
                    Value::Array(todos(update_map.get("entries").unwrap_or(&Value::Null))),
                );
                let mut call = Map::with_capacity(2);
                call.insert("detail".to_owned(), Value::Object(detail));
                call.insert("raw".to_owned(), Value::Array(tool.raw.clone()));
                let mut draft = Map::with_capacity(2);
                draft.insert("type".to_owned(), Value::String("tool_call".to_owned()));
                draft.insert("call".to_owned(), Value::Object(call));
                let mut fact = Map::with_capacity(4);
                fact.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
                fact.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
                fact.insert("item".to_owned(), Value::String(tool.key.clone()));
                fact.insert("draft".to_owned(), Value::Object(draft));
                facts.push(Value::Object(fact));
            }
            return Some(true);
        }
        let input_key = if agent_key == state.root.key {
            state.root.input_key.clone()
        } else {
            state
                .agents
                .values()
                .find(|agent| agent.key == *agent_key)
                .and_then(|agent| agent.input_key.clone())
        };
        plan_update(state, agent_key, input_key, update, frame, facts);
        return Some(true);
    }
    if kind == "usage_update" {
        let usage = object(update_map.get("usage").unwrap_or(&Value::Null));
        let input = usage.get("inputTokens");
        let output = usage.get("outputTokens");
        let valid = matches!(input, Some(Value::Number(number)) if number.as_i64().is_some_and(|n| n >= 0))
            && matches!(output, Some(Value::Number(number)) if number.as_i64().is_some_and(|n| n >= 0));
        if valid {
            let mut fact = Map::with_capacity(4);
            fact.insert("type".to_owned(), Value::String("usage".to_owned()));
            fact.insert("agent".to_owned(), Value::String(agent_key.to_owned()));
            fact.insert(
                "inputTokens".to_owned(),
                input.cloned().unwrap_or(Value::Null),
            );
            fact.insert(
                "outputTokens".to_owned(),
                output.cloned().unwrap_or(Value::Null),
            );
            facts.push(Value::Object(fact));
        }
        return Some(false);
    }
    None
}
