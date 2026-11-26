// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4c as a synchronous receipt dependency; owned by E5.9.
//!
//! `transition-readiness.ts:85`-`:95` (`refreshBlocked`, `agentsReady`, `acceptsPersonInput`)
//! and `repository.ts:496`-`:507`'s two readiness questions, as E5.3's `MoveFacts` hooks: the
//! blocker rows decide whether the tree is between turns, which `admitSteer` and `readyForInput`
//! read synchronously. `capture` stays E5.9's, and the asynchronous paths that await
//! `whenRebuilt` are E5.5's and E5.9's.
//!
//! A cold-loaded thread answers from its stored rows: the root record and the interactions its
//! live index names are read when the state does not hold them, as the TypeScript's proxy reads
//! them, so never in proportion to history. `quiescent` reads E5.3's `QuiescenceView`, which
//! already loads the tasks it counts.
//!
//! **Rebuilt.** Both answering methods check the thread's readiness rebuild before they read
//! (E5.3 brief, "Readiness"): a thread not yet rebuilt answers false, never "done". E5.4's owner
//! decision of 2026-11-24 adds no fill, so the boot rebuild the TypeScript opener runs is the
//! answer for every thread in a home this build opened.

use crate::repository::collaborators::QuiescenceView;
use crate::repository::residency::cell_text;
use crate::snapshot::Snapshot;
use crate::{EngineError, State};
use ace_core::person_input::PersonInputFacts;
use ace_core::state::AgentRecord;
use ace_core::status::AgentStatus;
use ace_store::{Value as Cell, stmt_cache};
use std::cell::RefCell;
use std::rc::Rc;

const FIND: &str = "SELECT agent_key FROM engine_transition_blockers WHERE thread_id=? LIMIT 1";
const KEYS: &str = "SELECT agent_key FROM engine_transition_blockers WHERE thread_id=?";
const PUT: &str = "INSERT OR IGNORE INTO engine_transition_blockers VALUES (?, ?)";
const REMOVE: &str = "DELETE FROM engine_transition_blockers WHERE thread_id=? AND agent_key=?";

/// A root that has never started a run is a thread awaiting its first input. Core materializes
/// it as "starting" when any event arrives before a turn; that is not work in progress.
fn never_started(record: &AgentRecord) -> bool {
    record.agent.origin == "root"
        && matches!(record.agent.status, AgentStatus::Starting)
        && record.last_run.is_none()
}

/// `agentReady` (`transition-readiness.ts:17`).
pub(crate) fn agent_ready(record: &AgentRecord, now: i64) -> bool {
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

/// `TransitionReadiness.refreshBlocked` (`:85`): every stored blocker follows its agent record,
/// read through the snapshot's record cache (and the stored text patches it applies).
pub fn refresh_blocked(snapshot: &mut Snapshot, now: i64) -> Result<(), EngineError> {
    let thread = snapshot.state.thread_id.clone();
    let rows = stmt_cache::all_rows(&snapshot.conn, KEYS, vec![Cell::Text(thread.clone())])?;
    for row in rows {
        let Some(key) = row.get("agent_key").and_then(cell_text) else {
            continue;
        };
        let record = snapshot.agent(key)?;
        let ready = record
            .as_ref()
            .is_none_or(|record| agent_ready(record, now));
        let params = vec![Cell::Text(thread.clone()), Cell::Text(key.to_owned())];
        if ready {
            stmt_cache::run(&snapshot.conn, REMOVE, params)?;
        } else {
            stmt_cache::run(&snapshot.conn, PUT, params)?;
        }
    }
    Ok(())
}

/// `TransitionReadiness.acceptsPersonInput` (`:92`): the root is between turns and free for
/// the person's next message. The root and the interactions its index names are read through
/// the snapshot's records, one at a time: the cost is the live set, never the transcript.
pub fn accepts_person_input(
    state: &mut State,
    thread: &str,
    now: i64,
) -> Result<bool, EngineError> {
    let Some(snapshot) = state.readiness_snapshot(thread)? else {
        return Err(EngineError::MissingState);
    };
    let mut borrowed = snapshot
        .try_borrow_mut()
        .map_err(|_| EngineError::Reentrant)?;
    let Some(root_key) = borrowed.state.root_key.clone() else {
        return Ok(true);
    };
    let Some(root) = borrowed.agent(&root_key)? else {
        return Ok(true);
    };
    let keys: Vec<String> = borrowed
        .state
        .indexes
        .pending_interactions
        .keys()
        .cloned()
        .collect();
    let mut pending = Vec::new();
    for key in keys {
        if let Some(record) = borrowed.interaction(&key)?
            && record.agent_id == root.agent.id
        {
            pending.push(key);
        }
    }
    let facts = PersonInputFacts {
        provider_queue: borrowed.state.queue_sources.provider != 0,
        root: Some(&root),
        pending: &pending,
    };
    Ok(ace_core::person_input::accepts_person_input_facts(
        &facts, now,
    ))
}

/// `TransitionReadiness.agentsReady` (`:88`): no stored blocker for the thread.
pub fn agents_ready(
    conn: &std::sync::Arc<ace_store::Connection>,
    thread: &str,
) -> Result<bool, EngineError> {
    Ok(stmt_cache::get_row(conn, FIND, vec![Cell::Text(thread.to_owned())])?.is_none())
}

/// `TransitionReadiness.update` (`:59`): one agent's blocker row follows its record.
fn update(
    conn: &std::sync::Arc<ace_store::Connection>,
    thread: &str,
    key: &str,
    state: &ace_core::state::ThreadState,
    now: i64,
) -> Result<(), EngineError> {
    let ready = state
        .agents
        .get(key)
        .is_none_or(|record| agent_ready(record, now));
    let params = vec![Cell::Text(thread.to_owned()), Cell::Text(key.to_owned())];
    if ready {
        stmt_cache::run(conn, REMOVE, params)?;
    } else {
        stmt_cache::run(conn, PUT, params)?;
    }
    Ok(())
}

/// `TransitionReadiness`'s construction (`:54`): the boot rebuild drops every blocker and seeds
/// one for each stored agent record that is not ready. E5.3 runs it as an idle fill; it reads
/// only the agent records, never the transcript.
pub fn rebuild(conn: &std::sync::Arc<ace_store::Connection>, now: i64) -> Result<(), EngineError> {
    stmt_cache::run(conn, "DELETE FROM engine_transition_blockers", Vec::new())?;
    let rows = stmt_cache::all_rows(
        conn,
        "SELECT thread_id,key,value FROM engine_state_records WHERE section='agents'",
        Vec::new(),
    )?;
    for row in rows {
        let cell = |column: &str| row.get(column).and_then(cell_text).map(str::to_owned);
        let (Some(thread), Some(key), Some(value)) =
            (cell("thread_id"), cell("key"), cell("value"))
        else {
            continue;
        };
        let parsed =
            ace_json::parse(&value).map_err(|error| EngineError::Records(error.to_string()))?;
        let record: AgentRecord = ace_json::from_value(&parsed)
            .map_err(|error| EngineError::Records(error.to_string()))?;
        if !agent_ready(&record, now) {
            stmt_cache::run(conn, PUT, vec![Cell::Text(thread), Cell::Text(key)])?;
        }
    }
    Ok(())
}

/// `TransitionReadiness.capture` (`:63`): the agents a batch's events touched get their blocker
/// row from the state the batch produced. Events that name no known agent change nothing, and
/// the order is the batch's own, as the TypeScript's `Set` keeps it.
pub fn capture(
    state: &ace_core::state::ThreadState,
    conn: &std::sync::Arc<ace_store::Connection>,
    events: &[ace_json::Value],
    now: i64,
) -> Result<(), EngineError> {
    let mut changed: Vec<&str> = Vec::new();
    for event in events {
        let kind = event.get("type").and_then(ace_json::Value::as_str);
        let id = match kind {
            Some("agent.created") => event
                .get("agent")
                .and_then(|agent| agent.get("id"))
                .and_then(ace_json::Value::as_str),
            Some("agent.status" | "agent.updated") => {
                event.get("agentId").and_then(ace_json::Value::as_str)
            }
            Some("run.started") => event
                .get("run")
                .and_then(|run| run.get("agentId"))
                .and_then(ace_json::Value::as_str),
            Some("run.ended") => event
                .get("runId")
                .and_then(ace_json::Value::as_str)
                .and_then(|run| state.runs.get(run))
                .map(|run| run.agent_id.as_str()),
            _ => None,
        };
        let Some(key) = id
            .and_then(|id| state.indexes.agent_keys_by_id.get(id))
            .map(String::as_str)
        else {
            continue;
        };
        if !changed.contains(&key) {
            changed.push(key);
        }
    }
    for key in changed {
        update(conn, &state.thread_id, key, state, now)?;
    }
    Ok(())
}

/// `quiescent` (`transition-history.ts:8`): the tree holds no live work and every agent is
/// ready. The view carries the counts E5.3 loaded.
pub fn quiescent(view: &QuiescenceView, agents_ready: bool) -> bool {
    // Exit.unsettled records agents that were live before exit, not work still running.
    if view.provider_queue
        || view.live_tools > 0
        || view.pending_interactions > 0
        || view.provider_work
    {
        return false;
    }
    agents_ready
}

impl State {
    /// The engine's clock, as `TransitionReadiness`'s `now` (`transition-readiness.ts:40`).
    pub(crate) fn readiness_now(&self) -> i64 {
        self.engine
            .upgrade()
            .map(|core| core.ports.now() as i64)
            .unwrap_or(0)
    }

    /// The thread's snapshot: resident, else loaded from the store. A caller never holds a
    /// borrow of it across these hooks (E5.3's collaborator rule).
    pub(crate) fn readiness_snapshot(
        &mut self,
        thread: &str,
    ) -> Result<Option<Rc<RefCell<Snapshot>>>, EngineError> {
        if let Some(snapshot) = self.repo.snapshots.get(thread) {
            return Ok(Some(Rc::clone(snapshot)));
        }
        let Some(core) = self.engine.upgrade() else {
            return Ok(None);
        };
        self.repo.state(&core.store, thread)
    }

    /// `readiness.refreshBlocked` by thread, for the fold's tick path, which must release its
    /// borrow first.
    pub(crate) fn refresh_blocked_now(
        &mut self,
        thread: &str,
        now: i64,
    ) -> Result<(), EngineError> {
        let Some(snapshot) = self.readiness_snapshot(thread)? else {
            return Ok(());
        };
        let mut borrowed = snapshot
            .try_borrow_mut()
            .map_err(|_| EngineError::Reentrant)?;
        refresh_blocked(&mut borrowed, now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    #[test]
    fn a_blocker_row_follows_its_agent_and_an_empty_one_reads_ready() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        assert!(agents_ready(&conn, "t").expect("ready"));
        conn.exec("INSERT INTO engine_transition_blockers VALUES ('t', 'ghost')")
            .expect("blocker");
        assert!(!agents_ready(&conn, "t").expect("blocked"));
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let snapshot = state.repo.require_state(&store, "t").expect("snapshot");
        // A blocker with no agent record is no longer work: the refresh removes it.
        refresh_blocked(&mut snapshot.borrow_mut(), 10).expect("refresh");
        assert!(agents_ready(&conn, "t").expect("ready"));
        // A blocker whose agent has an active run stays: the record is read through Records.
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'agents', 'root', {})",
            agent_record()
        ))
        .expect("agent");
        conn.exec("INSERT INTO engine_transition_blockers VALUES ('t', 'root')")
            .expect("blocker");
        refresh_blocked(&mut snapshot.borrow_mut(), 10).expect("refresh");
        assert!(
            !agents_ready(&conn, "t").expect("blocked"),
            "the stored run keeps it"
        );
    }

    #[test]
    fn a_stored_record_is_read_through_the_records_with_its_text_patches() {
        let conn = home("t", &agent_header());
        let store = Shell::store(&conn);
        // The row alone is a ready idle root; the patch is what gives it an active run.
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'agents', 'root', {})",
            idle_agent_record()
        ))
        .expect("agent");
        conn.exec(
            "INSERT INTO engine_state_appends (thread_id, section, key, patch) VALUES ('t', 'agents', 'root', '{\"path\":[\"activeRun\"],\"text\":\"run-1\"}')",
        )
        .expect("patch");
        conn.exec("INSERT INTO engine_transition_blockers VALUES ('t', 'root')")
            .expect("blocker");
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let snapshot = state.repo.require_state(&store, "t").expect("snapshot");
        refresh_blocked(&mut snapshot.borrow_mut(), 10).expect("refresh");
        assert!(
            !agents_ready(&conn, "t").expect("blocked"),
            "the patched active run keeps the blocker"
        );
    }

    #[test]
    fn a_cold_loaded_root_with_an_active_run_does_not_accept_person_input() {
        let conn = home("t", &agent_header());
        let store = Shell::store(&conn);
        // The root's record is a stored row, not part of the header: only a read loads it.
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'agents', 'root', {})",
            agent_record()
        ))
        .expect("agent");
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let snapshot = state.repo.require_state(&store, "t").expect("snapshot");
        assert!(
            snapshot.borrow().state.agents.is_empty(),
            "a cold snapshot holds no agents until a read loads one"
        );
        let cold = snapshot.borrow().state.clone();
        assert!(
            ace_core::person_input::accepts_person_input(&cold, 0),
            "the cold state alone reads no root, which is the bug the load fixes"
        );
        assert!(
            !accepts_person_input(&mut state, "t", 0).expect("an answer"),
            "the root's active run holds the thread"
        );
    }

    #[test]
    fn a_stored_root_that_cannot_decode_fails_instead_of_reading_as_no_root() {
        let conn = home("t", &agent_header());
        let store = Shell::store(&conn);
        conn.exec("INSERT INTO engine_state_records VALUES ('t', 'agents', 'root', '{not json')")
            .expect("corrupt agent");
        let mut state = State::default();
        state.repo.probe_passthrough = true;
        let _ = state.repo.require_state(&store, "t").expect("snapshot");
        let error = accepts_person_input(&mut state, "t", 0).expect_err("a corrupt row fails");
        assert!(
            !error.to_string().is_empty(),
            "the decode error is reported, not swallowed as an absent root"
        );
    }

    // From `transition-readiness.ts:54`: the boot rebuild forgets every blocker and seeds one
    // per stored agent that is not ready.
    #[test]
    fn a_boot_rebuild_seeds_only_the_unready_stored_agents() {
        let conn = home("t", &header("t"));
        conn.exec("INSERT INTO engine_transition_blockers VALUES ('t', 'stale')")
            .expect("stale blocker");
        let stored =
            |value: serde_json::Value| format!("'{}'", value.to_string().replace('\'', "''"));
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'agents', 'working', {})",
            stored(agent_json("a-working", "working", Some("run-1")))
        ))
        .expect("working");
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'agents', 'idle', {})",
            stored(agent_json("a-idle", "idle", None))
        ))
        .expect("idle");
        rebuild(&conn, 10).expect("rebuild");
        let keys = stmt_cache::all_rows(&conn, KEYS, vec![Cell::Text("t".into())])
            .expect("rows")
            .iter()
            .filter_map(|row| row.get("agent_key").and_then(cell_text).map(str::to_owned))
            .collect::<Vec<_>>();
        assert_eq!(keys, ["working"]);
    }

    #[test]
    fn a_captured_batch_moves_only_the_blockers_whose_agents_it_names() {
        let conn = home("t", &header("t"));
        let mut state = state();
        state.thread_id = "t".into();
        let mut working = agent_json("a-root", "working", Some("run-1"));
        working["activeRun"] = serde_json::json!("run-1");
        state.agents.insert(
            "root".into(),
            serde_json::from_value(working).expect("a working root"),
        );
        state
            .indexes
            .agent_keys_by_id
            .insert("a-root".into(), "root".into());
        state.runs.insert(
            "run-1".into(),
            serde_json::from_value(serde_json::json!({
                "id": "run-1", "threadId": "t", "agentId": "a-root", "trigger": "person", "state": "active", "startedAt": 1
            }))
            .expect("a run"),
        );
        let status = |kind: &str| {
            vec![
                ace_json::parse(&format!(r#"{{"type":"{kind}","agentId":"a-root"}}"#))
                    .expect("event"),
            ]
        };
        // The working root blocks a transition.
        capture(&state, &conn, &status("agent.status"), 10).expect("capture");
        assert!(!agents_ready(&conn, "t").expect("ready"));
        // The same event after the batch made it idle clears the row.
        state.agents.insert(
            "root".into(),
            serde_json::from_value(agent_json("a-root", "idle", None)).expect("idle root"),
        );
        capture(&state, &conn, &status("agent.status"), 10).expect("capture");
        assert!(agents_ready(&conn, "t").expect("ready"));
        // A blocker another agent holds is not touched by an event that names this one, nor by
        // an event that names no known agent.
        conn.exec("INSERT INTO engine_transition_blockers VALUES ('t', 'child')")
            .expect("blocker");
        let unknown = vec![
            ace_json::parse(r#"{"type":"agent.updated","agentId":"ghost"}"#).expect("event"),
            ace_json::parse(r#"{"type":"item.created","item":{"id":"i"}}"#).expect("event"),
        ];
        capture(&state, &conn, &unknown, 10).expect("capture");
        assert!(!agents_ready(&conn, "t").expect("the child still blocks"));
    }

    #[test]
    fn a_run_end_resolves_its_agent_through_the_states_run_index() {
        let conn = home("t", &header("t"));
        let mut state = state();
        state.thread_id = "t".into();
        state.agents.insert(
            "child".into(),
            serde_json::from_value(agent_json("a-child", "idle", None)).expect("a child"),
        );
        state
            .indexes
            .agent_keys_by_id
            .insert("a-child".into(), "child".into());
        state.runs.insert(
            "run-2".into(),
            serde_json::from_value(serde_json::json!({
                "id": "run-2", "threadId": "t", "agentId": "a-child", "trigger": "agent", "state": "active", "startedAt": 1
            }))
            .expect("a run"),
        );
        conn.exec("INSERT INTO engine_transition_blockers VALUES ('t', 'child')")
            .expect("blocker");
        // A run.started whose agent id has ended and whose record is idle clears the row.
        let events = vec![
            ace_json::parse(r#"{"type":"run.ended","runId":"run-2","state":"done"}"#)
                .expect("event"),
        ];
        capture(&state, &conn, &events, 10).expect("capture");
        assert!(agents_ready(&conn, "t").expect("ready"));
        // A run.segment that names no run leaves the row alone.
        conn.exec("INSERT INTO engine_transition_blockers VALUES ('t', 'child')")
            .expect("blocker");
        let events = vec![
            ace_json::parse(r#"{"type":"run.ended","runId":"gone","state":"done"}"#)
                .expect("event"),
        ];
        capture(&state, &conn, &events, 10).expect("capture");
        assert!(!agents_ready(&conn, "t").expect("still blocked"));
    }

    /// The smallest state the status rules accept, with the thread the home names.
    fn state() -> ace_core::state::ThreadState {
        serde_json::from_value(serde_json::json!({
            "threadId": "t",
            "config": { "provider": "claude", "silenceMs": 1000 },
            "status": { "state": "done" },
            "agents": {},
            "runs": {},
            "items": {},
            "interactions": {},
            "tasks": {},
            "interactionHistory": {},
            "taskHistory": {},
            "indexes": {
                "liveTools": {}, "pendingInteractions": {}, "runningTasks": {},
                "agentKeysById": {}, "childrenByParent": {}, "pendingSpawnLinks": {},
                "pendingItemLinks": {}
            },
            "outcomeOrder": 0,
            "pendingNotices": [],
            "itemLinks": {},
            "queueCount": 0,
            "queueSources": { "engine": 0, "provider": 0 },
            "hasRun": false
        }))
        .expect("a state")
    }

    /// One agent record in the stored shape.
    fn agent_json(id: &str, state: &str, run: Option<&str>) -> serde_json::Value {
        let status = if state == "working" {
            serde_json::json!({ "state": state, "activity": "thinking" })
        } else {
            serde_json::json!({ "state": state })
        };
        let mut record = serde_json::json!({
            "agent": {
                "id": id, "threadId": "t", "origin": "root",
                "native": { "provider": "claude" }, "fidelity": "full", "cwd": "/w",
                "status": status, "createdAt": 0
            },
            "activity": state,
            "lastSignalAt": 0
        });
        if let Some(run) = run {
            record["activeRun"] = serde_json::json!(run);
        }
        record
    }

    #[test]
    fn an_unready_agent_or_live_work_is_not_quiescent() {
        let view = |live_tools: usize, pending: usize, provider_work: bool| QuiescenceView {
            provider_queue: false,
            live_tools,
            pending_interactions: pending,
            provider_work,
        };
        assert!(quiescent(&view(0, 0, false), true));
        assert!(!quiescent(&view(0, 0, false), false));
        assert!(!quiescent(&view(1, 0, false), true));
        assert!(!quiescent(&view(0, 1, false), true));
        assert!(!quiescent(&view(0, 0, true), true));
    }

    /// The fixture header with a root key, so the snapshot knows which agent is its root.
    fn agent_header() -> String {
        header("t").replace(
            "\"initialRoot\":{\"agent\":\"root\"",
            "\"rootKey\":\"root\",\"initialRoot\":{\"agent\":\"root\"",
        )
    }

    /// The root's stored record JSON: its agent and an active run.
    fn agent_record() -> &'static str {
        r#"'{"agent":{"id":"root","threadId":"t","origin":"root","native":{"provider":"codex"},"fidelity":"full","cwd":"/tmp","status":{"state":"working","activity":"thinking"},"createdAt":1},"activity":"thinking","lastSignalAt":2,"activeRun":"run-1"}'"#
    }

    /// The same root, idle, with no run: the row alone reads ready.
    fn idle_agent_record() -> &'static str {
        r#"'{"agent":{"id":"root","threadId":"t","origin":"root","native":{"provider":"codex"},"fidelity":"full","cwd":"/tmp","status":{"state":"idle"},"createdAt":1},"activity":"idle","lastSignalAt":2}'"#
    }
}
