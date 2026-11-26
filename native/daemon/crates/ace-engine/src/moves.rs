// SPDX-License-Identifier: Apache-2.0
//! `live-move.ts` (E5.9): the engine's side of a thread moving to another machine (ADR 0191):
//! the fence that refuses new turns, the controls that may still run, and the moved/carried
//! state a move writes. Cases ported from `workspace-change.process.test.ts` (move rows) and
//! `thread-fork.process.test.ts` (carried sessions).

use ace_json::Value;

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
    state.transition_set(store, id, &Value::Object(metadata))?;
    store.atomic(|tx| {
        ace_store::stmt_cache::run(
            tx.conn(),
            "UPDATE engine_sessions SET native_session_id=NULL WHERE thread_id=?",
            vec![ace_store::Value::Text(id.to_owned())],
        )?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
