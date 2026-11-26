// SPDX-License-Identifier: Apache-2.0
//! `aimSteerAtRun` and `recordSteerAim` (`steer-selection.ts:48`-`:88`), against a stored root
//! with a run. The cases are the TypeScript's: a fresh steer on a cancel session is aimed at the
//! turn that is running (or at nothing), a native session is left alone, and the admitted
//! steer's aim is recorded beside its payload.

use std::sync::Arc;

use super::*;
use crate::repository::testsupport::{Shell, StoredAgent, header_with_agents, home};

struct Store {
    conn: Arc<ace_store::Connection>,
    store: crate::EngineStore,
    state: State,
}

fn root<'a>(key: &'a str, id: &'a str, run: Option<&'a str>) -> StoredAgent<'a> {
    StoredAgent {
        key,
        id,
        parent: None,
        run,
    }
}

fn harness(agent: StoredAgent<'_>, runs: &[(&str, &str)]) -> Store {
    let conn = home("t", &header_with_agents("t", &[agent], runs));
    let store = Shell::store(&conn);
    let mut state = State::default();
    state.repo.probe_passthrough = true;
    Store { conn, store, state }
}

fn steer(run_id: Option<&str>) -> Value {
    let run = run_id
        .map(|run| format!(r#","runId":"{run}""#))
        .unwrap_or_default();
    ace_json::parse(&format!(
        r#"{{"id":"c","deviceId":"d","payload":{{"type":"thread.send","threadId":"t","delivery":"steer","input":[{{"type":"text","text":"hi"}}]{run}}}}}"#
    ))
    .expect("json")
}

fn aimed(command: &Value) -> Option<&Value> {
    command
        .get("payload")
        .and_then(|payload| payload.get("runId"))
}

#[test]
fn a_fresh_steer_is_aimed_at_the_turn_the_person_is_steering_into() {
    let mut store = harness(root("root", "root", Some("run-1")), &[("run-1", "active")]);
    let command = steer(None);
    let aimed_command =
        aim_steer_at_run(&store.store, &mut store.state, &command, "t", true).expect("aim");
    assert_eq!(aimed(&aimed_command).and_then(Value::as_str), Some("run-1"));
    // Between turns it is aimed at nothing (`null`), so it queues instead of fencing a later turn.
    let mut store = harness(root("root", "root", None), &[]);
    let aimed_command =
        aim_steer_at_run(&store.store, &mut store.state, &command, "t", true).expect("aim");
    assert_eq!(aimed(&aimed_command), Some(&Value::Null));
}

#[test]
fn a_native_session_and_an_already_aimed_steer_are_left_alone() {
    let mut store = harness(root("root", "root", Some("run-1")), &[("run-1", "active")]);
    let command = steer(None);
    // Every provider but a cancel-steering one steers natively and reads no run.
    let unchanged =
        aim_steer_at_run(&store.store, &mut store.state, &command, "t", false).expect("aim");
    assert_eq!(aimed(&unchanged), None);
    // A sender that already named a run is not re-aimed.
    let kept = steer(Some("run-9"));
    let unchanged =
        aim_steer_at_run(&store.store, &mut store.state, &kept, "t", true).expect("aim");
    assert_eq!(aimed(&unchanged).and_then(Value::as_str), Some("run-9"));
}

#[test]
fn the_admitted_steers_aim_is_recorded_beside_its_payload() {
    let mut store = harness(root("root", "root", Some("run-1")), &[("run-1", "active")]);
    record_steer_aim(&store.store, &mut store.state, 7, "t", &steer(None)).expect("record");
    assert_eq!(
        row(&store.conn, 7),
        Some(Some("run-1".to_owned())),
        "the lane reads the turn the steer joined"
    );
    // A later admission replaces the target it kept; no turn is `null`, not absent.
    let mut store = harness(root("root", "root", None), &[]);
    record_steer_aim(&store.store, &mut store.state, 7, "t", &steer(None)).expect("record");
    assert_eq!(row(&store.conn, 7), Some(None));
    // A queued send records nothing.
    record_steer_aim(
        &store.store,
        &mut store.state,
        8,
        "t",
        &ace_json::parse(
            r#"{"id":"q","deviceId":"d","payload":{"type":"thread.send","threadId":"t","input":[]}}"#,
        )
        .expect("json"),
    )
    .expect("record");
    assert_eq!(row(&store.conn, 8), None);
}

/// The stored cell as a string; `Some(None)` for a null row, `None` for no row at all.
fn row(conn: &Arc<ace_store::Connection>, intent: i64) -> Option<Option<String>> {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT run FROM engine_steer_aims WHERE intent_id=?",
        vec![ace_store::Value::Integer(intent)],
    )
    .expect("row")?;
    Some(
        row.get("run")
            .and_then(crate::repository::residency::cell_text)
            .map(str::to_owned),
    )
}
