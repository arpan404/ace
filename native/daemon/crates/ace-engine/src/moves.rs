// SPDX-License-Identifier: Apache-2.0
//! `live-move.ts` and `workspace-change.ts` (E5.9): the engine's side of a thread moving to another machine (ADR 0191):
//! the fence that refuses new turns, the controls that may still run, and the moved/carried
//! state a move writes. Cases ported from `workspace-change.process.test.ts` (move rows) and
//! `thread-fork.process.test.ts` (carried sessions).

use ace_json::Value;

pub mod workspace;

use crate::intents::header::IntentHeader;
use crate::{EngineError, EngineStore, State};

/// Commands that would start or redirect a turn; a moving or moved thread refuses them.
const TURN_COMMANDS: [&str; 7] = [
    "thread.send",
    "thread.resume",
    "queue.resume",
    "thread.switch",
    "thread.limit",
    "thread.move",
    "thread.continueOn",
];

/// Controls that only take work down: they still run while the thread is fenced.
const TEARDOWN: [&str; 2] = ["thread.interrupt", "thread.archive"];

/// `fenceCommand` (`live-move.ts:22`): the refusal a moving thread answers a command with, or
/// none when it may run. The result keeps the literal's key order.
pub fn fence_command(
    command: &Value,
    refusal: impl Fn(&str) -> Option<(String, String)>,
) -> Option<Value> {
    let payload = command.get("payload")?;
    let kind = payload.get("type").and_then(Value::as_str)?;
    if !TURN_COMMANDS.contains(&kind) {
        return None;
    }
    let thread_id = payload.get("threadId").and_then(Value::as_str)?;
    if thread_id.is_empty() {
        return None;
    }
    let (code, detail) = refusal(thread_id)?;
    let mut result = ace_json::Map::new();
    result.insert(
        "commandId",
        command.get("id").cloned().unwrap_or(Value::Null),
    );
    result.insert("ok", Value::Bool(false));
    result.insert("error", Value::from(code.as_str()));
    result.insert("code", Value::from(code.as_str()));
    result.insert("detail", Value::from(detail.as_str()));
    Some(Value::Object(result))
}

/// `admittedControls` (`:34`): while fenced, only teardown controls run.
pub fn admitted_controls<'a>(
    controls: impl IntoIterator<Item = &'a IntentHeader>,
    fenced: bool,
) -> Vec<&'a IntentHeader> {
    controls
        .into_iter()
        .filter(|intent| !fenced || TEARDOWN.contains(&intent.kind.as_str()))
        .collect()
}

/// `markMoved` (`:72`): the thread reads moved, or runs here again when `to` is `None`.
pub fn mark_moved(
    state: &mut State,
    store: &EngineStore,
    id: &str,
    to: Option<&Value>,
    now: f64,
) -> Result<(), EngineError> {
    if state.repo.state(store, id)?.is_none() {
        return Ok(());
    }
    let facts = format!(
        r#"[{{"type":"thread.moved","to":{}}}]"#,
        to.map(Value::to_json)
            .unwrap_or_else(|| String::from("null"))
    );
    state.apply(store, id, &facts, now, None)
}

/// `unconfirmedExit` (`:139`): the provider's last close went unconfirmed, so a move cannot say
/// the thread is stopped.
pub fn unconfirmed_exit(state: &ace_core::state::ThreadState) -> bool {
    state
        .process_exit
        .as_ref()
        .and_then(|exit| exit.unconfirmed)
        .unwrap_or(false)
}

/// `stopInFlight` (`:151`): a Stop is accepted and has not finished.
pub fn stop_in_flight(intents: &[IntentHeader]) -> bool {
    intents.iter().any(|intent| {
        intent.kind == "thread.interrupt"
            && ["pending", "queued", "running"].contains(&intent.status.as_str())
    })
}

/// `atRest` (`live-move.ts:39`): the thread, with its whole tree, reads at rest once its own
/// move hold is set aside. Read on a copy through core's reducer; the thread is untouched.
pub fn at_rest(state: &ace_core::state::ThreadState, task: &str, now: i64) -> bool {
    let mut copy = state.clone();
    if copy
        .tasks
        .get(task)
        .is_some_and(|task| task.status == "running")
    {
        let mut seq = 0i64;
        let mut ids = |_kind: &str| {
            seq += 1;
            Some(format!("rest-{seq}"))
        };
        let mut context = ace_core::state::ApplyContext {
            now,
            ids: &mut ids,
            resolving_interactions: None,
        };
        let fact = ace_json::json!({
            "type": "background.ended", "task": task, "status": "completed"
        });
        let mut events = Vec::new();
        let _ = ace_core::reduce::apply(&mut copy, &fact, &mut context, &mut events);
    }
    matches!(
        ace_core::status::derive_thread_status(&copy).state(),
        "done" | "new" | "failed"
    )
}

/// One carried session a new thread continues (`adoptCarriedSession`, `live-move.ts:81`).
pub struct CarriedSession {
    pub native_session_id: String,
    pub instance_id: String,
    pub action: CarriedAction,
}

pub enum CarriedAction {
    Resume,
    Fork,
}

/// `adoptCarriedSession` (`:81`): resume the copied session by id, or fork from its end.
pub fn adopt_carried_session(
    state: &mut State,
    store: &EngineStore,
    id: &str,
    session: CarriedSession,
) -> Result<(), EngineError> {
    store.atomic(|tx| {
        let native = match session.action {
            CarriedAction::Resume => Some(session.native_session_id.as_str()),
            CarriedAction::Fork => None,
        };
        // `nativeSession(id, native, undefined, instance)`: only the named fields move.
        ace_store::stmt_cache::run(
            tx.conn(),
            "UPDATE engine_sessions SET native_session_id=COALESCE(?,native_session_id), instance_id=COALESCE(?,instance_id) WHERE thread_id=?",
            vec![
                native.map_or(ace_store::Value::Null, |native| {
                    ace_store::Value::Text(native.to_owned())
                }),
                ace_store::Value::Text(session.instance_id.clone()),
                ace_store::Value::Text(id.to_owned()),
            ],
        )?;
        if let CarriedAction::Fork = session.action {
            let mut fork = ace_json::Map::new();
            fork.insert(
                "nativeSessionId",
                Value::from(session.native_session_id.as_str()),
            );
            let mut point = ace_json::Map::new();
            point.insert("type", Value::from("end"));
            point.insert(
                "nativeId",
                Value::from(session.native_session_id.as_str()),
            );
            fork.insert("point", Value::Object(point));
            let previous = state.transition_get(store, id)?;
            let mut metadata = crate::transitions::metadata::metadata_json(&previous);
            metadata.insert("fork", Value::Object(fork));
            state.transition_set(store, id, &Value::Object(metadata))?;
        }
        Ok(())
    })
}

/// `dropCarriedSession` (`:117`): the carried session did not open, so the thread forgets it and
/// keeps the rest of its metadata (the handoff replaces the fork).
pub fn drop_carried_session(
    state: &mut State,
    store: &EngineStore,
    id: &str,
) -> Result<(), EngineError> {
    let mut metadata =
        crate::transitions::metadata::metadata_json(&state.transition_get(store, id)?);
    metadata.shift_remove("fork");
    store.atomic(|_tx| {
        state.transition_set(store, id, &Value::Object(metadata))?;
        ace_store::stmt_cache::run(
            store.conn(),
            "UPDATE engine_sessions SET native_session_id=NULL WHERE thread_id=?",
            vec![ace_store::Value::Text(id.to_owned())],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn intent(kind: &str, status: &str) -> IntentHeader {
        IntentHeader {
            id: 1,
            thread_id: "t".into(),
            command_id: "c".into(),
            kind: kind.into(),
            status: status.into(),
            attempts: 0,
            awaiting: false,
            ack_target: None,
            delivery: "queue".into(),
            acknowledged: false,
            resolution_id: None,
            resolution_generation: None,
            submitted_generation: None,
            trigger: None,
        }
    }

    // From `workspace-change.process.test.ts`: a moving thread refuses turn commands and starts
    // nothing, while a Stop and an archive still run.
    #[test]
    fn a_moving_thread_refuses_turn_commands_and_keeps_its_teardown_controls() {
        let command = ace_json::json!({
            "id": "cmd",
            "payload": { "type": "thread.send", "threadId": "t", "input": [] }
        });
        let refused = fence_command(&command, |id| {
            (id == "t").then(|| ("thread_moving".to_owned(), "moving".to_owned()))
        })
        .expect("refused");
        assert_eq!(
            refused.to_json(),
            r#"{"commandId":"cmd","ok":false,"error":"thread_moving","code":"thread_moving","detail":"moving"}"#
        );
        // A command that does not start a turn is untouched, and a thread not fenced passes.
        let archive = ace_json::json!({ "id": "c2", "payload": { "type": "thread.archive", "threadId": "t" } });
        assert!(fence_command(&archive, |_| Some(("x".into(), "y".into()))).is_none());
        assert!(fence_command(&command, |_| None).is_none());
        // A payload with no thread is not the fence's.
        let global = ace_json::json!({ "id": "c3", "payload": { "type": "thread.switch" } });
        assert!(fence_command(&global, |_| Some(("x".into(), "y".into()))).is_none());

        let controls = [
            intent("thread.send", "pending"),
            intent("thread.interrupt", "queued"),
            intent("thread.archive", "pending"),
            intent("goal.set", "pending"),
        ];
        let admitted: Vec<&str> = admitted_controls(controls.iter(), true)
            .into_iter()
            .map(|intent| intent.kind.as_str())
            .collect();
        assert_eq!(admitted, ["thread.interrupt", "thread.archive"]);
        assert_eq!(admitted_controls(controls.iter(), false).len(), 4);
    }

    // From `workspace-change.process.test.ts`: a Stop that has not finished keeps the thread
    // from reading at rest, and an unconfirmed close keeps a move from calling it stopped.
    #[test]
    fn a_stop_in_flight_and_an_unconfirmed_exit_are_both_still_live() {
        assert!(stop_in_flight(&[intent("thread.interrupt", "running")]));
        assert!(!stop_in_flight(&[intent("thread.interrupt", "done")]));
        assert!(!stop_in_flight(&[intent("thread.send", "running")]));
        let mut state: ace_core::state::ThreadState = serde_json::from_value(serde_json::json!({
            "threadId": "t",
            "config": { "provider": "claude", "silenceMs": 1000 },
            "status": { "state": "done" },
            "agents": {}, "runs": {}, "items": {}, "interactions": {}, "tasks": {},
            "interactionHistory": {}, "taskHistory": {},
            "indexes": {
                "liveTools": {}, "pendingInteractions": {}, "runningTasks": {},
                "agentKeysById": {}, "childrenByParent": {}, "pendingSpawnLinks": {},
                "pendingItemLinks": {}
            },
            "outcomeOrder": 0, "pendingNotices": [], "itemLinks": {},
            "queueCount": 0, "queueSources": { "engine": 0, "provider": 0 }, "hasRun": false
        }))
        .expect("a state");
        assert!(!unconfirmed_exit(&state));
        state.process_exit = Some(ace_core::state::ProcessExit {
            deliberate: false,
            message: None,
            unsettled: Vec::new(),
            unconfirmed: Some(true),
        });
        assert!(unconfirmed_exit(&state));
    }

    fn idle_state(task: Option<&str>, working_root: bool) -> ace_core::state::ThreadState {
        let status = if working_root {
            serde_json::json!({ "state": "working", "activity": "thinking" })
        } else {
            serde_json::json!({ "state": "idle" })
        };
        let agents = if working_root {
            serde_json::json!({
                "root": {
                    "agent": {
                        "id": "root", "threadId": "t", "origin": "root",
                        "native": { "provider": "claude" }, "fidelity": "full", "cwd": "/w",
                        "status": status, "createdAt": 1
                    },
                    "activity": "thinking", "lastSignalAt": 1
                }
            })
        } else {
            serde_json::json!({})
        };
        let tasks = match task {
            Some(task) => serde_json::json!({
                task: { "id": task, "owner": "ace", "agentId": "root", "ambient": false, "stoppable": false, "kind": "shell", "title": "move", "status": "running", "startedAt": 1 }
            }),
            None => serde_json::json!({}),
        };
        serde_json::from_value(serde_json::json!({
            "threadId": "t",
            "config": { "provider": "claude", "silenceMs": 1000 },
            "status": { "state": "done" },
            "agents": agents,
            "runs": {},
            "items": {},
            "interactions": {},
            "tasks": tasks,
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

    // From `workspace-change.process.test.ts`'s move rows: the move's own hold is set aside, but
    // a working tree still refuses.
    #[test]
    fn a_tree_at_rest_ignores_its_own_move_hold_but_not_running_work() {
        assert!(at_rest(&idle_state(Some("move"), false), "move", 0));
        assert!(!at_rest(&idle_state(Some("move"), true), "move", 0));
    }

    // From `workspace-change.process.test.ts`: a carried session is resumed by id or forked from
    // its end, and a failed open drops it for the handoff.
    #[test]
    fn a_carried_session_is_adopted_by_resume_or_fork_and_can_be_dropped() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        conn.exec(
            "INSERT INTO engine_sessions (thread_id,cwd,model,native_session_id,backend,instance_id,options) VALUES ('t','/w',NULL,'old','acp','a',NULL)",
        )
        .expect("session");
        let read = |conn: &std::sync::Arc<ace_store::Connection>| {
            let row = ace_store::stmt_cache::get_row(
                conn,
                "SELECT native_session_id,instance_id FROM engine_sessions WHERE thread_id='t'",
                Vec::new(),
            )
            .expect("read")
            .expect("row");
            let text = |column: &str| {
                row.get(column)
                    .and_then(crate::repository::residency::cell_text)
                    .map(str::to_owned)
            };
            (text("native_session_id"), text("instance_id"))
        };
        adopt_carried_session(
            &mut state,
            &store,
            "t",
            CarriedSession {
                native_session_id: "resumed".into(),
                instance_id: "b".into(),
                action: CarriedAction::Resume,
            },
        )
        .expect("resume");
        let (native, instance) = read(&conn);
        assert_eq!(native.as_deref(), Some("resumed"));
        assert_eq!(instance.as_deref(), Some("b"));
        drop_carried_session(&mut state, &store, "t").expect("drop before a fork");
        assert_eq!(read(&conn).0.as_deref(), None);
        adopt_carried_session(
            &mut state,
            &store,
            "t",
            CarriedSession {
                native_session_id: "forked".into(),
                instance_id: "c".into(),
                action: CarriedAction::Fork,
            },
        )
        .expect("fork");
        let (native, instance) = read(&conn);
        assert_eq!(native.as_deref(), None);
        assert_eq!(instance.as_deref(), Some("c"));
        let fork = state
            .transition_get(&store, "t")
            .expect("metadata")
            .fork
            .expect("fork");
        assert_eq!(
            fork.get("nativeSessionId").and_then(Value::as_str),
            Some("forked")
        );
        drop_carried_session(&mut state, &store, "t").expect("drop");
        assert!(
            state
                .transition_get(&store, "t")
                .expect("metadata")
                .fork
                .is_none()
        );
        assert_eq!(read(&conn).0.as_deref(), None);
    }
}
