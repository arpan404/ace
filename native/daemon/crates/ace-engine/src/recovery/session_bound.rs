// SPDX-License-Identifier: Apache-2.0
//! Provider work that dies with its process (`session-bound-tasks.ts`): a Claude subagent or a
//! child placeholder cannot still be running once the CLI is gone, while a background shell may
//! outlive it and only reads `unknown`. Startup runs this over the task index, never history.

use ace_core::state::ThreadState;
use ace_json::Value;
use ace_store::{Value as Cell, stmt_cache};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use crate::snapshot::Snapshot;
use crate::{Core, EngineError};

/// `claudeSessionBoundTask` (`adapter-claude/src/session-bound.ts:6`): work that lives inside the
/// Claude CLI process. A child awaiting registration carries `:unbound:`; a subagent's kind says
/// it. Background shells are left out: they may outlive the CLI.
pub fn claude_session_bound_task(key: &str, kind: &str) -> bool {
    key.starts_with("claude:") && (key.contains(":unbound:") || kind == "subagent")
}

/// The providers whose work is session-bound (`session-bound-tasks.ts:7`).
fn bound(provider: &str) -> Option<fn(&str, &str) -> bool> {
    match provider {
        "claude" => Some(claude_session_bound_task),
        _ => None,
    }
}

const OPEN_TASKS: &str = "SELECT key FROM engine_state_records WHERE thread_id=? AND section='tasks' AND json_extract(value,'$.status') IN ('running','unknown')";

/// `settleSessionBoundTasks` (`:29`): the tasks of a gone process settle as stopped, instead of
/// reading live or lost forever. Call only when no provider session of the thread is live.
pub fn settle_session_bound_tasks(
    core: &Core,
    thread: &str,
    snapshot: &Rc<RefCell<Snapshot>>,
) -> Result<Vec<Value>, EngineError> {
    let provider = {
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        borrowed.state.config.provider.clone()
    };
    let Some(bound) = bound(&provider) else {
        return Ok(Vec::new());
    };
    let keys = task_keys(core.store.conn(), thread)?;
    let mut borrowed = snapshot
        .try_borrow_mut()
        .map_err(|_| EngineError::Reentrant)?;
    let mut facts = Vec::new();
    for key in keys {
        // Tasks are a lazy record section: read the ones the index names so a restart sees what
        // was running, not an empty map.
        if !borrowed.state.tasks.contains_key(&key)
            && let Some(task) = borrowed.tasks.read(&key)?
        {
            borrowed.state.tasks.insert(key.clone(), task);
        }
        let Some(task) = borrowed.state.tasks.get(&key) else {
            continue;
        };
        if task.owner.as_deref() == Some("ace") || !bound(&key, &task.kind) {
            continue;
        }
        if task.status == "running" || task.status == "unknown" {
            facts.push(background_ended(&key, "stopped"));
        }
    }
    Ok(facts)
}

/// `settleOrphanedTasks` (`:44`): work a process from before the restart left marked running. No
/// provider session outlives the daemon, so ace can no longer reach it: a shell reads `unknown`
/// (lost track of, not running for Done), and later terminal evidence still settles it. Call only
/// at startup, after [`settle_session_bound_tasks`].
pub fn settle_orphaned_tasks(state: &ThreadState) -> Vec<Value> {
    state
        .indexes
        .running_tasks
        .keys()
        .filter_map(|key| {
            let task = state.tasks.get(key)?;
            (task.status == "running" && task.owner.as_deref() != Some("ace"))
                .then(|| background_ended(key, "unknown"))
        })
        .collect()
}

/// One `background.ended` fact.
fn background_ended(task: &str, status: &str) -> Value {
    let mut fact = ace_json::Map::new();
    fact.insert("type", Value::from("background.ended"));
    fact.insert("task", Value::from(task));
    fact.insert("status", Value::from(status));
    Value::Object(fact)
}

/// The task keys the stored index names, bounded by the index section (`:33`).
fn task_keys(conn: &Arc<ace_store::Connection>, thread: &str) -> Result<Vec<String>, EngineError> {
    let rows = stmt_cache::all_rows(conn, OPEN_TASKS, vec![Cell::Text(thread.to_owned())])?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            row.get("key")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
        })
        .collect())
}

/// `threadsWithOpenTasks` (`:68`): a thread with a task still marked running (its provider is
/// gone), or one of a provider with session-bound work that holds a lost one. The query restates
/// the partial index's condition so SQLite scans it, not every record.
pub fn threads_with_open_tasks(
    conn: &Arc<ace_store::Connection>,
) -> Result<Vec<String>, EngineError> {
    const SQL: &str = "SELECT DISTINCT r.thread_id AS thread_id FROM engine_state_records r JOIN threads t ON t.id=r.thread_id
      WHERE r.section IN ('interactions','tasks') AND r.section='tasks'
      AND json_extract(r.value,'$.status') IN ('running','unknown')
      AND (json_extract(r.value,'$.status')='running'
        OR t.provider IN (?))";
    let rows = stmt_cache::all_rows(conn, SQL, vec![Cell::Text("claude".to_owned())])?;
    Ok(rows
        .iter()
        .filter_map(|row| {
            row.get("thread_id")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
        })
        .collect())
}

#[cfg(test)]
mod tests;
