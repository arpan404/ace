// SPDX-License-Identifier: Apache-2.0
//! `thread-liveness.ts`'s live-work reads (E5.10): what a tree is still doing, whether anything
//! in it is active, and whether a thread has unfinished work. A thread is never settled as done
//! while any part of its tree works or waits on a person (AGENTS.md priority 1).

use ace_json::Value;

use crate::{Core, EngineError, State};

/// Live engine work in a thread tree; durable records alone never count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LiveWork {
    pub agents_running: i64,
    pub operations_running: i64,
}

/// Whether a thread's session is closing (E5.6's `sessions.isClosing`).
pub type Closing<'a> = &'a dyn Fn(&str) -> bool;

/// `live(id)`: the agents working and the operations running across the tree.
pub fn live(
    core: &Core,
    state: &mut State,
    id: &str,
    closing: Closing<'_>,
) -> Result<LiveWork, EngineError> {
    let mut work = LiveWork::default();
    for owner in super::tree::thread_tree(core, state, id)? {
        let attached = state
            .actors
            .by_thread
            .get(&owner)
            .is_some_and(|actor| actor.session_attached);
        if attached {
            let snapshot = state.repo.state(&core.store, &owner)?;
            if let Some(snapshot) = snapshot {
                let quiescent = {
                    let mut borrowed = snapshot
                        .try_borrow_mut()
                        .map_err(|_| EngineError::Reentrant)?;
                    let view = borrowed.quiescence_view()?;
                    let ready =
                        crate::transitions::readiness::agents_ready(core.store.conn(), &owner)?;
                    crate::transitions::readiness::quiescent(&view, ready)
                };
                if !quiescent {
                    let running = snapshot
                        .borrow()
                        .state
                        .agents
                        .values()
                        .filter(|record| record.external_status.is_none())
                        .filter(|record| {
                            !matches!(
                                record.agent.status,
                                ace_core::status::AgentStatus::Idle
                                    | ace_core::status::AgentStatus::Interrupted
                                    | ace_core::status::AgentStatus::Failed { .. }
                            )
                        })
                        .count() as i64;
                    work.agents_running += running.max(1);
                }
            }
        }
        let queue = crate::queue::store::get(&core.store, &owner)?;
        let opening = state.session_opening(&owner);
        if closing(&owner)
            || opening
            || running(core, &owner)?
            || (!queue.paused
                && !queue.limited
                && (crate::intents::store::message(core.store.conn(), &owner)?.is_some()
                    || crate::intents::store::recovery(core.store.conn(), &owner)?.is_some()))
        {
            work.operations_running += 1;
        }
    }
    Ok(work)
}

/// `pending.running(owner)`.
fn running(core: &Core, thread: &str) -> Result<bool, EngineError> {
    const SQL: &str = "SELECT 1 FROM intents WHERE thread_id=? AND status='running' LIMIT 1";
    Ok(ace_store::stmt_cache::get_row(
        core.store.conn(),
        SQL,
        vec![ace_store::Value::Text(thread.to_owned())],
    )?
    .is_some())
}

/// `active(id)`: something in the tree goes on — a turn, a retry, a background task, a request
/// waiting on a person, or an input being sent. Facts alone count, so work that started without
/// a new run is seen too.
pub fn active(core: &Core, state: &mut State, id: &str) -> Result<bool, EngineError> {
    for owner in super::tree::thread_tree(core, state, id)? {
        if running(core, &owner)? || state.session_opening(&owner) {
            return Ok(true);
        }
        let Some(snapshot) = state.repo.state(&core.store, &owner)? else {
            continue;
        };
        let live = {
            let borrowed = snapshot.borrow();
            !borrowed.state.indexes.running_tasks.is_empty()
                || !borrowed.state.indexes.pending_interactions.is_empty()
                || borrowed
                    .state
                    .agents
                    .values()
                    .any(|record| record.active_run.is_some() || record.retry.is_some())
        };
        if live {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `unfinished(id)`: idle retained work needs cleanup, but has no finished outcome to keep.
pub fn unfinished(core: &Core, state: &mut State, id: &str) -> Result<bool, EngineError> {
    let Some(thread) = crate::commands::prelude::thread_row(core, id)? else {
        return Ok(false);
    };
    let status = thread
        .get("status")
        .and_then(|status| status.get("state"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let queue = crate::queue::page::snapshot(&core.store, id)?;
    let pending = queue
        .get("pendingCount")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let uncertain = queue
        .get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| {
            messages
                .iter()
                .any(|message| message.get("state").and_then(Value::as_str) == Some("uncertain"))
        });
    Ok(!matches!(status, "done" | "failed")
        || pending > 0.0
        || uncertain
        || ace_projection::attention::queue_attention(Some(&queue)).is_some()
        || running(core, id)?
        || state.session_opening(id))
}

#[cfg(test)]
mod tests;
