// SPDX-License-Identifier: Apache-2.0
//! Interaction frames (the port of `translate-interactions.ts`).

use serde_json::{Map, Value};

use super::frame::FrameView;
use super::interactions::request_for;
use super::json::{object, str_of};
use super::raw_facts::canonical_only;
use super::resolution::{parse_elicitation_request, parse_resolution, resolution_for};
use super::state::{ClaudeState, Interaction};

fn resolution_for_elicitation(data: &Value) -> Value {
    match parse_resolution(object(data).get("resolution").unwrap_or(&Value::Null)) {
        Some(parsed) => {
            if str_of(object(&parsed).get("kind").unwrap_or(&Value::Null)) == "elicitation" {
                return parsed;
            }
            elicitation_cancel()
        }
        None => elicitation_cancel(),
    }
}

fn elicitation_cancel() -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("kind".to_owned(), Value::String("elicitation".to_owned()));
    map.insert("action".to_owned(), Value::String("cancel".to_owned()));
    Value::Object(map)
}

fn permission(state: &mut ClaudeState, frame: &FrameView<'_>) {
    let data = frame.data;
    let obj = object(data);
    if frame.dir == "send" {
        let id = str_of(obj.get("requestId").unwrap_or(&Value::Null));
        let interaction = match state.interactions.remove(&id) {
            Some(i) => i,
            None => return,
        };
        state
            .tool_frames
            .insert(interaction.tool_id.clone(), frame.seq);
        let result = object(obj.get("result").unwrap_or(&Value::Null));
        let denied = result.get("behavior").and_then(|v| v.as_str()) == Some("deny");
        if !state.terminal_children.contains(&interaction.agent) {
            let status = if denied {
                if result.get("interrupt") == Some(&Value::Bool(true)) {
                    "cancelled"
                } else {
                    "declined"
                }
            } else {
                "running"
            };
            let mut draft = Map::with_capacity(3);
            draft.insert("type".to_owned(), Value::String("tool_call".to_owned()));
            draft.insert("complete".to_owned(), Value::Bool(denied));
            let mut call_obj = Map::with_capacity(1);
            call_obj.insert("status".to_owned(), Value::String(status.to_owned()));
            draft.insert("call".to_owned(), Value::Object(call_obj));
            state.emit(upsert(
                &interaction.agent,
                &interaction.item,
                Value::Object(draft),
            ));
        }
        let resolution = resolution_for(
            &interaction.request,
            obj.get("result").unwrap_or(&Value::Null),
            obj.get("resolution").unwrap_or(&Value::Null),
        );
        state.emit(closed(
            &state.key("interaction", &id),
            "resolved",
            Some(resolution),
        ));
        return;
    }
    let options = object(obj.get("options").unwrap_or(&Value::Null));
    let id = str_of(options.get("requestId").unwrap_or(&Value::Null));
    if id.is_empty() {
        return;
    }
    let native = str_of(options.get("agentID").unwrap_or(&Value::Null));
    let root = state.root.clone();
    let agent = if native.is_empty() {
        root.clone()
    } else if let Some(known) = state.native_agents.get(&native).cloned() {
        known
    } else {
        let terminal = state
            .tasks
            .get(&native)
            .and_then(|t| t.terminal_status.clone());
        state.child(
            &format!("native:{native}"),
            &root,
            false,
            Some(&native),
            terminal.as_deref(),
            &super::state::ChildIdentity {
                name: None,
                role: None,
            },
        )
    };
    let terminal_snapshot = state.tasks.get(&native).cloned().filter(|t| t.terminal);
    if let Some(snapshot) = terminal_snapshot {
        let status = snapshot
            .terminal_status
            .clone()
            .unwrap_or_else(|| "failed".to_owned());
        if let Some(slot) = state.tasks.get_mut(&native) {
            slot.child = Some(agent.clone());
        }
        let mut ended = snapshot;
        ended.child = Some(agent.clone());
        state.end_child(&ended, &status);
    }
    let tool_id = str_of(options.get("toolUseID").unwrap_or(&Value::Null));
    let tool_id = if tool_id.is_empty() {
        format!("interaction:{id}")
    } else {
        tool_id
    };
    let name = str_of(obj.get("toolName").unwrap_or(&Value::Null));
    let name = if name.is_empty() {
        "Unknown tool".to_owned()
    } else {
        name
    };
    state.tool_frames.insert(tool_id.clone(), frame.seq);
    let start = state.facts.len();
    let input = obj.get("input").unwrap_or(&Value::Null).clone();
    let options_value = Value::Object(options.clone());
    super::content::tool_call(state, &agent, &tool_id, &name, &input, data, true);
    if state.terminal_children.contains(&agent) {
        state.interactions.remove(&id);
        for index in start..state.facts.len() {
            let fact = state.facts[index].clone();
            state.facts[index] = canonical_only(&fact);
        }
        let settled_agent = agent.clone();
        state.notice(
            data,
            &format!("settled-permission:{0}", frame.seq),
            &settled_agent,
            "info",
            Some("Claude permission retired for a settled child"),
        );
        return;
    }
    let request = request_for(&name, &input, &options_value);
    let item = state.key("tool", &tool_id);
    state.interactions.insert(
        id.clone(),
        Interaction {
            agent: agent.clone(),
            item: item.clone(),
            tool_id: tool_id.clone(),
            request: request.clone(),
        },
    );
    state.emit(opened(
        &agent,
        &state.key("interaction", &id),
        &item,
        request,
        data,
        &name,
    ));
}

fn upsert(agent: &str, item: &str, draft: Value) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("type".to_owned(), Value::String("item.upsert".to_owned()));
    map.insert("agent".to_owned(), Value::String(agent.to_owned()));
    map.insert("item".to_owned(), Value::String(item.to_owned()));
    map.insert("draft".to_owned(), draft);
    Value::Object(map)
}

fn closed(interaction: &str, state_name: &str, resolution: Option<Value>) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert(
        "type".to_owned(),
        Value::String("interaction.closed".to_owned()),
    );
    map.insert(
        "interaction".to_owned(),
        Value::String(interaction.to_owned()),
    );
    map.insert("state".to_owned(), Value::String(state_name.to_owned()));
    if let Some(r) = resolution {
        map.insert("resolution".to_owned(), r);
    }
    Value::Object(map)
}

fn opened(
    agent: &str,
    interaction: &str,
    item: &str,
    request: Value,
    data: &Value,
    name: &str,
) -> Value {
    let mut map = Map::with_capacity(7);
    map.insert(
        "type".to_owned(),
        Value::String("interaction.opened".to_owned()),
    );
    map.insert("agent".to_owned(), Value::String(agent.to_owned()));
    map.insert(
        "interaction".to_owned(),
        Value::String(interaction.to_owned()),
    );
    map.insert("item".to_owned(), Value::String(item.to_owned()));
    map.insert("blocking".to_owned(), Value::Bool(true));
    map.insert("request".to_owned(), request);
    let mut raw_item = Map::with_capacity(3);
    raw_item.insert("type".to_owned(), Value::String("can_use_tool".to_owned()));
    raw_item.insert("name".to_owned(), Value::String(name.to_owned()));
    raw_item.insert("data".to_owned(), data.clone());
    map.insert(
        "raw".to_owned(),
        Value::Array(vec![Value::Object(raw_item)]),
    );
    Value::Object(map)
}

/// Route an interaction frame; true when the frame was an interaction.
pub fn interaction_frame(state: &mut ClaudeState, frame: &FrameView<'_>) -> bool {
    let data = frame.data;
    let obj = object(data);
    if frame.channel == "elicitation" {
        let id = str_of(obj.get("requestId").unwrap_or(&Value::Null));
        if frame.dir == "recv" {
            if let Some(request) =
                parse_elicitation_request(obj.get("request").unwrap_or(&Value::Null))
                && !id.is_empty()
                && str_of(object(&request).get("kind").unwrap_or(&Value::Null)) == "elicitation"
            {
                let interaction = state.key("interaction", &id);
                let root = state.root.clone();
                let raw_payload = {
                    let mut m = Map::with_capacity(2);
                    m.insert("type".to_owned(), Value::String("elicitation".to_owned()));
                    m.insert("data".to_owned(), (*frame.data).clone());
                    Value::Object(m)
                };
                state.interactions.insert(
                    id.clone(),
                    Interaction {
                        agent: root.clone(),
                        item: interaction.clone(),
                        tool_id: String::new(),
                        request: request.clone(),
                    },
                );
                state.emit(opened_elicitation(
                    &root,
                    &interaction,
                    request,
                    raw_payload,
                ));
            }
        } else if state.interactions.remove(&id).is_some() {
            let interaction = state.key("interaction", &id);
            state.emit(closed(
                &interaction,
                "resolved",
                Some(resolution_for_elicitation(data)),
            ));
        }
    } else if frame.channel == "interaction_lifecycle" {
        let id = str_of(obj.get("requestId").unwrap_or(&Value::Null));
        if state.interactions.remove(&id).is_some() {
            let state_name = if str_of(obj.get("state").unwrap_or(&Value::Null)) == "expired" {
                "expired"
            } else {
                "cancelled"
            };
            let interaction = state.key("interaction", &id);
            state.emit(closed(&interaction, state_name, None));
        }
    } else if frame.channel == "can_use_tool" {
        permission(state, frame);
    } else {
        return false;
    }
    true
}

fn opened_elicitation(root: &str, interaction: &str, request: Value, payload: Value) -> Value {
    let mut map = Map::with_capacity(6);
    map.insert(
        "type".to_owned(),
        Value::String("interaction.opened".to_owned()),
    );
    map.insert("agent".to_owned(), Value::String(root.to_owned()));
    map.insert(
        "interaction".to_owned(),
        Value::String(interaction.to_owned()),
    );
    map.insert("blocking".to_owned(), Value::Bool(true));
    map.insert("request".to_owned(), request);
    map.insert("raw".to_owned(), Value::Array(vec![payload]));
    Value::Object(map)
}
