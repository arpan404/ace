// SPDX-License-Identifier: Apache-2.0
//! Native queue correlation (the port of `native-queue.ts`).
//! UUID receipts describe only main-thread sends. Never infer task
//! completion from them.

use ace_json::{Map, Value};
use std::collections::{HashSet, VecDeque};

use super::frame::FrameView;
use super::json::{list, object, str_of};
use super::state::ClaudeState;

pub struct NativeQueue {
    sent: HashSet<String>,
    sent_order: VecDeque<String>,
    survivors: HashSet<String>,
    interrupts: HashSet<String>,
    interrupt_order: VecDeque<String>,
    receipt_supported: Option<bool>,
    overflow: bool,
}

impl NativeQueue {
    pub fn new() -> Self {
        NativeQueue {
            sent: HashSet::new(),
            sent_order: VecDeque::new(),
            survivors: HashSet::new(),
            interrupts: HashSet::new(),
            interrupt_order: VecDeque::new(),
            receipt_supported: None,
            overflow: false,
        }
    }

    pub fn observe(&mut self, state: &mut ClaudeState, frame: &FrameView<'_>) {
        let obj = object(frame.data);
        let kind = obj.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if kind == "system" && str_of(obj.get("subtype").unwrap_or(&Value::Null)) == "init" {
            let caps = list(obj.get("capabilities").unwrap_or(&Value::Null));
            let supported = caps
                .iter()
                .any(|v| v.as_str() == Some("interrupt_receipt_v1"));
            self.receipt_supported = Some(supported);
            if !supported {
                self.sent.clear();
                self.sent_order.clear();
                self.retire_overflow(state);
            }
        }
        if frame.dir == "send"
            && kind == "user"
            && self.receipt_supported != Some(false)
            && let Some(Value::String(uuid)) = obj.get("uuid")
            && !uuid.is_empty()
        {
            if self.sent.insert(String::from(uuid.clone())) {
                self.sent_order.push_back(String::from(uuid.clone()));
            }
            if self.sent.len() > 256 {
                if let Some(oldest) = self.sent_order.pop_front() {
                    self.sent.remove(&oldest);
                }
                if !self.overflow {
                    self.overflow = true;
                    let root = state.root.clone();
                    let task = state.key("queue-correlation", "overflow");
                    state.emit(queue_overflow(&root, &task));
                }
            }
        }
        if kind == "control_request"
            && frame.dir == "send"
            && object(obj.get("request").unwrap_or(&Value::Null))
                .get("subtype")
                .and_then(|v| v.as_str())
                == Some("interrupt")
            && let Some(Value::String(id)) = obj.get("request_id")
        {
            if self.interrupts.len() >= 64
                && let Some(oldest) = self.interrupt_order.pop_front()
            {
                self.interrupts.remove(&oldest);
            }
            if self.interrupts.insert(String::from(id.clone())) {
                self.interrupt_order.push_back(String::from(id.clone()));
            }
        }
        if kind == "control_response" && frame.dir == "recv" {
            let response = object(obj.get("response").unwrap_or(&Value::Null));
            if let Some(Value::String(request_id)) = response.get("request_id")
                && self.interrupts.remove(request_id.as_str())
            {
                self.interrupt_order.retain(|id| id != request_id);
                if self.receipt_supported.unwrap_or(false)
                    && let Some(still) = parse_receipt(response.get("response"))
                {
                    self.survivors.clear();
                    for uuid in still {
                        if self.sent.contains(&uuid) {
                            self.survivors.insert(uuid);
                        }
                    }
                    let count = self.survivors.len() as i64;
                    self.publish(state, count);
                }
            }
        }
        if kind == "result" && frame.dir == "recv" {
            let mut consumed_survivor = false;
            let mut uuids: Vec<String> = Vec::new();
            for v in list(obj.get("user_message_uuids").unwrap_or(&Value::Null)) {
                if let Value::String(s) = v {
                    uuids.push(String::from(s.clone()));
                }
            }
            if let Some(Value::String(s)) = obj.get("user_message_uuid") {
                uuids.push(String::from(s.clone()));
            }
            for uuid in uuids {
                self.sent.remove(&uuid);
                self.sent_order.retain(|id| id != &uuid);
                if self.survivors.remove(&uuid) {
                    consumed_survivor = true;
                }
            }
            match obj.get("queued_turn_count") {
                Some(Value::Number(n)) => {
                    if let Some(queued) = n.as_i64() {
                        if queued >= 0 {
                            if queued == 0 {
                                self.sent.clear();
                                self.sent_order.clear();
                                self.survivors.clear();
                                self.retire_overflow(state);
                            }
                            let count = (queued as usize).max(self.survivors.len()) as i64;
                            self.publish(state, count);
                        } else if consumed_survivor || !self.survivors.is_empty() {
                            self.publish(state, self.survivors.len() as i64);
                        }
                    } else if consumed_survivor || !self.survivors.is_empty() {
                        self.publish(state, self.survivors.len() as i64);
                    }
                }
                _ => {
                    if consumed_survivor || !self.survivors.is_empty() {
                        self.publish(state, self.survivors.len() as i64);
                    }
                }
            }
        }
    }

    fn retire_overflow(&mut self, state: &mut ClaudeState) {
        if !self.overflow {
            return;
        }
        self.overflow = false;
        let task = state.key("queue-correlation", "overflow");
        state.emit(queue_overflow_ended(&task));
    }

    fn publish(&mut self, state: &mut ClaudeState, count: i64) {
        if state.native_queued == count {
            return;
        }
        state.native_queued = count;
        let root = state.root.clone();
        state.emit(queue_changed(&root, count));
    }
}

impl Default for NativeQueue {
    fn default() -> Self {
        Self::new()
    }
}

fn parse_receipt(response: Option<&Value>) -> Option<Vec<String>> {
    let obj = object(response.unwrap_or(&Value::Null));
    let still = obj.get("still_queued")?;
    let items = match still {
        Value::Array(items) => items,
        _ => return None,
    };
    if items.len() > 4096 {
        return None;
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        match item {
            Value::String(s) => out.push(s.to_string()),
            _ => return None,
        }
    }
    Some(out)
}

fn queue_overflow(root: &str, task: &str) -> Value {
    let mut map = Map::with_capacity(7);
    map.insert(
        "type".to_owned(),
        Value::from("background.started".to_owned()),
    );
    map.insert("agent".to_owned(), Value::from(root.to_owned()));
    map.insert("task".to_owned(), Value::from(task.to_owned()));
    map.insert("kind".to_owned(), Value::from("other".to_owned()));
    map.insert(
        "title".to_owned(),
        Value::from("Queued work correlation".to_owned()),
    );
    map.insert("internal".to_owned(), Value::Bool(true));
    map.insert("stoppable".to_owned(), Value::Bool(false));
    Value::Object(map)
}

fn queue_overflow_ended(task: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert(
        "type".to_owned(),
        Value::from("background.ended".to_owned()),
    );
    map.insert("task".to_owned(), Value::from(task.to_owned()));
    map.insert("status".to_owned(), Value::from("completed".to_owned()));
    Value::Object(map)
}

fn queue_changed(root: &str, count: i64) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("type".to_owned(), Value::from("queue.changed".to_owned()));
    map.insert("count".to_owned(), Value::Number(count.into()));
    map.insert("source".to_owned(), Value::from("provider".to_owned()));
    // Key order in the TypeScript emit is { type, agent?... }: check
    // translator: `state.emit({ type: "queue.changed", count, source: "provider" })`
    // has no agent. Keep insertion order type, count, source.
    let _ = root;
    Value::Object(map)
}
