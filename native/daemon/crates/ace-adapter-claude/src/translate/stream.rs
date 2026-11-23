// SPDX-License-Identifier: Apache-2.0
//! Streaming message deltas (the port of `content.ts`: `stream`, `finishStream`).

use ace_json::{Map, Value};
use std::collections::HashMap;

use super::blocks::{BlockSlot, StreamState};
use super::drafts::{activity, part_text, upsert};
use super::json::{number, object, str_of};
use super::state::ClaudeState;

pub fn stream(state: &mut ClaudeState, data: &Value, streams: &mut HashMap<String, StreamState>) {
    let agent = state.agent_for(data);
    let event = object(object(data).get("event").unwrap_or(&Value::Null));
    let kind = str_of(event.get("type").unwrap_or(&Value::Null));
    if kind == "message_start" {
        let id = str_of(
            object(event.get("message").unwrap_or(&Value::Null))
                .get("id")
                .unwrap_or(&Value::Null),
        );
        streams.insert(
            agent,
            StreamState {
                id,
                blocks: std::collections::BTreeMap::new(),
                unmatched: std::collections::HashMap::new(),
                cursors: std::collections::HashMap::new(),
            },
        );
        return;
    }
    let current = match streams.get_mut(&agent) {
        Some(c) => c,
        None => return,
    };
    let index = number(event.get("index").unwrap_or(&Value::Null)) as i64;
    let item = state.key("message", &format!("{agent}:{0}:{index}", current.id));
    if kind == "content_block_start" {
        let block = object(event.get("content_block").unwrap_or(&Value::Null));
        let block_kind = str_of(block.get("type").unwrap_or(&Value::Null));
        state.content_seen.insert(agent.clone());
        current.blocks.insert(
            index,
            BlockSlot {
                kind: block_kind.clone(),
                item: item.clone(),
            },
        );
        current
            .unmatched
            .entry(block_kind.clone())
            .or_default()
            .push(index);
        if block_kind == "text" || block_kind == "thinking" {
            let keep = {
                let item_clone = item.clone();
                let agent_clone = agent.clone();
                state.keep_raw(&item_clone, data, &agent_clone, None)
            };
            state.emit(stream_start_upsert(
                &agent,
                &item,
                &block_kind,
                block,
                state.terminal_children.contains(&agent),
                keep,
            ));
            state.emit(activity(
                &agent,
                if block_kind == "text" {
                    "responding"
                } else {
                    "thinking"
                },
                None,
            ));
        }
    } else if kind == "content_block_delta" {
        let slot = match current.blocks.get(&index) {
            Some(s) => s.clone(),
            None => return,
        };
        let delta = object(event.get("delta").unwrap_or(&Value::Null));
        if slot.kind == "text" || slot.kind == "thinking" {
            let append = {
                let t = str_of(delta.get("text").unwrap_or(&Value::Null));
                if !t.is_empty() {
                    t
                } else {
                    str_of(delta.get("thinking").unwrap_or(&Value::Null))
                }
            };
            state.emit(stream_delta(&agent, &slot.item, &slot.kind, &append));
        }
    } else if kind == "content_block_stop" {
        let slot = match current.blocks.get(&index) {
            Some(s) => s.clone(),
            None => return,
        };
        if slot.kind == "text" || slot.kind == "thinking" {
            state.emit(stream_stop_upsert(&agent, &slot.item, &slot.kind));
        }
    }
}

fn stream_start_upsert(
    agent: &str,
    item: &str,
    kind: &str,
    block: &Map,
    settled: bool,
    keep: Value,
) -> Value {
    let mut draft = Map::with_capacity(7);
    if kind == "text" {
        draft.insert("type".to_owned(), Value::from("message".to_owned()));
        draft.insert("role".to_owned(), Value::from("assistant".to_owned()));
        draft.insert(
            "parts".to_owned(),
            Value::from(vec![part_text(
                block.get("text").and_then(|v| v.as_str()).unwrap_or(""),
            )]),
        );
    } else {
        draft.insert("type".to_owned(), Value::from("reasoning".to_owned()));
        draft.insert(
            "text".to_owned(),
            Value::from(
                block
                    .get("thinking")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
            ),
        );
    }
    draft.insert("complete".to_owned(), Value::Bool(settled));
    if let Value::Object(extra) = keep {
        for (k, v) in extra {
            draft.insert(k, v);
        }
    }
    // Order: type, role?, parts?/text?, complete, raw?.
    let mut ordered = Map::with_capacity(draft.len());
    for key in ["type", "role", "parts", "text", "complete", "raw"] {
        if let Some(v) = draft.remove(key) {
            ordered.insert(key.to_owned(), v);
        }
    }
    upsert(agent, item, Value::Object(ordered))
}

fn stream_delta(agent: &str, item: &str, kind: &str, append: &str) -> Value {
    let mut map = Map::with_capacity(5);
    map.insert("type".to_owned(), Value::from("item.delta".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    map.insert("item".to_owned(), Value::from(item.to_owned()));
    map.insert(
        "field".to_owned(),
        Value::from(if kind == "text" { "text" } else { "reasoning" }.to_owned()),
    );
    map.insert("append".to_owned(), Value::from(append.to_owned()));
    Value::Object(map)
}

fn stream_stop_upsert(agent: &str, item: &str, kind: &str) -> Value {
    let mut draft = Map::with_capacity(2);
    draft.insert(
        "type".to_owned(),
        Value::from(
            if kind == "text" {
                "message"
            } else {
                "reasoning"
            }
            .to_owned(),
        ),
    );
    draft.insert("complete".to_owned(), Value::Bool(true));
    upsert(agent, item, Value::Object(draft))
}

pub fn finish_stream(
    state: &mut ClaudeState,
    streams: &mut HashMap<String, StreamState>,
    agent: &str,
) {
    let current = streams.remove(agent);
    let blocks = match current {
        Some(c) => c.blocks.into_values().collect::<Vec<_>>(),
        None => return,
    };
    for slot in blocks {
        if slot.kind == "text" || slot.kind == "thinking" {
            state.emit(stream_stop_upsert(agent, &slot.item, &slot.kind));
        }
    }
}
