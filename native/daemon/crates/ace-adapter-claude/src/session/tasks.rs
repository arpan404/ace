// SPDX-License-Identifier: Apache-2.0
//! The task index, ported from `adapter-claude/src/session-tasks.ts` statement for statement:
//! live tasks plus a bounded terminal identity window, so a stop or completion that races its
//! descendants still resolves. Tasks are slots because the TypeScript kept one object in several
//! maps; every map here points at the same slot.

use std::collections::HashSet;

use ace_json::{Map, Value};
use indexmap::IndexMap;
use thiserror::Error;

/// `:36`: unsettled tool_use ids held until their task starts.
const MAX_PENDING_PARENTS: usize = 1024;
/// `:50`: live tasks.
const MAX_LIVE: usize = 512;
/// The terminal identity window, and the retired route window (`:82`).
const MAX_COMPLETED: usize = 512;
const MAX_RETIRED: usize = 512;

/// The two capacity refusals, verbatim from `session-tasks.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum TaskError {
    #[error("Claude unsettled tool capacity reached")]
    UnsettledTools,
    #[error("Claude live task capacity reached")]
    LiveTasks,
}

/// One task's identity and ancestry (`LiveTask`).
#[derive(Debug, Default)]
struct LiveTask {
    id: String,
    spawn: String,
    parent: String,
    live: bool,
    run: String,
    route: String,
}

/// The task index. Insertion order is the TypeScript `Map` order.
#[derive(Debug, Default)]
pub struct SessionTasks {
    slots: Vec<LiveTask>,
    free: Vec<usize>,
    live: IndexMap<String, usize>,
    completed: IndexMap<String, usize>,
    pending_parents: IndexMap<String, String>,
    by_spawn: IndexMap<String, usize>,
    retired: IndexMap<String, String>,
    children: IndexMap<String, usize>,
}

impl SessionTasks {
    pub fn new() -> SessionTasks {
        SessionTasks::default()
    }

    /// `observe(data)`: tool_use/tool_result blocks, then `system` task lifecycle messages.
    pub fn observe(&mut self, data: &Value) -> Result<(), TaskError> {
        let Some(map) = data.as_object() else {
            return Ok(());
        };
        let kind = map.get("type").and_then(Value::as_str);
        if (kind == Some("assistant") || kind == Some("user"))
            && let Some(items) = map
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_array)
        {
            for item in items {
                let Some(block) = item.as_object() else {
                    continue;
                };
                match block.get("type").and_then(Value::as_str) {
                    Some("tool_use") => {
                        let id = text(block.get("id"));
                        if id.is_empty() {
                            continue;
                        }
                        let parent = text(map.get("parent_tool_use_id"));
                        self.tool_use(id, parent)?;
                    }
                    Some("tool_result") => {
                        let id = text(block.get("tool_use_id"));
                        self.pending_parents.shift_remove(&id);
                    }
                    _ => {}
                }
            }
        }
        if kind != Some("system") {
            return Ok(());
        }
        let id = text(map.get("task_id"));
        match map.get("subtype").and_then(Value::as_str) {
            Some("task_started") if !id.is_empty() => self.task_started(map, id),
            Some("task_updated") | Some("task_notification") => {
                self.task_finished(map, &id);
                Ok(())
            }
            _ => Ok(()),
        }
    }

    /// `resolve(spawn)` as the task's JSON (`id`, `spawn`, `parent`, `live`, `run`, `route`).
    pub fn task_target(&self, spawn: &str) -> Option<String> {
        self.resolve(spawn).map(|slot| task_json(&self.slots[slot]))
    }

    /// `cascade(spawn)` as `{ids, uncertain}`. None or an empty spawn is uncertain with no ids.
    pub fn cascade(&self, spawn: Option<&str>) -> String {
        let Some(target) = spawn.filter(|spawn| !spawn.is_empty()) else {
            return cascade_json(&[], true);
        };
        let mut ids = Vec::new();
        let mut uncertain = false;
        for (id, slot) in &self.live {
            let task = &self.slots[*slot];
            if !task.live || task.spawn == target {
                continue;
            }
            let mut parent = task.parent.clone();
            let mut visited = HashSet::new();
            while !parent.is_empty() && parent != target && self.spawn_of(&parent) != Some(target) {
                if !visited.insert(parent.clone()) {
                    uncertain = true;
                    break;
                }
                let next = self
                    .by_spawn
                    .get(&parent)
                    .map(|slot| self.slots[*slot].parent.clone())
                    .or_else(|| self.retired.get(&parent).cloned());
                let Some(next) = next else {
                    uncertain = true;
                    break;
                };
                parent = next;
            }
            if parent == target || self.spawn_of(&parent) == Some(target) {
                ids.push(id.clone());
            }
        }
        cascade_json(&ids, uncertain)
    }

    /// A tool_use block: learn its parent, or re-parent a task that started first.
    fn tool_use(&mut self, id: String, parent: String) -> Result<(), TaskError> {
        let Some(slot) = self.by_spawn.get(&id).copied() else {
            if !self.pending_parents.contains_key(&id)
                && self.pending_parents.len() >= MAX_PENDING_PARENTS
            {
                return Err(TaskError::UnsettledTools);
            }
            self.pending_parents.insert(id, parent);
            return Ok(());
        };
        if self.slots[slot].parent == parent {
            return Ok(());
        }
        let previous_parent = self.slots[slot].parent.clone();
        self.remove_child(&previous_parent);
        let previous = self.by_spawn.get(&previous_parent).copied();
        self.slots[slot].parent = parent.clone();
        self.add_child(&parent);
        if let Some(previous) = previous {
            self.prune(previous);
        }
        Ok(())
    }

    fn task_started(&mut self, map: &Map, id: String) -> Result<(), TaskError> {
        let spawn = text(map.get("tool_use_id"));
        let run = text(map.get("run_id"));
        let known = self
            .live
            .get(&id)
            .or_else(|| self.completed.get(&id))
            .copied();
        if let Some(slot) = known {
            let task = &self.slots[slot];
            if !task.live && !run.is_empty() && run == task.run {
                return Ok(());
            }
        }
        if !self.live.contains_key(&id) && self.live.len() >= MAX_LIVE {
            return Err(TaskError::LiveTasks);
        }
        let slot = match known {
            Some(slot) => slot,
            None => {
                let parent = self
                    .pending_parents
                    .get(&spawn)
                    .cloned()
                    .unwrap_or_default();
                self.alloc(LiveTask {
                    id: id.clone(),
                    spawn: spawn.clone(),
                    parent,
                    live: true,
                    run: run.clone(),
                    route: spawn.clone(),
                })
            }
        };
        if !self.live.contains_key(&id) {
            let parent = self.slots[slot].parent.clone();
            self.add_child(&parent);
        }
        let route = self.slots[slot].route.clone();
        let current_spawn = self.slots[slot].spawn.clone();
        if !route.is_empty() && route != current_spawn && route != spawn {
            self.by_spawn.shift_remove(&route);
            self.retire(&route, &current_spawn);
        }
        if current_spawn.is_empty() {
            self.slots[slot].spawn = spawn.clone();
        }
        self.slots[slot].live = true;
        self.slots[slot].run = run;
        self.slots[slot].route = spawn.clone();
        self.completed.shift_remove(&id);
        let spawn_now = self.slots[slot].spawn.clone();
        if !spawn_now.is_empty() {
            self.by_spawn.insert(spawn_now, slot);
        }
        self.live.insert(id, slot);
        if !spawn.is_empty() {
            self.by_spawn.insert(spawn.clone(), slot);
            self.pending_parents.shift_remove(&spawn);
        }
        Ok(())
    }

    /// `task_updated` / `task_notification` with a terminal status.
    fn task_finished(&mut self, map: &Map, id: &str) {
        let status = map.get("status").and_then(Value::as_str).or_else(|| {
            map.get("patch")
                .and_then(|patch| patch.get("status"))
                .and_then(Value::as_str)
        });
        let Some(status) = status else {
            return;
        };
        if !["completed", "failed", "killed", "stopped"].contains(&status) {
            return;
        }
        let Some(slot) = self.live.get(id).copied() else {
            return;
        };
        let run = text(map.get("run_id"));
        let task_run = self.slots[slot].run.clone();
        if !run.is_empty() && !task_run.is_empty() && run != task_run {
            return;
        }
        if !run.is_empty() {
            self.slots[slot].run = run;
        }
        self.slots[slot].live = false;
        self.prune(slot);
    }

    fn resolve(&self, key: &str) -> Option<usize> {
        self.live
            .get(key)
            .or_else(|| self.by_spawn.get(key))
            .or_else(|| self.completed.get(key))
            .copied()
            .or_else(|| {
                self.completed.values().copied().find(|slot| {
                    let task = &self.slots[*slot];
                    task.spawn == key || task.route == key
                })
            })
    }

    /// The task a spawn key names, if one does.
    fn spawn_of(&self, key: &str) -> Option<&str> {
        self.by_spawn
            .get(key)
            .map(|slot| self.slots[*slot].spawn.as_str())
    }

    fn prune(&mut self, task: usize) {
        let mut current = Some(task);
        while let Some(slot) = current {
            let task = &self.slots[slot];
            if task.live
                || self.children.contains_key(&task.spawn)
                || self.children.contains_key(&task.route)
            {
                break;
            }
            let id = task.id.clone();
            let spawn = task.spawn.clone();
            let route = task.route.clone();
            let parent = task.parent.clone();
            self.live.shift_remove(&id);
            if self.completed.len() >= MAX_COMPLETED
                && let Some((_, oldest)) = self.completed.shift_remove_index(0)
            {
                self.release(oldest);
            }
            self.completed.insert(id, slot);
            if !route.is_empty() && route != spawn {
                self.by_spawn.shift_remove(&route);
                self.retire(&route, &spawn);
            }
            if !spawn.is_empty() {
                self.by_spawn.shift_remove(&spawn);
                self.retire(&spawn, &parent);
            }
            self.remove_child(&parent);
            current = self.by_spawn.get(&parent).copied();
        }
    }

    fn alloc(&mut self, task: LiveTask) -> usize {
        match self.free.pop() {
            Some(slot) => {
                self.slots[slot] = task;
                slot
            }
            None => {
                self.slots.push(task);
                self.slots.len() - 1
            }
        }
    }

    fn release(&mut self, slot: usize) {
        self.slots[slot] = LiveTask::default();
        self.free.push(slot);
    }

    fn retire(&mut self, spawn: &str, parent: &str) {
        if self.retired.len() >= MAX_RETIRED {
            self.retired.shift_remove_index(0);
        }
        self.retired.insert(spawn.to_owned(), parent.to_owned());
    }

    fn add_child(&mut self, parent: &str) {
        if parent.is_empty() {
            return;
        }
        let count = self.children.get(parent).copied().unwrap_or(0) + 1;
        self.children.insert(parent.to_owned(), count);
    }

    fn remove_child(&mut self, parent: &str) {
        let remaining = self.children.get(parent).copied().unwrap_or(0) as i64 - 1;
        if remaining > 0 {
            self.children.insert(parent.to_owned(), remaining as usize);
        } else {
            self.children.shift_remove(parent);
        }
    }
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or_default().to_owned()
}

fn task_json(task: &LiveTask) -> String {
    let mut map = Map::with_capacity(6);
    map.insert("id", Value::from(task.id.as_str()));
    map.insert("spawn", Value::from(task.spawn.as_str()));
    map.insert("parent", Value::from(task.parent.as_str()));
    map.insert("live", Value::Bool(task.live));
    map.insert("run", Value::from(task.run.as_str()));
    map.insert("route", Value::from(task.route.as_str()));
    ace_json::to_string(&Value::Object(map))
}

fn cascade_json(ids: &[String], uncertain: bool) -> String {
    let mut map = Map::with_capacity(2);
    map.insert(
        "ids",
        Value::from(
            ids.iter()
                .map(|id| Value::from(id.as_str()))
                .collect::<Vec<_>>(),
        ),
    );
    map.insert("uncertain", Value::Bool(uncertain));
    ace_json::to_string(&Value::Object(map))
}
