// SPDX-License-Identifier: Apache-2.0
//! Consumed input correlation (the port of `consumed-inputs.ts`).
//! Claude stamps each main-thread reply frame with the client uuids of
//! every user message the frame's turn has consumed so far.

use ace_json::Value;
use std::collections::{HashSet, VecDeque};

use super::frame::FrameView;
use super::json::{list, object};
use super::state::ClaudeState;

pub struct ConsumedInputs {
    reported: HashSet<String>,
    order: VecDeque<String>,
}

impl ConsumedInputs {
    pub fn new() -> Self {
        ConsumedInputs {
            reported: HashSet::new(),
            order: VecDeque::new(),
        }
    }

    pub fn observe(&mut self, state: &mut ClaudeState, frame: &FrameView<'_>) {
        if frame.channel != "sdk" || frame.dir != "recv" {
            return;
        }
        let obj = object(frame.data);
        let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind != "assistant" && kind != "stream_event" {
            return;
        }
        let parent = obj
            .get("parent_tool_use_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !parent.is_empty() {
            return;
        }
        let root = state.root.clone();
        if !state.active.contains(&root) {
            return;
        }
        let uuids = list(obj.get("user_message_uuids").unwrap_or(&Value::Null));
        let mut fresh: Vec<String> = Vec::new();
        if uuids.is_empty() {
            if let Some(Value::String(single)) = obj.get("user_message_uuid")
                && !single.is_empty()
                && single.len() <= 512
                && !self.reported.contains(single.as_str())
            {
                fresh.push(String::from(single.clone()));
            }
        } else {
            for uuid in uuids {
                if let Value::String(s) = uuid
                    && !s.is_empty()
                    && s.len() <= 512
                    && !self.reported.contains(s.as_str())
                {
                    fresh.push(String::from(s.clone()));
                }
            }
        }
        if fresh.is_empty() {
            return;
        }
        for uuid in &fresh {
            if self.reported.len() >= 256
                && let Some(oldest) = self.order.pop_front()
            {
                self.reported.remove(&oldest);
            }
            if self.reported.insert(uuid.clone()) {
                self.order.push_back(uuid.clone());
            }
        }
        let capped: Vec<String> = fresh.into_iter().take(64).collect();
        state.emit(consumed_fact(&root, &capped));
    }
}

impl Default for ConsumedInputs {
    fn default() -> Self {
        Self::new()
    }
}

fn consumed_fact(root: &str, ids: &[String]) -> Value {
    let mut map = ace_json::Map::with_capacity(3);
    map.insert("type".to_owned(), Value::from("input.consumed".to_owned()));
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert(
        "nativeInputIds".to_owned(),
        Value::Array(ids.iter().map(|s| Value::from(s.clone())).collect()),
    );
    Value::Object(map)
}
