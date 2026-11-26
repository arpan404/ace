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
                && ace_json::utf16_len(single) <= 512
                && !self.reported.contains(single.as_str())
            {
                fresh.push(String::from(single.clone()));
            }
        } else {
            for uuid in uuids {
                if let Value::String(s) = uuid
                    && !s.is_empty()
                    && ace_json::utf16_len(s) <= 512
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

#[cfg(test)]
mod length_tests {
    use super::ConsumedInputs;
    use crate::translate::frame::FrameView;
    use crate::translate::state::ClaudeState;

    fn consumed(uuid: &str) -> Vec<String> {
        let mut state = ClaudeState::new("root");
        state.active.insert("root".to_owned());
        let data = ace_json::json!({"type":"assistant", "user_message_uuid": uuid});
        let frame = FrameView {
            seq: 1,
            dir: "recv",
            channel: "sdk",
            data: &data,
            payload_bytes: None,
        };
        ConsumedInputs::new().observe(&mut state, &frame);
        state
            .facts
            .iter()
            .filter_map(|fact| match fact.pointer("/nativeInputIds") {
                Some(ace_json::Value::Array(ids)) => Some(
                    ids.iter()
                        .filter_map(|id| id.as_str().map(str::to_owned))
                        .collect::<Vec<String>>(),
                ),
                _ => None,
            })
            .flatten()
            .collect()
    }

    #[test]
    fn a_consumed_uuid_counts_utf16_units_like_string_length() {
        // 256 emoji are 512 UTF-16 units: the last uuid that fits.
        assert_eq!(consumed(&"😀".repeat(256)).len(), 1);
        assert!(consumed(&"😀".repeat(257)).is_empty());
        assert!(consumed(&"x".repeat(513)).is_empty());
    }
}
