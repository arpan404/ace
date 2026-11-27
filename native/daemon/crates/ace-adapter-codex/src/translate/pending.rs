// SPDX-License-Identifier: Apache-2.0
//! Pending turn completions, correlating partial streams without deciding
//! that an unidentified end is current.

use std::collections::HashMap;

use ace_json::Value;
use indexmap::IndexMap;

use super::helpers::{obj_map, str_empty};

struct Request {
    native: String,
    observed_turn: Option<String>,
}

struct Buffer {
    task: String,
    frames: IndexMap<String, BufferedFrame>,
    bytes: usize,
    overflow: bool,
}

struct BufferedFrame {
    params: Value,
    bytes: usize,
}

pub struct PendingCompletions {
    requests: HashMap<ace_json::JsString, Request>,
    buffers: HashMap<String, Buffer>,
}

pub struct HoldResult {
    pub task: String,
    pub first: bool,
    pub overflow: bool,
}

pub struct ResolveResult {
    pub native: String,
    pub task: String,
    pub current: Option<Value>,
    pub historical: Vec<Value>,
    pub settled: bool,
}

impl PendingCompletions {
    pub fn new() -> Self {
        Self {
            requests: HashMap::new(),
            buffers: HashMap::new(),
        }
    }

    pub fn open(&mut self, key: ace_json::JsString, native: String, observed_turn: Option<String>) {
        self.requests.insert(
            key,
            Request {
                native,
                observed_turn,
            },
        );
    }

    pub fn has(&self, native: &str, turn: &str) -> bool {
        self.buffers
            .get(native)
            .is_some_and(|buffer| buffer.frames.contains_key(turn))
    }

    pub fn hold(
        &mut self,
        native: &str,
        params: &Value,
        latest_turn: Option<&str>,
    ) -> Option<HoldResult> {
        let turn_map = obj_map(params).get("turn").map(obj_map);
        let turn = str_empty(turn_map.and_then(|m| m.get("id"))).to_owned();
        if turn.is_empty() {
            return None;
        }
        let buffered = self
            .buffers
            .get(native)
            .is_some_and(|buffer| buffer.frames.contains_key(&turn));
        let correlated = self.requests.values().any(|request| {
            request.native == native
                && (request.observed_turn.as_deref() == latest_turn || buffered)
        });
        if !correlated {
            return None;
        }
        let first = !self.buffers.contains_key(native);
        let task_name = format!("codex:turn-correlation:{native}");
        let buffer = self
            .buffers
            .entry(native.to_owned())
            .or_insert_with(|| Buffer {
                task: task_name,
                frames: IndexMap::new(),
                bytes: 0,
                overflow: false,
            });
        if buffer.overflow || buffer.frames.contains_key(&turn) {
            return Some(HoldResult {
                task: buffer.task.clone(),
                first,
                overflow: false,
            });
        }
        let bytes = ace_json::to_string(params).len();
        let overflow = buffer.bytes + bytes > 2 * 1024 * 1024 || buffer.frames.len() >= 128;
        if overflow {
            buffer.frames.clear();
            buffer.bytes = 0;
            buffer.overflow = true;
        } else {
            buffer.bytes += bytes;
            buffer.frames.insert(
                turn,
                BufferedFrame {
                    params: params.clone(),
                    bytes,
                },
            );
        }
        Some(HoldResult {
            task: buffer.task.clone(),
            first,
            overflow,
        })
    }

    pub fn resolve(
        &mut self,
        key: &ace_json::JsString,
        acknowledged: Option<&str>,
        latest_turn: Option<&str>,
    ) -> Option<ResolveResult> {
        let request = self.requests.remove(key)?;
        let ack = match acknowledged {
            Some(ack) if !ack.is_empty() => ack.to_owned(),
            _ => return self.resolve_without_match(request.native),
        };
        let should_match =
            request.observed_turn.as_deref() == latest_turn || latest_turn == Some(ack.as_str());
        if !should_match {
            return self.resolve_without_match(request.native);
        }
        let (task, overflow, current) = {
            let buffer = self.buffers.get_mut(&request.native)?;
            let frame = buffer.frames.shift_remove(&ack);
            match frame {
                Some(frame) => {
                    buffer.bytes = buffer.bytes.saturating_sub(frame.bytes);
                    (buffer.task.clone(), buffer.overflow, Some(frame.params))
                }
                None => (buffer.task.clone(), buffer.overflow, None),
            }
        };
        self.finish_resolve(request.native, task, overflow, current)
    }

    fn resolve_without_match(&mut self, native: String) -> Option<ResolveResult> {
        let (task, overflow) = {
            let buffer = self.buffers.get(&native)?;
            (buffer.task.clone(), buffer.overflow)
        };
        self.finish_resolve(native, task, overflow, None)
    }

    fn finish_resolve(
        &mut self,
        native: String,
        task: String,
        overflow: bool,
        current: Option<Value>,
    ) -> Option<ResolveResult> {
        let pending = self.requests.values().any(|entry| entry.native == native);
        let historical = if pending {
            Vec::new()
        } else {
            match self.buffers.get(&native) {
                Some(buffer) => buffer
                    .frames
                    .values()
                    .map(|entry| entry.params.clone())
                    .collect(),
                None => Vec::new(),
            }
        };
        let settled = !pending && !overflow;
        if !pending {
            if overflow {
                if let Some(buffer) = self.buffers.get_mut(&native) {
                    buffer.frames.clear();
                    buffer.bytes = 0;
                }
            } else {
                self.buffers.remove(&native);
            }
        }
        Some(ResolveResult {
            native,
            task,
            current,
            historical,
            settled,
        })
    }
}

impl Default for PendingCompletions {
    fn default() -> Self {
        Self::new()
    }
}
