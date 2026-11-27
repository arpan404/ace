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

/// Check a thread in indexed record pages before starting its first new session.
pub(crate) async fn before_dispatch(core: &Core, thread: &str) -> Result<(), EngineError> {
    if !core.with_state(|state| {
        state.sessions.startup_task_sweep_pending
            || state.sessions.startup_task_cleanup_errors.contains(thread)
    })? {
        return Ok(());
    }
    let mut after = String::new();
    loop {
        if core.closing.get() {
            return Ok(());
        }
        let Some(next) = reconcile_page(core, thread, &after)? else {
            core.with_state(|state| state.sessions.startup_task_cleanup_errors.remove(thread))?;
            return Ok(());
        };
        after = next;
        crate::actor::yield_once().await;
    }
}

/// Legacy done threads may still have records for an ambient shell. Their records are repaired
/// after readiness, at most one indexed task page between yields.
pub(crate) async fn sweep(core: &Rc<Core>) -> Result<(), EngineError> {
    let mut after = String::new();
    loop {
        if core.closing.get() {
            return Ok(());
        }
        let rows = stmt_cache::all_rows(
            core.store.conn(),
            "SELECT thread_id FROM thread_state WHERE thread_id>? ORDER BY thread_id LIMIT 64",
            vec![Cell::Text(after.clone())],
        )?;
        if rows.is_empty() {
            return core.with_state(|state| state.sessions.startup_task_sweep_pending = false);
        }
        for row in rows {
            let Some(thread) = row
                .get("thread_id")
                .and_then(crate::repository::residency::cell_text)
            else {
                continue;
            };
            if let Err(error) = before_dispatch(core, thread).await {
                if !error.skippable_at_startup() {
                    return Err(error);
                }
                core.ports.report(format!("{thread}: {error}"));
                core.with_state(|state| {
                    state
                        .sessions
                        .startup_task_cleanup_errors
                        .insert(thread.to_owned())
                })?;
            }
            after = thread.to_owned();
            crate::actor::yield_once().await;
        }
    }
}

fn reconcile_page(core: &Core, thread: &str, after: &str) -> Result<Option<String>, EngineError> {
    core.store.atomic(|tx| {
        core.with_state(|state| {
            if state.repo.cleaning(thread) || state.sessions.attached.contains_key(thread)
                || state.session_opening(thread) || crate::cursor_reconcile::holds(state, thread)
            {
                return Ok(None);
            }
            let rows = stmt_cache::all_rows(tx.conn(),
                "SELECT key, json_extract(value,'$.status') AS status, json_extract(value,'$.owner') AS owner,
                   json_extract(value,'$.kind') AS kind FROM engine_state_records
                 WHERE thread_id=? AND section='tasks' AND key>? ORDER BY key LIMIT 64",
                vec![Cell::Text(thread.to_owned()), Cell::Text(after.to_owned())],
            )?;
            if rows.is_empty() {
                return Ok(None);
            }
            let Some(row) = super::threads::get(&core.store, thread)? else { return Ok(None); };
            if row.backend.as_deref() == Some("cursor-sdk")
                || state.session_backend(&core.store, thread)?.as_deref() == Some("cursor-sdk")
            {
                return Ok(None);
            }
            let mut facts = Vec::new();
            for row_task in &rows {
                use crate::repository::residency::cell_text;
                let text = |column| row_task.get(column).and_then(cell_text);
                let Some(key) = text("key") else { continue };
                let status = text("status").unwrap_or_default();
                if text("owner") == Some("ace") {
                    continue;
                }
                let bound = bound(&row.provider).is_some_and(|is_bound| is_bound(key, text("kind").unwrap_or_default()));
                if bound && matches!(status, "running" | "unknown") {
                    facts.push(background_ended(key, "stopped"));
                } else if status == "running" {
                    facts.push(background_ended(key, "unknown"));
                }
            }
            if !facts.is_empty() {
                state.apply(&core.store, thread, &ace_json::to_string(&Value::Array(facts.into())), core.ports.now(), None)?;
                crate::liveness::reconcile::ancestors(core, state, thread)?;
            }
            Ok(rows.last().filter(|_| rows.len() == 64)
                .and_then(|row| row.get("key").and_then(crate::repository::residency::cell_text))
                .map(str::to_owned))
        })?
    })
}

#[cfg(test)]
mod tests;
