// SPDX-License-Identifier: Apache-2.0
//! Deferred subagent transcripts (the port of `pending-transcripts.ts`).
//! Child frames that name a spawn this process has not registered yet wait
//! for the binding; a conservative placeholder task keeps the thread from
//! reading done.

use serde_json::Value;
use std::collections::{HashMap, HashSet};

use super::frame::{FrameView, OwnedFrame};
use super::json::{list, object, str_of};
use super::state::ClaudeState;

pub const UNBOUND_GRACE_MS: i64 = 10_000;
const MAX_BYTES: usize = 4 * 1024 * 1024;

pub(crate) struct Deferred {
    pub(crate) frames: Vec<OwnedFrame>,
    pub(crate) bytes: usize,
    pub(crate) agent: String,
    pub(crate) task: Option<String>,
    pub(crate) until: Option<i64>,
}

pub(crate) struct Overflow {
    pub(crate) task: String,
    pub(crate) until: Option<i64>,
}

pub struct PendingTranscripts {
    pub(crate) frames: HashMap<String, Deferred>,
    pub(crate) tool_spawns: HashMap<String, String>,
    pub(crate) spawn_tools: HashMap<String, HashSet<String>>,
    pub(crate) bytes: usize,
    pub(crate) count: usize,
    pub(crate) overflow: Option<Overflow>,
}

impl PendingTranscripts {
    pub fn new() -> Self {
        PendingTranscripts {
            frames: HashMap::new(),
            tool_spawns: HashMap::new(),
            spawn_tools: HashMap::new(),
            bytes: 0,
            count: 0,
            overflow: None,
        }
    }

    pub fn defer(&mut self, state: &mut ClaudeState, frame: &FrameView<'_>, now: i64) -> bool {
        let data = object(frame.data);
        let message = object(data.get("message").unwrap_or(&Value::Null));
        let contents = list(message.get("content").unwrap_or(&Value::Null));
        let mut result_spawn: Option<String> = None;
        if str_of(data.get("type").unwrap_or(&Value::Null)) == "user" {
            for value in contents {
                let block = object(value);
                if str_of(block.get("type").unwrap_or(&Value::Null)) == "tool_result" {
                    let id = str_of(block.get("tool_use_id").unwrap_or(&Value::Null));
                    if let Some(spawn) = self.tool_spawns.get(&id)
                        && !spawn.is_empty()
                    {
                        result_spawn = Some(spawn.clone());
                        break;
                    }
                }
            }
        }
        let parent = str_of(data.get("parent_tool_use_id").unwrap_or(&Value::Null));
        let spawn = if !parent.is_empty() {
            parent
        } else {
            result_spawn.unwrap_or_default()
        };
        if frame.channel != "sdk"
            || spawn.is_empty()
            || state.children.contains_key(&spawn)
            || !matches!(
                str_of(data.get("type").unwrap_or(&Value::Null)).as_str(),
                "assistant" | "user" | "stream_event"
            )
        {
            return false;
        }
        let agent = str_of(data.get("agent_id").unwrap_or(&Value::Null));
        let has_entry = self.frames.contains_key(&spawn);
        let known = if agent.is_empty() {
            None
        } else {
            state.native_agents.get(&agent).cloned()
        };
        if known.is_some() && !has_entry {
            if let Some(target) = known {
                state.bind_child(&spawn, &target);
            }
            return false;
        }
        let root = state.root.clone();
        state.notice(
            frame.data,
            &format!("unbound:{0}", frame.seq),
            &root,
            "info",
            None,
        );
        if self.overflow.is_some() {
            if let Some(flow) = self.overflow.as_mut()
                && flow.until.is_some()
            {
                flow.until = Some(now + UNBOUND_GRACE_MS);
            }
            return true;
        }
        let bytes = match frame.payload_bytes {
            Some(b) => b,
            None => serde_json::to_string(frame.data)
                .map(|s| s.len())
                .unwrap_or(0),
        };
        let new_spawn = !has_entry;
        if self.bytes + bytes > MAX_BYTES
            || self.count >= 256
            || (new_spawn && self.frames.len() >= 128)
        {
            super::pending_tasks::overflowed(self, state, now);
            return true;
        }
        for value in contents {
            let block = object(value);
            if str_of(block.get("type").unwrap_or(&Value::Null)) != "tool_use" {
                continue;
            }
            let id = str_of(block.get("id").unwrap_or(&Value::Null));
            if id.is_empty() {
                continue;
            }
            self.tool_spawns.insert(id.clone(), spawn.clone());
            self.spawn_tools
                .entry(spawn.clone())
                .or_default()
                .insert(id);
        }
        self.bytes += bytes;
        self.count += 1;
        let entry = self
            .frames
            .entry(spawn.clone())
            .or_insert_with(|| Deferred {
                frames: Vec::new(),
                bytes: 0,
                agent: String::new(),
                task: None,
                until: None,
            });
        entry.frames.push(OwnedFrame {
            seq: frame.seq,
            dir: frame.dir.to_owned(),
            channel: frame.channel.to_owned(),
            data: (*frame.data).clone(),
            payload_bytes: frame.payload_bytes,
        });
        entry.bytes += bytes;
        if entry.agent.is_empty() {
            entry.agent = agent.clone();
        }
        if known.is_some()
            && let Some(target) = known
        {
            state.bind_child(&spawn, &target);
        }
        // Re-borrow for open after the pushes above.
        if let Some(entry) = self.frames.get_mut(&spawn) {
            super::pending_tasks::open_entry(state, entry, &spawn, now);
        }
        true
    }

    /// Children registered by now take the deferred frames that name task.
    pub fn bind_registered(&mut self, state: &mut ClaudeState) {
        let spawns: Vec<String> = self.frames.keys().cloned().collect();
        for spawn in spawns {
            if state.children.contains_key(&spawn) {
                continue;
            }
            let agent = match self.frames.get(&spawn) {
                Some(entry) => entry.agent.clone(),
                None => continue,
            };
            if agent.is_empty() {
                continue;
            }
            if let Some(target) = state.native_agents.get(&agent).cloned() {
                state.bind_child(&spawn, &target);
            }
        }
    }

    pub fn take(&mut self, state: &mut ClaudeState, spawn: &str) -> Vec<OwnedFrame> {
        let entry = match self.frames.remove(spawn) {
            Some(entry) => entry,
            None => return Vec::new(),
        };
        super::pending_tasks::drop_tools(self, spawn, &entry);
        super::pending_tasks::end_owned(state, &entry, "completed");
        entry.frames
    }

    /// Facts about a frame that was not deferred: the spawning call's result,
    /// or the end of the spawn's task, means nothing is left to wait for.
    pub fn observe(&mut self, state: &mut ClaudeState, data: &Value) {
        if self.frames.is_empty() {
            return;
        }
        let obj = object(data);
        if str_of(obj.get("type").unwrap_or(&Value::Null)) == "user" {
            let message = object(obj.get("message").unwrap_or(&Value::Null));
            for value in list(message.get("content").unwrap_or(&Value::Null)) {
                let block = object(value);
                if str_of(block.get("type").unwrap_or(&Value::Null)) != "tool_result" {
                    continue;
                }
                let id = str_of(block.get("tool_use_id").unwrap_or(&Value::Null));
                // The spawning call completed: the placeholder ends, but the
                // deferred frames stay for the binding that may still come.
                if let Some(entry) = self.frames.get_mut(&id) {
                    super::pending_tasks::end_entry(state, entry, "stopped");
                }
            }
        }
        if str_of(obj.get("type").unwrap_or(&Value::Null)) == "system"
            && str_of(obj.get("subtype").unwrap_or(&Value::Null)) == "task_notification"
        {
            let spawn = str_of(obj.get("tool_use_id").unwrap_or(&Value::Null));
            if let Some(entry) = self.frames.remove(&spawn) {
                super::pending_tasks::drop_tools(self, &spawn, &entry);
                super::pending_tasks::end_owned(state, &entry, "stopped");
            }
        }
    }

    /// The root's turn ended: unbound children have a grace period left.
    pub fn turn_ended(&mut self, now: i64) {
        for entry in self.frames.values_mut() {
            if entry.task.is_some() {
                entry.until = Some(now + UNBOUND_GRACE_MS);
            }
        }
        if let Some(flow) = self.overflow.as_mut() {
            flow.until = Some(now + UNBOUND_GRACE_MS);
        }
    }

    pub fn next_deadline(&self) -> Option<i64> {
        let mut next = self.overflow.as_ref().and_then(|flow| flow.until);
        for entry in self.frames.values() {
            if entry.task.is_some()
                && let Some(until) = entry.until
            {
                next = Some(next.map(|n| n.min(until)).unwrap_or(until));
            }
        }
        next
    }

    pub fn expire(&mut self, state: &mut ClaudeState, now: i64) {
        // Placeholders whose grace ran out end, but their frames stay for a
        // binding that may still come; only the overflow drops its budget.
        for entry in self.frames.values_mut() {
            if entry.task.is_some() && entry.until.map(|u| u <= now).unwrap_or(false) {
                super::pending_tasks::end_entry(state, entry, "stopped");
            }
        }
        if self
            .overflow
            .as_ref()
            .and_then(|flow| flow.until)
            .map(|u| u <= now)
            .unwrap_or(false)
            && let Some(flow) = self.overflow.take()
        {
            state.emit(super::pending_tasks::background_ended(
                &flow.task, "stopped",
            ));
        }
    }

    /// The provider process is gone or replaced: no placeholder can be live.
    pub fn close(&mut self, state: &mut ClaudeState) {
        for entry in self.frames.values() {
            super::pending_tasks::end_owned(state, entry, "stopped");
        }
        if let Some(flow) = self.overflow.take() {
            state.emit(super::pending_tasks::background_ended(
                &flow.task, "stopped",
            ));
        }
        self.frames.clear();
        self.tool_spawns.clear();
        self.spawn_tools.clear();
        self.bytes = 0;
        self.count = 0;
    }
}

impl Default for PendingTranscripts {
    fn default() -> Self {
        Self::new()
    }
}
