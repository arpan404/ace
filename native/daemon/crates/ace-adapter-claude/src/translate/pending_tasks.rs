// SPDX-License-Identifier: Apache-2.0
//! Deferred placeholder tasks (split from `pending-transcripts.rs`).

use serde_json::{Map, Value};

use super::pending_transcripts::{Deferred, Overflow, PendingTranscripts, UNBOUND_GRACE_MS};
use super::state::ClaudeState;

pub(crate) fn open_entry(state: &mut ClaudeState, entry: &mut Deferred, spawn: &str, now: i64) {
    if entry.task.is_some() {
        if entry.until.is_some() {
            entry.until = Some(now + UNBOUND_GRACE_MS);
        }
        return;
    }
    entry.task = Some(state.key("unbound", spawn));
    entry.until = if state.active.contains(&state.root.clone()) {
        None
    } else {
        Some(now + UNBOUND_GRACE_MS)
    };
    let root = state.root.clone();
    let task = entry.task.clone().unwrap_or_default();
    state.emit(background_started(&root, &task));
}

pub(crate) fn drop_tools(transcripts: &mut PendingTranscripts, spawn: &str, entry: &Deferred) {
    if let Some(tools) = transcripts.spawn_tools.remove(spawn) {
        for tool in tools {
            transcripts.tool_spawns.remove(&tool);
        }
    }
    transcripts.bytes = transcripts.bytes.saturating_sub(entry.bytes);
    transcripts.count = transcripts.count.saturating_sub(entry.frames.len());
}

pub(crate) fn overflowed(transcripts: &mut PendingTranscripts, state: &mut ClaudeState, now: i64) {
    for entry in transcripts.frames.values() {
        end_owned(state, entry, "stopped");
    }
    transcripts.frames.clear();
    transcripts.tool_spawns.clear();
    transcripts.spawn_tools.clear();
    transcripts.bytes = 0;
    transcripts.count = 0;
    let task = state.key("unbound", "overflow");
    let until = if state.active.contains(&state.root.clone()) {
        None
    } else {
        Some(now + UNBOUND_GRACE_MS)
    };
    transcripts.overflow = Some(Overflow {
        task: task.clone(),
        until,
    });
    let root = state.root.clone();
    state.emit(background_overflow(&root, &task));
    state.warn("deferred-transcripts-overflow", overflow_detail());
}

fn background_started(root: &str, task: &str) -> Value {
    let mut map = Map::with_capacity(6);
    map.insert(
        "type".to_owned(),
        Value::String("background.started".to_owned()),
    );
    map.insert("agent".to_owned(), Value::String(root.to_owned()));
    map.insert("task".to_owned(), Value::String(task.to_owned()));
    map.insert("kind".to_owned(), Value::String("subagent".to_owned()));
    map.insert("title".to_owned(), Value::String("Subagent".to_owned()));
    map.insert("stoppable".to_owned(), Value::Bool(false));
    Value::Object(map)
}

pub(crate) fn background_ended(task: &str, status: &str) -> Value {
    let mut map = Map::with_capacity(3);
    map.insert(
        "type".to_owned(),
        Value::String("background.ended".to_owned()),
    );
    map.insert("task".to_owned(), Value::String(task.to_owned()));
    map.insert("status".to_owned(), Value::String(status.to_owned()));
    Value::Object(map)
}

fn background_overflow(root: &str, task: &str) -> Value {
    let mut map = Map::with_capacity(7);
    map.insert(
        "type".to_owned(),
        Value::String("background.started".to_owned()),
    );
    map.insert("agent".to_owned(), Value::String(root.to_owned()));
    map.insert("task".to_owned(), Value::String(task.to_owned()));
    map.insert("kind".to_owned(), Value::String("other".to_owned()));
    map.insert(
        "title".to_owned(),
        Value::String("Unregistered subagent transcripts".to_owned()),
    );
    map.insert("internal".to_owned(), Value::Bool(true));
    map.insert("stoppable".to_owned(), Value::Bool(false));
    Value::Object(map)
}

fn overflow_detail() -> Value {
    let mut map = Map::new();
    map.insert(
        "detail".to_owned(),
        Value::String(
            "Deferred subagent transcripts exceeded their limit and were dropped. Unregistered subagent work holds the thread until the main turn ends and the subagent goes quiet, or the provider session exits."
                .to_owned(),
        ),
    );
    Value::Object(map)
}

pub(crate) fn end_entry(state: &mut ClaudeState, entry: &mut Deferred, status: &str) {
    if let Some(task) = entry.task.take() {
        state.emit(background_ended(&task, status));
    }
    entry.until = None;
}

pub(crate) fn end_owned(state: &mut ClaudeState, entry: &Deferred, status: &str) {
    if let Some(task) = &entry.task {
        state.emit(background_ended(task, status));
    }
}
