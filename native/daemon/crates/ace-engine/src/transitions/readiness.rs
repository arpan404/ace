// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.9.
//!
//! `transition-readiness.ts:85`-`:95` (`refreshBlocked`, `agentsReady`, `acceptsPersonInput`)
//! and `repository.ts:496`-`:507`'s two readiness questions: the blocker row decides whether the
//! tree is between turns, which `admitSteer` and `readyForInput` read synchronously. `capture`
//! stays E5.9's, and the asynchronous paths that await `whenRebuilt` are E5.5's and E5.9's.
//!
//! **Rebuilt.** Both answering methods check the thread's readiness rebuild before they read
//! (E5.3 brief, "Readiness"): a thread not yet rebuilt answers false, never "done". E5.4's owner
//! decision of 2026-11-24 adds no fill, so the boot rebuild the TypeScript opener runs is the
//! answer for every thread in a home this build opened.

use ace_core::ThreadState;
use ace_core::state::AgentRecord;
use ace_store::{Value as Cell, stmt_cache};

use crate::EngineError;
use crate::repository::residency::cell_text;

const FIND: &str = "SELECT agent_key FROM engine_transition_blockers WHERE thread_id=? LIMIT 1";
const KEYS: &str = "SELECT agent_key FROM engine_transition_blockers WHERE thread_id=?";
const PUT: &str = "INSERT OR IGNORE INTO engine_transition_blockers VALUES (?, ?)";
const REMOVE: &str = "DELETE FROM engine_transition_blockers WHERE thread_id=? AND agent_key=?";

/// A root that has never started a run is a thread awaiting its first input. Core materializes
/// it as "starting" when any event arrives before a turn; that is not work in progress.
fn never_started(record: &AgentRecord) -> bool {
    record.agent.origin == "root"
        && matches!(record.agent.status, ace_core::status::AgentStatus::Starting)
        && record.last_run.is_none()
}

/// `agentReady` (`transition-readiness.ts:17`).
fn agent_ready(record: &AgentRecord, now: i64) -> bool {
    use ace_core::status::AgentStatus;
    if record.external_status.is_some() {
        return true;
    }
    if record.active_run.is_some() {
        return false;
    }
    if record.wake_until.is_some_and(|until| until > now) || record.disconnected_at.is_some() {
        return false;
    }
    if never_started(record) {
        return true;
    }
    match &record.agent.status {
        AgentStatus::Idle | AgentStatus::Interrupted | AgentStatus::Failed { .. } => true,
        AgentStatus::Blocked { on, .. } => {
            matches!(on.as_str(), "rate_limit" | "background_task" | "subagents")
        }
        AgentStatus::Working { activity, .. } => {
            activity == "starting_turn" && record.wake_until.is_some_and(|until| until <= now)
        }
        _ => false,
    }
}

/// `TransitionReadiness.refreshBlocked` (`:85`): every stored blocker follows its agent record.
pub fn refresh_blocked(
    conn: &std::sync::Arc<ace_store::Connection>,
    state: &ThreadState,
    now: i64,
) -> Result<(), EngineError> {
    let rows = stmt_cache::all_rows(conn, KEYS, vec![Cell::Text(state.thread_id.clone())])?;
    for row in rows {
        let Some(key) = row.get("agent_key").and_then(cell_text) else {
            continue;
        };
        let ready = state
            .agents
            .get(key)
            .is_none_or(|record| agent_ready(record, now));
        let params = vec![
            Cell::Text(state.thread_id.clone()),
            Cell::Text(key.to_owned()),
        ];
        if ready {
            stmt_cache::run(conn, REMOVE, params)?;
        } else {
            stmt_cache::run(conn, PUT, params)?;
        }
    }
    Ok(())
}

/// `TransitionReadiness.agentsReady` (`:88`): no stored blocker for the thread.
pub fn agents_ready(
    conn: &std::sync::Arc<ace_store::Connection>,
    thread: &str,
) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(conn, FIND, vec![Cell::Text(thread.to_owned())])?.is_none())
}

/// `TransitionReadiness.acceptsPersonInput` (`:92`): the root is between turns and free for the
/// person's next message.
pub fn accepts_person_input(state: &ThreadState, now: i64) -> bool {
    ace_core::person_input::accepts_person_input(state, now)
}

/// `repository.acceptsPersonInput` (`repository.ts:502`): an awaited first send keeps the thread
/// busy even before its run has started.
pub fn repository_accepts_person_input(state: &ThreadState, awaiting: bool, now: i64) -> bool {
    if !state.has_run && awaiting {
        return false;
    }
    accepts_person_input(state, now)
}

/// `repository.quiescent` (`repository.ts:492`): the thread's live work and every agent's
/// readiness.
pub fn repository_quiescent(state: &ThreadState, awaiting: bool, agents_ready: bool) -> bool {
    if !state.has_run && awaiting {
        return false;
    }
    ace_core::person_input::quiescent(state, agents_ready)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_blocker_row_follows_its_agent_and_an_empty_one_reads_ready() {
        let conn = home("t", &header("t"));
        let _store = Shell::store(&conn);
        assert!(agents_ready(&conn, "t").expect("ready"));
        let state =
            ace_json::from_value::<ThreadState>(&ace_json::parse(&header("t")).expect("json"))
                .expect("state");
        conn.exec("INSERT INTO engine_transition_blockers VALUES ('t', 'ghost')")
            .expect("blocker");
        assert!(!agents_ready(&conn, "t").expect("blocked"));
        // A blocker with no agent record is no longer work: the refresh removes it.
        refresh_blocked(&conn, &state, 10).expect("refresh");
        assert!(agents_ready(&conn, "t").expect("ready"));
    }

    #[test]
    fn a_first_send_still_awaited_keeps_the_thread_busy() {
        let state =
            ace_json::from_value::<ThreadState>(&ace_json::parse(&header("t")).expect("json"))
                .expect("state");
        assert!(quiescent_question(&state));
        assert!(!repository_quiescent(&state, true, true));
        assert!(!repository_accepts_person_input(&state, true, 10));
        assert!(repository_accepts_person_input(&state, false, 10));
    }

    fn quiescent_question(state: &ThreadState) -> bool {
        // `hasRun` false and nothing awaiting: the thread's live work decides.
        repository_quiescent(state, false, true)
    }
}
