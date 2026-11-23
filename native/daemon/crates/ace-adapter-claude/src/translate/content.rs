// SPDX-License-Identifier: Apache-2.0
//! Message content (the port of `content.ts`: `tool` and `message`).
//! Streaming lives in `stream.rs`, fact shapes in `drafts.rs`.

use ace_json::{Map, Value};
use std::collections::HashMap;

use super::blocks::{MessageIndex, StreamState, match_block};
use super::drafts::{
    activity, agent_linked, assistant_text_upsert, error_upsert, part_text, reasoning_upsert,
    text_block, tool_output_delta, tool_result_upsert, upsert, user_image_upsert, user_text_upsert,
};
use super::injected_inputs::{child_prompt, injected_input};
use super::json::{list, object, str_of, text};
use super::state::ClaudeState;
use super::tasks::background_output;
use super::tools::tool_detail;
use super::usage::child_usage;

const INTERRUPTIONS: [&str; 2] = [
    "[Request interrupted by user]",
    "[Request interrupted by user for tool use]",
];

/// A tool call block inside a message.
pub fn tool_call(
    state: &mut ClaudeState,
    agent: &str,
    block_id: &str,
    name: &str,
    input: &Value,
    frame_data: &Value,
    awaiting: bool,
) {
    if block_id.is_empty() {
        return;
    }
    let agent_owned = state
        .tool_owners
        .get(block_id)
        .cloned()
        .unwrap_or_else(|| agent.to_owned());
    let agent_ref = agent_owned;
    let settled = state.terminal_children.contains(&agent_ref);
    let item = state.key("tool", block_id);
    let input_obj = object(input);
    // toolDetail takes the input value; rebuild a Value view of the map.
    let input_value = Value::Object(input_obj.clone());
    let detail = tool_detail(name, &input_value);
    let kind = str_of(object(&detail).get("kind").unwrap_or(&Value::Null));
    let settled_item = state.settled_item(&agent_ref, &item);
    state
        .tool_owners
        .insert(block_id.to_owned(), agent_ref.clone());
    state.tool_kinds.insert(block_id.to_owned(), kind.clone());
    let keep = {
        let item_clone = item.clone();
        let agent_clone = agent_ref.clone();
        state.keep_raw(&item_clone, frame_data, &agent_clone, Some(name))
    };
    let mut call = Map::with_capacity(6);
    call.insert("title".to_owned(), Value::from(name.to_owned()));
    call.insert("kind".to_owned(), Value::from(kind));
    if !settled_item {
        let status = if settled {
            "cancelled"
        } else if awaiting {
            "awaiting_approval"
        } else {
            "running"
        };
        call.insert("status".to_owned(), Value::from(status.to_owned()));
    }
    if let Value::Object(detail_map) = detail {
        call.insert("detail".to_owned(), Value::Object(detail_map));
    }
    if let Value::Object(extra) = keep {
        for (k, v) in extra {
            call.insert(k, v);
        }
    }
    // Rebuild call in TypeScript order: title, kind, status?, detail, raw?.
    let mut ordered_call = Map::with_capacity(call.len());
    for key in ["title", "kind", "status", "detail", "raw"] {
        if let Some(v) = call.remove(key) {
            ordered_call.insert(key.to_owned(), v);
        }
    }
    let mut draft = Map::with_capacity(4);
    draft.insert("type".to_owned(), Value::from("tool_call".to_owned()));
    draft.insert("complete".to_owned(), Value::Bool(settled));
    draft.insert("call".to_owned(), Value::Object(ordered_call));
    state.emit(upsert(&agent_ref, &item, Value::Object(draft)));
    state.emit(activity(&agent_ref, "tool", None));
}

pub fn message(
    state: &mut ClaudeState,
    data: &Value,
    seq: i64,
    streams: &mut HashMap<String, StreamState>,
    messages: &mut MessageIndex,
) {
    let agent = state.agent_for(data);
    let obj = object(data);
    let m = object(obj.get("message").unwrap_or(&Value::Null));
    let frame_type = str_of(obj.get("type").unwrap_or(&Value::Null));
    let role = if frame_type == "assistant" {
        "assistant"
    } else {
        "user"
    };
    let model = str_of(m.get("model").unwrap_or(&Value::Null));
    if role == "assistant" && !model.is_empty() && model != "<synthetic>" {
        let agent_clone = agent.clone();
        let model_clone = model.clone();
        state.emit(agent_linked(&agent_clone, &model_clone));
        if agent == state.root {
            state.model = Some(model);
        }
    }
    if role == "assistant" {
        let trigger = state.wake.clone().unwrap_or_else(|| "unknown".to_owned());
        let agent_clone = agent.clone();
        state.start(&agent_clone, &trigger);
    }
    let content: Vec<Value> = match m.get("content") {
        Some(Value::String(s)) => {
            vec![text_block(s)]
        }
        Some(Value::Array(items)) => items.to_vec(),
        _ => Vec::new(),
    };
    if role == "assistant" && !content.is_empty() {
        state.content_seen.insert(agent.clone());
    }
    let id = {
        let mid = str_of(m.get("id").unwrap_or(&Value::Null));
        if !mid.is_empty() {
            mid
        } else {
            let uuid = str_of(obj.get("uuid").unwrap_or(&Value::Null));
            if !uuid.is_empty() {
                uuid
            } else {
                seq.to_string()
            }
        }
    };
    // SDK user envelopes with only images (no tools) keep one user item.
    if role == "user"
        && content
            .iter()
            .any(|v| str_of(object(v).get("type").unwrap_or(&Value::Null)) == "image")
        && !content.iter().any(|v| {
            matches!(
                str_of(object(v).get("type").unwrap_or(&Value::Null)).as_str(),
                "tool_result" | "tool_use"
            )
        })
    {
        let item = state.key("message", &format!("{agent}:{id}:0"));
        let parts: Vec<Value> = content
            .iter()
            .filter(|v| str_of(object(v).get("type").unwrap_or(&Value::Null)) == "text")
            .map(|v| part_text(&str_of(object(v).get("text").unwrap_or(&Value::Null))))
            .collect();
        let keep = {
            let item_clone = item.clone();
            let agent_clone = agent.clone();
            state.keep_raw(&item_clone, data, &agent_clone, None)
        };
        let uuid = str_of(obj.get("uuid").unwrap_or(&Value::Null));
        state.emit(user_image_upsert(&agent, &item, &parts, &uuid, keep));
        return;
    }
    if role == "assistant" {
        let m_value = Value::Object(m.clone());
        child_usage(state, &agent, &id, &m_value);
    }
    if let Some(Value::String(error)) = obj.get("error") {
        let error_code = error.clone();
        let message_text = text(m.get("content").unwrap_or(&Value::Null));
        let mut err =
            super::provider_error::claude_error(&error_code, &message_text, state.model.as_deref());
        // ProviderErrorDetails: {code, provider:"claude", model?}.
        if !error_code.is_empty()
            && error_code.len() <= 256
            && state
                .model
                .as_ref()
                .map(|s| !s.is_empty() && s.len() <= 256)
                .unwrap_or(true)
        {
            let mut details = Map::with_capacity(3);
            details.insert("code".to_owned(), Value::String(error_code.clone()));
            details.insert("provider".to_owned(), Value::from("claude".to_owned()));
            if let Some(model) = &state.model
                && !model.is_empty()
            {
                details.insert("model".to_owned(), Value::from(model.clone()));
            }
            err = super::provider_error::with_details(err, Value::Object(details));
        }
        let item = state.key("error", &id);
        let err_obj = object(&err).clone();
        state.errors.insert(agent.clone(), err);
        state.emit(error_upsert(&agent, &item, &err_obj, data));
        return;
    }
    let user_text: Vec<Value> = content
        .iter()
        .map(object)
        .filter(|block| {
            block.get("type").and_then(|v| v.as_str()) == Some("text")
                && !INTERRUPTIONS
                    .contains(&block.get("text").and_then(|v| v.as_str()).unwrap_or(""))
        })
        .cloned()
        .map(Value::Object)
        .collect();
    if role == "user" && !user_text.is_empty() {
        let parts: Vec<Value> = user_text
            .iter()
            .map(|v| part_text(object(v).get("text").and_then(|t| t.as_str()).unwrap_or("")))
            .collect();
        let joined: String = parts
            .iter()
            .filter_map(|p| object(p).get("text").and_then(|t| t.as_str()))
            .collect();
        let echoed = agent != state.root && child_prompt(state, &agent, &joined);
        let kind = if echoed {
            None
        } else {
            injected_input(state, data, &joined)
        };
        let synthetic =
            !echoed && (kind.is_some() || obj.get("isSynthetic") == Some(&Value::Bool(true)));
        let item = if agent != state.root && !synthetic {
            state.key("prompt", &agent)
        } else {
            state.key("message", &format!("{agent}:{id}:0"))
        };
        let keep = {
            let item_clone = item.clone();
            let agent_clone = agent.clone();
            state.keep_raw(&item_clone, data, &agent_clone, None)
        };
        let uuid = str_of(obj.get("uuid").unwrap_or(&Value::Null));
        state.emit(user_text_upsert(
            &agent,
            &item,
            &parts,
            synthetic,
            kind.as_deref(),
            &uuid,
            keep,
        ));
    }
    // Block loop with the message index and the matching stream.
    let uuid = str_of(obj.get("uuid").unwrap_or(&Value::Null));
    for (index, value) in content.iter().enumerate() {
        let block = object(value).clone();
        let block_value = Value::Object(block.clone());
        let kind = str_of(block.get("type").unwrap_or(&Value::Null));
        let has_stream = streams.get(&agent).map(|s| s.id == id).unwrap_or(false);
        let block_index = if has_stream {
            let stream = streams.get_mut(&agent);
            messages.with_message(&agent, &id, |current| {
                match_block(current, &block_value, index as i64, &uuid, stream)
            })
        } else {
            messages.with_message(&agent, &id, |current| {
                match_block(current, &block_value, index as i64, &uuid, None)
            })
        };
        let message_item = state.key("message", &format!("{agent}:{id}:{block_index}"));
        if kind == "tool_use" {
            let tool_id = str_of(block.get("id").unwrap_or(&Value::Null));
            if tool_id.is_empty() {
                continue;
            }
            if seq < state.tool_frames.get(&tool_id).copied().unwrap_or(-1) {
                continue;
            }
            state.tool_frames.insert(tool_id.clone(), seq);
            let block_input = block.get("input").unwrap_or(&Value::Null).clone();
            let block_name = str_of(block.get("name").unwrap_or(&Value::Null));
            tool_call(
                state,
                &agent,
                &tool_id,
                &block_name,
                &block_input,
                data,
                false,
            );
        } else if kind == "tool_result" {
            let tool_id = str_of(block.get("tool_use_id").unwrap_or(&Value::Null));
            if tool_id.is_empty() {
                continue;
            }
            if seq < state.tool_frames.get(&tool_id).copied().unwrap_or(-1) {
                continue;
            }
            state.tool_frames.insert(tool_id.clone(), seq);
            let owner = state
                .tool_owners
                .get(&tool_id)
                .cloned()
                .unwrap_or_else(|| agent.clone());
            state.tool_owners.insert(tool_id.clone(), owner.clone());
            let item = state.key("tool", &tool_id);
            let declined = list(obj.get("tool_result_meta").unwrap_or(&Value::Null))
                .iter()
                .map(object)
                .any(|meta| {
                    meta.get("id").and_then(|v| v.as_str()) == Some(tool_id.as_str())
                        && meta.get("non_execution_kind").and_then(|v| v.as_str())
                            == Some("permission-rule")
                });
            let keep = {
                let item_clone = item.clone();
                let owner_clone = owner.clone();
                state.keep_raw(&item_clone, data, &owner_clone, None)
            };
            let settled_item = state.settled_item(&owner, &item);
            state.emit(tool_result_upsert(
                &owner,
                &item,
                settled_item,
                declined,
                block.get("is_error") == Some(&Value::Bool(true)),
                keep,
            ));
            let owner_clone = owner.clone();
            state.emit(activity(&owner_clone, "thinking", None));
            let output = text(block.get("content").unwrap_or(&Value::Null));
            if !output.is_empty() {
                background_output(state, data, &output);
            }
            if !output.is_empty()
                && state.tool_kinds.get(&tool_id).map(|s| s.as_str()) == Some("shell")
            {
                state.emit(tool_output_delta(&owner, &item, &output));
            }
        } else if kind == "text" {
            let content_text = str_of(block.get("text").unwrap_or(&Value::Null));
            if role == "user" && INTERRUPTIONS.contains(&content_text.as_str()) {
                let agent_clone = agent.clone();
                state.notice(
                    data,
                    &seq.to_string(),
                    &agent_clone,
                    "info",
                    Some(&content_text),
                );
                continue;
            }
            if role == "user" {
                continue;
            }
            let keep = {
                let item_clone = message_item.clone();
                let agent_clone = agent.clone();
                state.keep_raw(&item_clone, data, &agent_clone, None)
            };
            let single = content.len() == 1;
            let uuid_ok = !uuid.is_empty() && uuid.len() <= 256;
            state.emit(assistant_text_upsert(
                &agent,
                &message_item,
                &content_text,
                single && uuid_ok,
                &uuid,
                keep,
            ));
            let agent_clone = agent.clone();
            state.emit(activity(&agent_clone, "responding", None));
        } else if kind == "thinking" {
            let keep = {
                let item_clone = message_item.clone();
                let agent_clone = agent.clone();
                state.keep_raw(&item_clone, data, &agent_clone, None)
            };
            state.emit(reasoning_upsert(
                &agent,
                &message_item,
                &str_of(block.get("thinking").unwrap_or(&Value::Null)),
                keep,
            ));
        } else {
            let agent_clone = agent.clone();
            state.notice(data, &format!("{seq}:{index}"), &agent_clone, "info", None);
        }
    }
}
