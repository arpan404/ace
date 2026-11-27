// SPDX-License-Identifier: Apache-2.0
//! Task frames and ticks (split from `tasks.rs`).

use ace_json::{Map, Value};

use super::json::{list, object, str_of};
use super::state::{ClaudeState, NativeTask};

pub fn task_frame(state: &mut ClaudeState, data: &Value, now: i64) -> bool {
    let obj = object(data);
    let subtype = str_of(obj.get("subtype").unwrap_or(&Value::Null));
    if subtype == "background_tasks_changed" {
        let mut next = std::collections::HashSet::new();
        for value in list(obj.get("tasks").unwrap_or(&Value::Null)) {
            let task = object(value);
            let id = str_of(task.get("task_id").unwrap_or(&Value::Null));
            if id.is_empty() {
                continue;
            }
            next.insert(id.clone());
            state.missing.delete(&id);
            super::tasks::register(state, value, true);
        }
        let level: std::collections::HashSet<String> = state.level.clone();
        for id in &level {
            if !next.contains(id) {
                let missing = match state.tasks.get(id) {
                    Some(t) => !t.terminal,
                    None => false,
                };
                if missing {
                    state.missing.set(id, now + 1_000);
                    if let Some(task) = state.tasks.get(id).cloned() {
                        state.expect_wake(now, Some(&task));
                    }
                }
            }
        }
        state.level = next;
        return true;
    }
    if !subtype.starts_with("task_") {
        return false;
    }
    let id = str_of(obj.get("task_id").unwrap_or(&Value::Null));
    if id.is_empty() {
        return false;
    }
    if subtype == "task_started" {
        let prior = state.tasks.get(&id).cloned();
        if let Some(p) = &prior
            && p.terminal
            && p.started
            && starts_new_run(p, data)
        {
            resume(state, p, data);
            return true;
        }
        let is_background = obj.get("is_backgrounded") == Some(&Value::Bool(true));
        let task_id = super::tasks::register(state, data, is_background);
        if let Some(task) = state.tasks.get_mut(&task_id) {
            task.started = true;
        }
        let child = state.tasks.get(&task_id).and_then(|t| t.child.clone());
        if let Some(child) = child
            && let Some(Value::String(prompt)) = obj.get("prompt")
        {
            let item = state.key("prompt", &child);
            let keep = state.keep_raw(&item, data, &child, None);
            let prompt_text = prompt.clone();
            let child_clone = child.clone();
            let item_clone = item.clone();
            state.emit(prompt_upsert(&child_clone, &item_clone, &prompt_text, keep));
        }
        return true;
    }
    let is_background = obj.get("is_backgrounded") == Some(&Value::Bool(true));
    // Register first so later fields merge, mirroring `?? register(...)`.
    if !state.tasks.contains_key(&id) {
        super::tasks::register(state, data, is_background);
    }
    if stale_run(state, &id, data) {
        return true;
    }
    // Merge the update into the task's data.
    if let Some(task) = state.tasks.get_mut(&id) {
        let mut merged = object(&task.data).clone();
        for (k, v) in obj {
            merged.insert(k.clone(), v.clone());
        }
        task.data = Value::Object(merged);
    }
    if subtype == "task_progress" {
        let (owner, child) = match state.tasks.get(&id) {
            Some(t) => (t.owner.clone(), t.child.clone()),
            None => return true,
        };
        let agent = child.clone().unwrap_or(owner);
        state.emit(signal_fact(&agent));
        if let Some(child) = child {
            let detail = str_of(obj.get("description").unwrap_or(&Value::Null));
            state.emit(activity_fact(&child, "tool", &detail));
        }
        return true;
    }
    if subtype == "task_updated" || subtype == "task_notification" {
        let patch = object(obj.get("patch").unwrap_or(&Value::Null));
        let status = str_of(
            obj.get("status")
                .unwrap_or(patch.get("status").unwrap_or(&Value::Null)),
        );
        if subtype == "task_notification"
            && let Some(task) = state.tasks.get(&id).cloned()
            && task.background
        {
            state.expect_wake(now, Some(&task));
        }
        super::tasks::finish(state, &id, &status, now);
        return true;
    }
    false
}

pub fn task_tick(state: &mut ClaudeState, _now: i64) -> Vec<Value> {
    // taskTick in TypeScript only expires missing edges through the shared
    // MissingEdges passed as state.missing; expiry is driven by the caller's
    // pending.expire + taskTick ordering. Mirror the missing-edge expiry for
    // level tasks here is handled by the caller via state.missing directly.
    // This port expires missing task edges now.
    let expired: Vec<String> = state.missing.expired(_now);
    for id in expired {
        let task = match state.tasks.get(&id).cloned() {
            Some(t) => t,
            None => continue,
        };
        if task.terminal {
            continue;
        }
        if let Some(slot) = state.tasks.get_mut(&id) {
            slot.terminal = true;
            slot.terminal_status = Some("failed".to_owned());
        }
        let task_key = state.key("task", &id);
        state.emit(super::tasks::background_ended(&task_key, "unknown"));
        if let Some(task) = state.tasks.get(&id).cloned() {
            state.end_child(&task, "failed");
            super::tasks::release_task(state, &id);
        }
    }
    state.facts.clone()
}

fn starts_new_run(prior: &NativeTask, data: &Value) -> bool {
    let run = str_of(object(data).get("run_id").unwrap_or(&Value::Null));
    if run.is_empty() {
        return true;
    }
    run != str_of(object(&prior.data).get("run_id").unwrap_or(&Value::Null))
}

fn stale_run(state: &ClaudeState, id: &str, data: &Value) -> bool {
    let run = str_of(object(data).get("run_id").unwrap_or(&Value::Null));
    let current = state
        .tasks
        .get(id)
        .map(|t| str_of(object(&t.data).get("run_id").unwrap_or(&Value::Null)))
        .unwrap_or_default();
    !run.is_empty() && !current.is_empty() && run != current
}

fn resume(state: &mut ClaudeState, prior: &NativeTask, data: &Value) {
    let spawn = str_of(object(data).get("tool_use_id").unwrap_or(&Value::Null));
    let original = str_of(
        object(&prior.data)
            .get("tool_use_id")
            .unwrap_or(&Value::Null),
    );
    let id = str_of(object(data).get("task_id").unwrap_or(&Value::Null));
    if let Some(task) = state.tasks.get_mut(&id) {
        task.terminal = false;
        task.terminal_status = None;
    }
    state.missing.delete(&id);
    // Merge with the original spawn link so the child keeps its identity.
    let mut merged = object(data).clone();
    if !original.is_empty() {
        merged.insert("tool_use_id".to_owned(), Value::from(original));
    }
    let is_background = object(data).get("is_backgrounded") == Some(&Value::Bool(true));
    let task_id = super::tasks::register(state, &Value::Object(merged), is_background);
    if let Some(child) = state.tasks.get(&task_id).and_then(|t| t.child.clone())
        && !spawn.is_empty()
    {
        state.reopen_child(&child, &spawn);
    }
}

fn signal_fact(agent: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type".to_owned(), Value::from("signal".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    Value::Object(map)
}

fn activity_fact(agent: &str, activity: &str, detail: &str) -> Value {
    let mut map = Map::with_capacity(4);
    map.insert("type".to_owned(), Value::from("activity".to_owned()));
    map.insert("agent".to_owned(), Value::from(agent.to_owned()));
    map.insert("activity".to_owned(), Value::from(activity.to_owned()));
    if !detail.is_empty() {
        map.insert("detail".to_owned(), Value::from(detail.to_owned()));
    }
    Value::Object(map)
}

fn prompt_upsert(child: &str, item: &str, prompt: &str, keep: Value) -> Value {
    let mut draft = Map::with_capacity(7);
    draft.insert("type".to_owned(), Value::from("message".to_owned()));
    draft.insert("role".to_owned(), Value::from("user".to_owned()));
    draft.insert("parts".to_owned(), Value::from(vec![part_text(prompt)]));
    draft.insert("synthetic".to_owned(), Value::Bool(true));
    draft.insert("complete".to_owned(), Value::Bool(true));
    if let Value::Object(extra) = keep {
        for (k, v) in extra {
            draft.insert(k, v);
        }
    }
    let mut map = Map::with_capacity(4);
    map.insert("type".to_owned(), Value::from("item.upsert".to_owned()));
    map.insert("agent".to_owned(), Value::from(child.to_owned()));
    map.insert("item".to_owned(), Value::from(item.to_owned()));
    map.insert("draft".to_owned(), Value::Object(draft));
    Value::Object(map)
}

fn part_text(text: &str) -> Value {
    let mut map = Map::with_capacity(2);
    map.insert("type".to_owned(), Value::from("text".to_owned()));
    map.insert("text".to_owned(), Value::from(text.to_owned()));
    Value::Object(map)
}
