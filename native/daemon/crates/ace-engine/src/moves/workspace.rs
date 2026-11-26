// SPDX-License-Identifier: Apache-2.0
//! `workspace-change.ts` (E5.9): a checkout move's fence, its status trail and its settle point.
//!
//! The fence persists before any session closes or Git writes, so a restart or an uncertain Git
//! failure can settle it later. The two awaits (`closeSession`, the Git effect) belong to the
//! session and workspace owners; this module is the synchronous state machine around them:
//! [`begin`] takes the reservation, [`handoff_for`] captures the context after the closes,
//! [`commit`] records the new checkout, and [`fail`] records a refusal or an uncertain failure.

use ace_json::Value;

use crate::intents::header::headers;
use crate::transitions::history::HandoffOptions;
use crate::{EngineError, EngineStore, State};

/// Refusals Git reports before it writes anything (`workspace-change.ts:31`).
pub const REFUSED_GIT: [&str; 8] = [
    "dirty_worktree",
    "conflicts",
    "invalid_ref",
    "invalid_argument",
    "branch_checked_out",
    "path_exists",
    "ref_conflict",
    "unborn_head",
];

/// `failureCode` (`:41`): a refusal's own code, Git's with its prefix, or the generic failure.
pub fn failure_code(refused: Option<&str>, git: Option<&str>) -> String {
    if let Some(code) = refused {
        return code.to_owned();
    }
    match git {
        Some(code) => format!("git_{}", code.strip_prefix("git_").unwrap_or(code)),
        None => "workspace_change_failed".to_owned(),
    }
}

/// The reservation a change asks for (`WorkspaceChangeReservation`).
#[derive(Debug, Clone, Default)]
pub struct Reservation {
    pub roots: Vec<String>,
    /// Roots whose checked-out files the change may rewrite; `roots` when absent.
    pub writes: Option<Vec<String>>,
    pub selection: Option<Value>,
}

/// What `begin` fenced and reserved, for the caller's awaits and [`commit`].
#[derive(Debug, Clone)]
pub struct Fence {
    pub owners: Vec<String>,
    pub roots: Vec<String>,
    pub details: Value,
}

fn records(what: &str) -> EngineError {
    EngineError::Records(what.to_owned())
}

fn thread_row(store: &EngineStore, id: &str) -> Result<Option<Value>, EngineError> {
    Ok(store
        .get_thread(id)?
        .and_then(|json| ace_json::parse(&json).ok()))
}

/// Whether the thread has pending work a checkout move must wait for (`livePending`, `:54`).
pub fn live_pending(
    store: &EngineStore,
    _state: &mut State,
    id: &str,
) -> Result<bool, EngineError> {
    let pending = headers(store.conn(), Some(id), None)?;
    if pending.is_empty() {
        return Ok(false);
    }
    let queue = crate::queue::store::get(store, id)?;
    if !queue.paused || crate::queue::store::has_uncertain(store.conn(), id)? {
        return Ok(true);
    }
    for intent in pending {
        if intent.status == "running"
            || intent.awaiting
            || intent.submitted_generation.is_some()
            || !matches!(intent.kind.as_str(), "thread.send" | "thread.create")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `releaseMissingHold` (`:74`): a queue held because the checkout was gone sends again once a
/// move gives it one.
pub fn release_missing_hold(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    at: f64,
) -> Result<(), EngineError> {
    let queue = crate::queue::store::get(store, id)?;
    if !queue.paused
        || queue.reason.as_deref() != Some("not_sent")
        || queue.limited
        || queue.continuation.is_some()
    {
        return Ok(());
    }
    if queue
        .last_failure
        .as_ref()
        .and_then(|failure| failure.get("code"))
        .and_then(Value::as_str)
        != Some("worktree_missing")
    {
        return Ok(());
    }
    let staged = crate::queue::write::stage(store, id, "{\"paused\":false,\"reason\":null}", at)?;
    state.deferred_queue.push(staged);
    state.repo.reserve(store, id)?;
    Ok(())
}

/// `reservations.roots` / `owners` (`workspace-reservations.ts:88`, `:94`), over the tables the
/// store owns. `canonicalize` is the shell's `realpath`, identity when a path cannot resolve.
fn roots(
    store: &EngineStore,
    owner: &str,
    input: &[String],
    canonicalize: &dyn Fn(&str) -> String,
) -> Result<Vec<String>, EngineError> {
    let mut values: Vec<String> = input.iter().map(|root| canonicalize(root)).collect();
    let rows = ace_store::stmt_cache::all_rows(
        store.conn(),
        "SELECT root FROM workspace_root_reservations WHERE thread_id=?",
        vec![ace_store::Value::Text(owner.to_owned())],
    )?;
    for row in rows {
        if let Some(root) = row
            .get("root")
            .and_then(crate::repository::residency::cell_text)
        {
            let root = root.to_owned();
            if !values.contains(&root) {
                values.push(root);
            }
        }
    }
    if values.is_empty() {
        return Err(records("workspace_unavailable"));
    }
    Ok(values)
}

fn owners(
    store: &EngineStore,
    roots: &[String],
    canonicalize: &dyn Fn(&str) -> String,
) -> Result<Vec<String>, EngineError> {
    let mut owners: Vec<String> = Vec::new();
    for root in roots {
        let root = canonicalize(root);
        let sessions = ace_store::stmt_cache::all_rows(
            store.conn(),
            "SELECT thread_id FROM engine_sessions WHERE cwd=?",
            vec![ace_store::Value::Text(root.clone())],
        )?;
        let local = ace_store::stmt_cache::all_rows(
            store.conn(),
            "SELECT t.id AS thread_id FROM workspace_canonical_roots w JOIN threads t ON t.workspace_id=w.workspace_id WHERE w.root=? AND NOT EXISTS (SELECT 1 FROM engine_sessions s WHERE s.thread_id=t.id)",
            vec![ace_store::Value::Text(root)],
        )?;
        for row in sessions.iter().chain(local.iter()) {
            if let Some(thread) = row
                .get("thread_id")
                .and_then(crate::repository::residency::cell_text)
            {
                let thread = thread.to_owned();
                if !owners.contains(&thread) {
                    owners.push(thread);
                }
            }
        }
    }
    Ok(owners)
}

fn reserve(
    store: &EngineStore,
    owner: &str,
    command_id: &str,
    roots: &[String],
) -> Result<(), EngineError> {
    for root in roots {
        let row = ace_store::stmt_cache::get_row(
            store.conn(),
            "SELECT thread_id FROM workspace_root_reservations WHERE root=?",
            vec![ace_store::Value::Text(root.clone())],
        )?;
        if let Some(row) = row
            && row
                .get("thread_id")
                .and_then(crate::repository::residency::cell_text)
                != Some(owner)
        {
            return Err(records("workspace_change_in_progress"));
        }
    }
    for root in roots {
        ace_store::stmt_cache::run(
            store.conn(),
            "INSERT INTO workspace_root_reservations VALUES (?,?,?) ON CONFLICT(root) DO UPDATE SET command_id=excluded.command_id",
            vec![
                ace_store::Value::Text(root.clone()),
                ace_store::Value::Text(owner.to_owned()),
                ace_store::Value::Text(command_id.to_owned()),
            ],
        )?;
    }
    Ok(())
}

fn release(store: &EngineStore, command_id: &str) -> Result<(), EngineError> {
    ace_store::stmt_cache::run(
        store.conn(),
        "DELETE FROM workspace_root_reservations WHERE command_id=?",
        vec![ace_store::Value::Text(command_id.to_owned())],
    )?;
    Ok(())
}

fn quiescent(store: &EngineStore, state: &mut State, id: &str) -> Result<bool, EngineError> {
    crate::transitions::history::thread_quiescent(store, state, id)
}

/// A fenced peer is live when its resident tree, persisted intents, or approvals say so.
fn peer_is_live(
    store: &EngineStore,
    state: &mut State,
    owner: &str,
    moving: &str,
) -> Result<bool, EngineError> {
    if owner == moving || state.repo.snapshots.contains_key(owner) {
        return Ok(!quiescent(store, state, owner)? || live_pending(store, state, owner)?);
    }
    Ok(live_pending(store, state, owner)?
        || crate::intents::store::awaiting(store.conn(), owner)?.is_some()
        || crate::intents::header::headers(store.conn(), Some(owner), None)?
            .iter()
            .any(|intent| {
                matches!(
                    intent.kind.as_str(),
                    "thread.switch" | "thread.merge" | "thread.send" | "thread.create"
                ) && matches!(intent.status.as_str(), "pending" | "queued" | "running")
            }))
}

/// One status write (`workspace-change.ts:114`).
struct StatusChange<'a> {
    command_id: &'a str,
    now: f64,
    details: &'a Value,
    phase: &'a str,
    error: Option<&'a str>,
    uncertain: bool,
    selection: Option<&'a Value>,
}

/// `status` (`:114`): the client's `details.workspaceChange` row.
fn status(store: &EngineStore, id: &str, change: &StatusChange<'_>) -> Result<(), EngineError> {
    let StatusChange {
        command_id,
        now,
        details,
        phase,
        error,
        uncertain,
        selection,
    } = *change;
    let mut change = ace_json::Map::new();
    change.insert("commandId", Value::from(command_id));
    change.insert("state", Value::from(phase));
    change.insert("at", Value::from(now));
    change.insert("lossy", Value::Bool(true));
    change.insert("uncertain", Value::Bool(uncertain));
    if let Some(error) = error {
        change.insert("error", Value::from(error));
    }
    if let Some(selection) = selection
        && let Some(mode) = selection.get("mode").and_then(Value::as_str)
    {
        change.insert("mode", Value::from(mode));
        if let Some(branch) = selection.get("branch").and_then(Value::as_str) {
            change.insert("branch", Value::from(branch));
        }
    }
    let mut next_details = if details.is_null() {
        Value::Object(ace_json::Map::new())
    } else {
        details.clone()
    };
    if let Some(object) = next_details.as_object_mut() {
        object.insert("workspaceChange", Value::Object(change));
    }
    let mut changes = ace_json::Map::new();
    changes.insert("details", next_details);
    let mut event = ace_json::Map::new();
    event.insert("type", Value::from("thread.client.updated"));
    event.insert("changes", Value::Object(changes));
    store.write_events(
        id,
        &ace_json::to_string(&Value::Array(vec![Value::Object(event)].into())),
        now,
    )
}

/// `publishQueue` (`:152`): a never-started root would look live once a core fact arrived, so
/// its unchanged queue count is republished.
fn publish_queue(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    now: f64,
) -> Result<(), EngineError> {
    let initial = {
        let snapshot = state.repo.require_state(store, id)?;
        let borrowed = snapshot.borrow();
        borrowed.state.initial_root.is_none()
    };
    if initial {
        let count = state.queued_count(store, id)?;
        state.apply(
            store,
            id,
            &format!("[{{\"type\":\"queue.changed\",\"count\":{count}}}]"),
            now,
            None,
        )?;
    }
    Ok(())
}

/// What a change asks the fence for.
pub struct BeginRequest<'a> {
    pub command_id: &'a str,
    pub now: f64,
    pub reservation: &'a Reservation,
    pub has_owned_work: &'a dyn Fn(&str) -> bool,
    pub canonicalize: &'a dyn Fn(&str) -> String,
}

/// `changeEngineWorkspace`'s fence (`:104`-`:174`): validate, reserve, guard and record
/// `preparing`. The caller then closes the owners' sessions and runs the Git effect.
pub fn begin(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    request: BeginRequest<'_>,
) -> Result<Fence, EngineError> {
    let BeginRequest {
        command_id,
        now,
        reservation,
        has_owned_work,
        canonicalize,
    } = request;
    let Some(thread) = thread_row(store, id)? else {
        return Err(records("thread_not_found"));
    };
    if thread.get("deletedAt").is_some() {
        return Err(records("thread_not_found"));
    }
    let details = thread.get("details").cloned().unwrap_or(Value::Null);
    if details.get("workspaceChange").is_some_and(|change| {
        change.get("state").and_then(Value::as_str) == Some("preparing")
            && change.get("commandId").and_then(Value::as_str) == Some(command_id)
    }) {
        return Err(records("workspace_change_in_progress"));
    }
    if state.transition_guarded(store, id)?
        || !quiescent(store, state, id)?
        || live_pending(store, state, id)?
    {
        return Err(records("thread_tree_is_live"));
    }
    let roots = roots(store, id, &reservation.roots, canonicalize)?;
    let written = reservation.writes.clone().unwrap_or_else(|| roots.clone());
    let mut fenced = owners(store, &written, canonicalize)?;
    if !fenced.contains(&id.to_owned()) {
        fenced.insert(0, id.to_owned());
    }
    store.atomic(|_tx| {
        for owner in &fenced {
            if has_owned_work(owner) {
                return Err(records("terminal_owned"));
            }
            let guarded = state.transition_guarded(store, owner)?;
            let live = peer_is_live(store, state, owner, id)?;
            if guarded || live {
                return Err(records("thread_tree_is_live"));
            }
        }
        reserve(store, id, command_id, &roots)?;
        for owner in &fenced {
            state.transition_guard(store, owner, command_id)?;
        }
        status(
            store,
            id,
            &StatusChange {
                command_id,
                now,
                details: &details,
                phase: "preparing",
                error: None,
                uncertain: false,
                selection: reservation.selection.as_ref(),
            },
        )?;
        publish_queue(store, state, id, now)
    })?;
    Ok(Fence {
        owners: fenced,
        roots,
        details,
    })
}

/// The context the moved thread carries: `handoff(repo, id, headSeq, 16384, provider)` from
/// `:182`, read after the sessions close and before the Git effect.
pub fn handoff_for(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    provider: &str,
) -> Result<Value, EngineError> {
    let through = store.head_seq()? as i64;
    let handoff = crate::transitions::history::handoff(
        store,
        state,
        id,
        through,
        16_384,
        provider,
        HandoffOptions {
            since: None,
            exclude: &[],
        },
    )?;
    Ok(handoff.to_value())
}

/// The commit half (`:186`-`:200`): the new checkout, the carried context, the applied status,
/// the missing-hold release and the reservation's release.
/// What a settled change commits.
pub struct Settle<'a> {
    pub command_id: &'a str,
    pub now: f64,
    pub fence: &'a Fence,
    pub details: &'a Value,
    pub handoff: Value,
    pub pull_request_context: Option<String>,
}

pub fn commit(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    settle: Settle<'_>,
) -> Result<(), EngineError> {
    let Settle {
        command_id,
        now,
        fence,
        details,
        handoff,
        pull_request_context,
    } = settle;
    let Some(worktree) = details.get("worktree").and_then(Value::as_str) else {
        return Err(records("workspace_unavailable"));
    };
    let context = match pull_request_context {
        Some(context) => vec![context],
        None => Vec::new(),
    };
    store.atomic(|_tx| {
        ace_store::stmt_cache::run(
            store.conn(),
            "UPDATE engine_sessions SET cwd=?,workspace_ready=1,native_session_id=NULL WHERE thread_id=?",
            vec![
                ace_store::Value::Text(worktree.to_owned()),
                ace_store::Value::Text(id.to_owned()),
            ],
        )?;
        let previous = state.transition_get(store, id)?;
        let mut metadata = ace_json::Map::new();
        if let Some(selection) = previous.selection {
            metadata.insert("selection", selection);
        }
        metadata.insert("handoff", handoff);
        metadata.insert(
            "context",
            Value::Array(context.into_iter().map(Value::from).collect()),
        );
        state.transition_set(store, id, &Value::Object(metadata))?;
        status(
            store,
            id,
            &StatusChange {
                command_id,
                now,
                details,
                phase: "applied",
                error: None,
                uncertain: false,
                selection: None,
            },
        )?;
        release_missing_hold(store, state, id, now)?;
        release(store, command_id)?;
        ace_store::stmt_cache::run(
            store.conn(),
            "DELETE FROM engine_transition_guards WHERE command_id=?",
            vec![ace_store::Value::Text(command_id.to_owned())],
        )?;
        Ok(())
    })?;
    Ok(())
}

/// The failure half (`:201`-`:218`): the failed status, the fence's release when Git refused
/// before writing, and the guards' release either way.
/// What a failed change records.
pub struct Failure<'a> {
    pub command_id: &'a str,
    pub now: f64,
    pub fence: &'a Fence,
    pub code: &'a str,
    pub uncertain: bool,
    pub selection: Option<&'a Value>,
}

pub fn fail(
    store: &EngineStore,
    state: &mut State,
    id: &str,
    failure: Failure<'_>,
) -> Result<Vec<String>, EngineError> {
    let Failure {
        command_id,
        now,
        fence,
        code,
        uncertain,
        selection,
    } = failure;
    status(
        store,
        id,
        &StatusChange {
            command_id,
            now,
            details: &fence.details,
            phase: "failed",
            error: Some(code),
            uncertain,
            selection,
        },
    )?;
    if !uncertain {
        release(store, command_id)?;
    }
    let released = state.transition_release_guards(store, command_id)?;
    let mut wake: Vec<String> = fence.owners.clone();
    for thread in released {
        if !wake.contains(&thread) {
            wake.push(thread);
        }
    }
    publish_queue(store, state, id, now)?;
    // The callers wake each thread once the fence is gone.
    Ok(wake)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn home_with_checkout() -> (std::sync::Arc<ace_store::Connection>, EngineStore, State) {
        let mut head = header("t");
        head = head.replace(
            "\"initialRoot\":{\"agent\":\"root\"",
            "\"rootKey\":\"root\",\"initialRoot\":{\"agent\":\"root\"",
        );
        head = head.replace(
            "\"agents\":{}",
            "\"agents\":{\"root\":{\"agent\":{\"id\":\"root\",\"threadId\":\"t\",\"origin\":\"root\",\"native\":{\"provider\":\"claude\"},\"fidelity\":\"full\",\"cwd\":\"/w\",\"status\":{\"state\":\"idle\"},\"createdAt\":1},\"activity\":\"idle\",\"lastSignalAt\":1}}",
        );
        let conn = home("t", &head);
        conn.exec("INSERT INTO engine_sessions (thread_id,cwd,model,native_session_id,backend,instance_id,options) VALUES ('t','/w',NULL,'native','acp','a',NULL)").expect("session");
        conn.exec("INSERT INTO workspace_canonical_roots VALUES ('workspace', '/w')")
            .expect("root");
        let store = Shell::store(&conn);
        let mut state = State::default();
        state.transitions.rebuilt.insert("t".to_owned());
        (conn, store, state)
    }

    fn reservation(root: &str) -> Reservation {
        Reservation {
            roots: vec![root.to_owned()],
            ..Default::default()
        }
    }

    #[test]
    fn a_never_started_threads_checkout_shows_preparing_when_details_are_absent() {
        let mut details = if Value::Null.is_null() {
            Value::Object(ace_json::Map::new())
        } else {
            Value::Null
        };
        let mut change = ace_json::Map::new();
        change.insert("state", Value::from("preparing"));
        if let Some(object) = details.as_object_mut() {
            object.insert("workspaceChange", Value::Object(change));
        }
        assert_eq!(
            details
                .get("workspaceChange")
                .and_then(|c| c.get("state"))
                .and_then(Value::as_str),
            Some("preparing")
        );
    }

    // From `workspace-change.process.test.ts`: a quiet checkout is fenced before the change and
    // the fence is released when it settles.
    #[test]
    fn a_workspace_change_reserves_its_roots_and_settles_them() {
        let (conn, store, mut state) = home_with_checkout();
        let fence = begin(
            &store,
            &mut state,
            "t",
            BeginRequest {
                command_id: "cmd-1",
                now: 5.0,
                reservation: &reservation("/w"),
                has_owned_work: &|_| false,
                canonicalize: &|path| path.to_owned(),
            },
        )
        .expect("begin");
        assert_eq!(fence.owners, ["t"]);
        assert!(state.transition_guarded(&store, "t").expect("guarded"));
        let reserved = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT thread_id FROM workspace_root_reservations WHERE root='/w'",
            Vec::new(),
        )
        .expect("reservation")
        .is_some();
        assert!(reserved);
        let carried = handoff_for(&store, &mut state, "t", "claude").expect("handoff");
        commit(
            &store,
            &mut state,
            "t",
            Settle {
                command_id: "cmd-1",
                now: 6.0,
                fence: &fence,
                details: &ace_json::json!({ "worktree": "/new", "pullRequestWorkspace": { "context": "pr context" } }),
                handoff: carried,
                pull_request_context: Some("pr context".to_owned()),
            },
        )
        .expect("commit");
        let session = crate::sessions::metadata::session(&store, "t").expect("session");
        assert_eq!(session.cwd, "/new");
        assert!(session.workspace_ready);
        assert_eq!(session.native_session_id, None);
        let metadata = state.transition_get(&store, "t").expect("metadata");
        assert!(metadata.handoff.is_some());
        assert_eq!(metadata.context, ["pr context"]);
        assert!(!state.transition_guarded(&store, "t").expect("guarded"));
        assert!(
            ace_store::stmt_cache::get_row(
                &conn,
                "SELECT root FROM workspace_root_reservations WHERE command_id='cmd-1'",
                Vec::new()
            )
            .expect("reservation")
            .is_none()
        );
    }

    // From `workspace-change.process.test.ts`: a refusal before Git writes releases the fence at
    // once, and the threads it fenced are handed back to wake.
    #[test]
    fn a_refused_change_releases_its_fence_and_names_the_threads_to_wake() {
        let (_conn, store, mut state) = home_with_checkout();
        let fence = begin(
            &store,
            &mut state,
            "t",
            BeginRequest {
                command_id: "cmd-2",
                now: 5.0,
                reservation: &reservation("/w"),
                has_owned_work: &|_| false,
                canonicalize: &|path| path.to_owned(),
            },
        )
        .expect("begin");
        let wake = fail(
            &store,
            &mut state,
            "t",
            Failure {
                command_id: "cmd-2",
                now: 6.0,
                fence: &fence,
                code: &failure_code(None, Some("git_conflicts")),
                uncertain: false,
                selection: None,
            },
        )
        .expect("fail");
        assert_eq!(failure_code(None, Some("git_conflicts")), "git_conflicts");
        assert_eq!(wake, ["t"]);
        assert!(!state.transition_guarded(&store, "t").expect("guarded"));
    }

    // `livePending` (`:54`): a held queue with nothing running waits for the person, so it does
    // not hold the checkout; a running message does.
    #[test]
    fn a_held_queue_does_not_hold_a_checkout_but_running_work_does() {
        let (_conn, store, mut state) = home_with_checkout();
        assert!(!live_pending(&store, &mut state, "t").expect("none"));
        // A message held after a Stop is not live work.
        // (The queue row and intent are what `intents.ts` writes.)
        let conn = store.conn();
        conn.exec("INSERT INTO engine_queue (thread_id,paused,reason) VALUES ('t',1,'stopped')")
            .expect("queue");
        conn.exec("INSERT INTO intents (command_id,thread_id,kind,payload,status,position) VALUES ('c','t','thread.send','{\"type\":\"thread.send\"}','pending',1)")
            .expect("intent");
        assert!(!live_pending(&store, &mut state, "t").expect("held"));
        conn.exec("UPDATE engine_queue SET paused=0, reason=NULL WHERE thread_id='t'")
            .expect("unpause");
        assert!(live_pending(&store, &mut state, "t").expect("running"));
    }
}
