// SPDX-License-Identifier: Apache-2.0
//! Turn bookkeeping on translator state (split from `state.rs`).

use super::state::ADAPTER_WARNING;
use serde_json::{Map, Value};

use super::json::{get, object, raw, raw_named};
use super::state::{ClaudeState, NativeTask};

impl ClaudeState {
    pub fn expect_wake(&mut self, now: i64, task: Option<&NativeTask>) {
        if task
            .map(|t| object(&t.data).get("ambient") == Some(&Value::Bool(true)))
            .unwrap_or(false)
        {
            return;
        }
        let trigger = task
            .and_then(|t| t.child.clone())
            .map(|_| "subagent_result".to_owned())
            .or_else(|| self.wake.clone())
            .unwrap_or_else(|| "background_completion".to_owned());
        self.wake = Some(if task.and_then(|t| t.child.clone()).is_some() {
            "subagent_result".to_owned()
        } else {
            trigger
        });
        if self.active.contains(&self.root.clone()) {
            self.wake_during_turn = true;
        } else {
            self.wake_until = Some(now + 5_000);
            let root = self.root.clone();
            let until = self.wake_until.unwrap_or(0);
            self.emit(super::state_emit::wake_expected(&root, until));
        }
    }

    pub fn warn(&mut self, event: &str, data: Value) {
        let mut obj = match data {
            Value::Object(map) => map,
            _ => Map::new(),
        };
        obj.insert("event".to_owned(), Value::String(event.to_owned()));
        let mut map = Map::with_capacity(2);
        map.insert("type".to_owned(), Value::String(ADAPTER_WARNING.to_owned()));
        map.insert("data".to_owned(), Value::Object(obj));
        self.diagnostics.push(Value::Object(map));
    }

    pub fn notice(
        &mut self,
        data: &Value,
        id: &str,
        agent: &str,
        level: &str,
        message: Option<&str>,
    ) {
        match message {
            None => {
                self.diagnostics.push(raw(data));
            }
            Some(text) => {
                let item = self.key("raw", id);
                let agent_owned = agent.to_owned();
                let payload = raw(data);
                self.emit(super::state_emit::notice_item(
                    &agent_owned,
                    &item,
                    level,
                    text,
                    payload,
                ));
            }
        }
    }

    pub fn settled_item(&self, agent: &str, item: &str) -> bool {
        self.terminal_children.contains(agent)
            && self
                .raw_items
                .get(agent)
                .map(|set| set.contains(item))
                .unwrap_or(false)
    }

    pub fn keep_raw(&mut self, item: &str, data: &Value, agent: &str, name: Option<&str>) -> Value {
        let entry = self.raw_items.entry(agent.to_owned()).or_default();
        if entry.contains(item) {
            return Value::Null;
        }
        entry.insert(item.to_owned());
        let payload = match name {
            Some(n) => raw_named(data, Some(n)),
            None => raw(data),
        };
        let mut map = Map::with_capacity(1);
        map.insert("raw".to_owned(), Value::Array(vec![payload]));
        Value::Object(map)
    }

    pub fn keep_tool_raw(&mut self, id: &str, data: &Value, name: Option<&str>) -> Value {
        let owner = self
            .tool_owners
            .get(id)
            .cloned()
            .unwrap_or_else(|| self.root.clone());
        let item = self.key("tool", id);
        self.keep_raw(&item, data, &owner, name)
    }

    pub fn keep_message_raw(&mut self, item: &str, data: &Value, agent: &str) -> Value {
        self.keep_raw(item, data, agent, None)
    }

    pub fn release_turn(&mut self) {
        self.raw_items.remove(&self.root.clone());
        self.errors.remove(&self.root.clone());
    }

    pub fn end_child(&mut self, task: &NativeTask, status: &str) {
        let child = match &task.child {
            Some(child) => child.clone(),
            None => return,
        };
        let already = self.terminal_children.contains(&child);
        self.terminal_children.insert(child.clone());
        self.content_seen.remove(&child);
        self.errors.remove(&child);
        if !self.active.remove(&child) && already {
            return;
        }
        let outcome = match status {
            "completed" => "completed",
            "failed" => "failed",
            _ => "interrupted",
        };
        if status == "failed" {
            let detail = object(get(&task.data, "patch"));
            let message = detail
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("Claude task failed");
            self.emit(super::state_emit::child_turn_failed(&child, message));
        } else {
            self.emit(super::state_emit::child_turn_ended(&child, outcome));
        }
    }
}
