// SPDX-License-Identifier: Apache-2.0
//! `provider-release.ts` and `slot-reclaim.ts`: a warm provider process, when it is released, and
//! the idle slot a new thread may take instead of being refused. Moved cases:
//! `provider-release.process.test.ts` and `resource-limits.process.test.ts`'s reclaim case.

use ace_json::Value;
use std::collections::HashSet;

use crate::actor::timer::release_at;
use crate::repository::ReclaimView;
use crate::{EngineError, State, ThreadId};

/// A done thread keeps its provider process warm this long before releasing it.
pub const DEFAULT_PROVIDER_IDLE_MS: f64 = 5.0 * 60_000.0;

/// What an event asks of a warm provider (`releaseRequest`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Release {
    Release,
    Withdraw,
}

/// `releaseRequest(event)`: settling or archiving asks the warm provider to go now; unsettling or
/// unarchiving withdraws that request; every other event says nothing.
pub fn release_request(event: &Value) -> Option<Release> {
    let kind = event.get("type").and_then(Value::as_str)?;
    match kind {
        "thread.updated" => {
            let archived = event.get("archivedAt")?;
            Some(if matches!(archived, Value::Null) {
                Release::Withdraw
            } else {
                Release::Release
            })
        }
        "thread.client.updated" => {
            let settled = event.get("changes")?.get("settledAt")?;
            Some(if matches!(settled, Value::Null) {
                Release::Withdraw
            } else {
                Release::Release
            })
        }
        _ => None,
    }
}

/// `releasedThread`: a thread that was archived or settled keeps no provider warm.
pub fn released_thread(archived: bool, settled: bool) -> bool {
    archived || settled
}

/// `busy`: the thread tree still has live work. `idle-warm`: done, waiting out the idle window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderProcessState {
    Busy,
    IdleWarm,
    Releasing,
}

pub fn provider_process_state(
    session: bool,
    closing: bool,
    idle_since: Option<f64>,
    idle_due: bool,
) -> Option<ProviderProcessState> {
    if closing || (session && idle_due) {
        return Some(ProviderProcessState::Releasing);
    }
    if !session {
        return None;
    }
    Some(match idle_since {
        Some(_) => ProviderProcessState::IdleWarm,
        None => ProviderProcessState::Busy,
    })
}

/// One provider process the engine's actors hold (`ProviderProcess`).
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderProcess {
    pub thread_id: ThreadId,
    pub provider: String,
    pub state: ProviderProcessState,
    pub idle_since: Option<f64>,
    pub release_at: Option<f64>,
}

/// `listProviderProcesses`: every warm process, with how far along its release is.
pub fn list_provider_processes(
    state: &State,
    idle_ms: f64,
    closing: impl Fn(&str) -> bool,
    provider: impl Fn(&str) -> Option<String>,
) -> Vec<ProviderProcess> {
    let mut processes = Vec::new();
    for actor in state.actors.live() {
        let Some(process) = provider_process_state(
            actor.session_attached,
            closing(&actor.id),
            actor.idle_since,
            actor.idle_due,
        ) else {
            continue;
        };
        let Some(kind) = provider(&actor.id) else {
            continue;
        };
        let at = if process == ProviderProcessState::IdleWarm {
            release_at(actor, idle_ms)
        } else {
            None
        };
        processes.push(ProviderProcess {
            thread_id: actor.id.clone(),
            provider: kind,
            state: process,
            idle_since: actor.idle_since,
            release_at: at,
        });
    }
    processes
}

/// `reclaimIdleSlot` (`slot-reclaim.ts:7`): free a slot held only by a warm idle session,
/// oldest first. Returns the retiring thread, whose slot no longer counts against capacity; the
/// thread's session closes when its idle release is due.
pub fn reclaim_idle_slot(
    view: ReclaimView<'_>,
    retiring: &HashSet<ThreadId>,
) -> Result<Option<ThreadId>, EngineError> {
    let ReclaimView {
        actors,
        sessions,
        store,
        repo,
    } = view;
    let conn = store.conn();
    let candidates: Vec<ThreadId> = actors.live().map(|actor| actor.id.clone()).collect();
    for id in candidates {
        let Some(actor) = actors.by_thread.get(&id) else {
            continue;
        };
        if !actor.session_attached || actor.idle_due || actor.idle_since.is_none() {
            continue;
        }
        if retiring.contains(&id) || sessions.is_closing(&id) {
            continue;
        }
        if !repo.reserved_slot(store, &id)? {
            continue;
        }
        // A session still opening, or any queued work, is not an idle slot to reclaim.
        if repo.opening.contains(&id) {
            continue;
        }
        let running = crate::intents::query::running(conn, &id)?;
        let message = crate::intents::store::message(conn, &id)?.is_some();
        let recovery = crate::intents::store::recovery(conn, &id)?.is_some();
        let transition = crate::intents::store::transition(conn, &id)?.is_some();
        let controls = !crate::intents::store::controls(conn, &id)?.is_empty();
        if running || message || recovery || transition || controls {
            continue;
        }
        if let Some(actor) = actors.by_thread.get_mut(&id) {
            actor.idle_due = true;
        }
        return Ok(Some(id));
    }
    Ok(None)
}

#[cfg(test)]
mod tests;
