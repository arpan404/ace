// SPDX-License-Identifier: Apache-2.0
//! Background tasks (the port of `tasks.ts`).
//! A subagent goes by the task Claude was given for it.

use serde_json::{Map, Value};

use super::json::{object, str_of};
use super::state::{ChildIdentity, ClaudeState, NativeTask};

pub(crate) fn register(state: &mut ClaudeState, data: &Value, background: bool) -> String {
    let obj = object(data);
    let id = str_of(obj.get("task_id").unwrap_or(&Value::Null));
    let prior = state.tasks.get(&id).cloned();
    let mut merged = match &prior {
        Some(p) => object(&p.data).clone(),
        None => Map::new(),
    };
    for (k, v) in obj {
        merged.insert(k.clone(), v.clone());
    }
    let merged_value = Value::Object(merged);
    let mobj = object(&merged_value);
    let spawn = str_of(mobj.get("tool_use_id").unwrap_or(&Value::Null));
    let owner = state
        .tool_owners
        .get(&spawn)
        .cloned()
        .or_else(|| prior.as_ref().map(|p| p.owner.clone()))
        .unwrap_or_else(|| state.root.clone());
    let task_type = str_of(mobj.get("task_type").unwrap_or(&Value::Null));
    let child = if task_type == "local_agent" && !spawn.is_empty() {
        let description = str_of(mobj.get("description").unwrap_or(&Value::Null));
        let subagent = str_of(mobj.get("subagent_type").unwrap_or(&Value::Null));
        let name = description.trim().to_owned();
        let role = subagent.trim().to_owned();
        let identity = ChildIdentity {
            name: if name.is_empty() { None } else { Some(name) },
            role: if role.is_empty() { None } else { Some(role) },
        };
        let prior_terminal = prior.as_ref().and_then(|p| p.terminal_status.clone());
        Some(state.child(
            &spawn,
            &owner,
            background,
            Some(&id),
            prior_terminal.as_deref(),
            &identity,
        ))
    } else {
        prior.as_ref().and_then(|p| p.child.clone())
    };
    let item = if !spawn.is_empty() {
        Some(state.key("tool", &spawn))
    } else {
        prior.as_ref().and_then(|p| p.item.clone())
    };
    let terminal = prior.as_ref().map(|p| p.terminal).unwrap_or(false);
    let terminal_status = prior.as_ref().and_then(|p| p.terminal_status.clone());
    let started = prior.as_ref().map(|p| p.started).unwrap_or(false);
    let background_out = background || prior.as_ref().map(|p| p.background).unwrap_or(false);
    let task = NativeTask {
        data: merged_value,
        owner: owner.clone(),
        child: child.clone(),
        item: item.clone(),
        background: background_out,
        terminal,
        terminal_status,
        started,
    };
    state.tasks.insert(id.clone(), task.clone());
    if task.terminal
        && let Some(child) = &task.child
    {
        let status = task
            .terminal_status
            .clone()
            .unwrap_or_else(|| "failed".to_owned());
        let snapshot = task.clone();
        let _ = child;
        state.end_child(&snapshot, &status);
    }
    if task.background && !task.terminal {
        let kind =
            match str_of(object(&task.data).get("task_type").unwrap_or(&Value::Null)).as_str() {
                "local_agent" => "subagent",
                "local_bash" => "shell",
                "monitor" => "monitor",
                _ => "other",
            };
        let description = str_of(
            object(&task.data)
                .get("description")
                .unwrap_or(&Value::Null),
        );
        let title = if description.is_empty() {
            "Claude background task".to_owned()
        } else {
            description
        };
        state.emit(background_started(state, &id, kind, &title, &task, data));
    }
    id
}

fn background_started(
    state: &ClaudeState,
    id: &str,
    kind: &str,
    title: &str,
    task: &NativeTask,
    original: &Value,
) -> Value {
    let mut map = Map::with_capacity(9);
    map.insert(
        "type".to_owned(),
        Value::String("background.started".to_owned()),
    );
    map.insert("agent".to_owned(), Value::String(task.owner.clone()));
    map.insert("task".to_owned(), Value::String(state.key("task", id)));
    map.insert("kind".to_owned(), Value::String(kind.to_owned()));
    map.insert("title".to_owned(), Value::String(title.to_owned()));
    map.insert("stoppable".to_owned(), Value::Bool(true));
    if let Some(item) = &task.item {
        map.insert("item".to_owned(), Value::String(item.clone()));
    }
    if let Some(child) = &task.child {
        map.insert("childAgent".to_owned(), Value::String(child.clone()));
    }
    let ambient = object(&task.data).get("ambient") == Some(&Value::Bool(true));
    map.insert("ambient".to_owned(), Value::Bool(ambient));
    if let Some(Value::String(path)) = object(&task.data).get("output_file") {
        map.insert("outputPath".to_owned(), Value::String(path.clone()));
    }
    map.insert(
        "raw".to_owned(),
        Value::Array(vec![super::json::raw(original)]),
    );
    // Key order in TypeScript: type, agent, task, kind, title, stoppable,
    // item?, childAgent?, ambient, outputPath?, raw. Rebuild in order.
    let mut ordered = Map::with_capacity(map.len());
    for key in [
        "type",
        "agent",
        "task",
        "kind",
        "title",
        "stoppable",
        "item",
        "childAgent",
        "ambient",
        "outputPath",
        "raw",
    ] {
        if let Some(v) = map.remove(key) {
            ordered.insert(key.to_owned(), v);
        }
    }
    Value::Object(ordered)
}

pub(crate) fn finish(state: &mut ClaudeState, id: &str, status: &str, now: i64) {
    if !matches!(status, "completed" | "failed" | "killed" | "stopped") {
        return;
    }
    let snapshot = match state.tasks.get(id) {
        Some(t) => t.clone(),
        None => return,
    };
    let root = state.root.clone();
    if snapshot.background && !snapshot.terminal && !state.active.contains(&root) {
        state.expect_wake(now, Some(&snapshot));
    }
    if let Some(task) = state.tasks.get_mut(id) {
        task.terminal = true;
        task.terminal_status = Some(status.to_owned());
    }
    state.missing.delete(id);
    if let Some(task) = state.tasks.get(id).cloned() {
        state.end_child(&task, status);
        release_task(state, id);
    }
    if snapshot.background {
        let task_key = state.key("task", id);
        let out_status = match status {
            "completed" => "completed",
            "failed" => "failed",
            _ => "stopped",
        };
        state.emit(background_ended(&task_key, out_status));
    }
}

/// Where a background command writes its output, from the call's result.
pub fn background_output(state: &mut ClaudeState, data: &Value, output: &str) {
    let result = object(object(data).get("tool_use_result").unwrap_or(&Value::Null));
    let id = str_of(result.get("backgroundTaskId").unwrap_or(&Value::Null));
    if id.is_empty() {
        return;
    }
    let path = extract_output_path(output);
    let path = match path {
        Some(p) => p,
        None => return,
    };
    let task = match state.tasks.get(&id) {
        Some(t) => t.clone(),
        None => return,
    };
    if !task.background || task.terminal {
        return;
    }
    if object(&task.data).get("output_file").is_some() {
        return;
    }
    let mut patch = Map::new();
    patch.insert("task_id".to_owned(), Value::String(id.clone()));
    patch.insert("output_file".to_owned(), Value::String(path));
    register(state, &Value::Object(patch), true);
}

fn extract_output_path(output: &str) -> Option<String> {
    // The TypeScript matches /Output is being written to: (\S.*?\.output)(?=\.?(?:\s|$))/:
    // the shortest span starting with a non-space character and ending with
    // `.output`, followed by an optional period and whitespace or end.
    let needle = "Output is being written to: ";
    let mut search = 0;
    while let Some(found) = output[search..].find(needle) {
        let base = search + found + needle.len();
        let rest = &output[base..];
        if rest.starts_with(char::is_whitespace) || rest.is_empty() {
            search = base;
            continue;
        }
        let mut at = 0;
        while let Some(dot) = rest[at..].find(".output") {
            let end = at + dot + 7;
            let after = &rest[end..];
            let ok = after.is_empty()
                || after.starts_with(char::is_whitespace)
                || (after.starts_with('.')
                    && (after[1..].is_empty() || after[1..].starts_with(char::is_whitespace)));
            if ok {
                return Some(rest[..end].to_owned());
            }
            at = end;
        }
        search = base;
    }
    None
}

pub(crate) fn release_task(state: &mut ClaudeState, id: &str) {
    if let Some(task) = state.tasks.get_mut(id) {
        let mut kept = Map::new();
        let obj = object(&task.data).clone();
        for key in ["task_type", "tool_use_id", "run_id"] {
            if let Some(Value::String(s)) = obj.get(key) {
                kept.insert(key.to_owned(), Value::String(s.clone()));
            }
        }
        let ambient = obj.get("ambient") == Some(&Value::Bool(true));
        kept.insert("ambient".to_owned(), Value::Bool(ambient));
        task.data = Value::Object(kept);
    }
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
