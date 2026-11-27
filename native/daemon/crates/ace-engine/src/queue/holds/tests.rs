// SPDX-License-Identifier: Apache-2.0
//! The deadline timer's cases (`recovery.ts:618`-`:629`): a firing reports once, a replaced or
//! cancelled one reports nothing, and the receipt's gate decides the arm.

use crate::actor::ActorDeps;
use crate::executor::{Budget, Notified, Notifier};
use crate::frames::live::UnportedLive;
use crate::queue::holds::{schedule, sync};
use crate::repository::testsupport::{Shell, header, home};
use std::sync::Arc;

struct ManualPump;

impl Notifier for ManualPump {
    fn notify(&self) -> Notified {
        Notified::Posted
    }
}

struct Turn;

impl Budget for Turn {
    fn start(&mut self) {}
    fn spent(&self, started: usize) -> bool {
        started >= 64
    }
}

/// An engine over `conn`, with the shell's timers and reports under the test's control.
fn engine_on(conn: &Arc<ace_store::Connection>) -> (crate::Engine, std::rc::Rc<Shell>) {
    let (_, shell) = Shell::store_with_controls(conn);
    let engine = crate::Engine::new(
        shell.clone(),
        shell.clone(),
        crate::Inputs::default(),
        "[]",
        Box::new(ManualPump),
        conn,
        std::rc::Rc::new(ActorDeps::production(std::rc::Rc::new(UnportedLive), 0.0)),
    )
    .unwrap();
    (engine, shell)
}

/// Turns the pump until nothing is left, so a deferred or fired task runs.
fn settle(engine: &crate::Engine) {
    for _ in 0..8 {
        let mut budget = Turn;
        engine.pump(&mut budget);
    }
}

fn with_deadline(conn: &Arc<ace_store::Connection>) {
    conn.exec("INSERT INTO engine_queue (thread_id, resume_at) VALUES ('t', 9000)")
        .unwrap();
}

/// A deadline already due at the shell's clock (which reads 0).
fn with_due_deadline(conn: &Arc<ace_store::Connection>) {
    conn.exec("INSERT INTO engine_queue (thread_id, resume_at) VALUES ('t', 0)")
        .unwrap();
}

/// How many automatic Resume receipts the engine wrote.
fn engine_commands(conn: &Arc<ace_store::Connection>) -> i64 {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT COUNT(*) AS n FROM command_receipts WHERE device_id='engine'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    row.get("n")
        .and_then(crate::repository::residency::cell_int)
        .unwrap_or(0)
}

/// The deadline timer's key, as the engine holds it (the sweep arms its own).
fn armed_deadline(engine: &crate::Engine) -> u64 {
    engine
        .core()
        .with_state(|state| state.recovery.cancel)
        .unwrap()
        .expect("a deadline is armed")
}

#[test]
fn a_cold_still_limited_root_keeps_its_hold() {
    // The root's quota evidence is only in the stored header: no snapshot is resident, so a
    // hold must not read as stale and turn into a cleared marker with its timer cancelled.
    let conn = home("t", &limited_header("t"));
    conn.exec(
        "INSERT INTO engine_queue (thread_id, resume_at, paused, reason, limited, reset_at, hold_token)
         VALUES ('t', 9000, 1, 'limit', 1, 9000, 4)",
    )
    .unwrap();
    let (engine, _shell) = engine_on(&conn);
    let core = engine.core();
    let mut state = crate::State::default();
    sync(core, &mut state, "t", 1_000.0).unwrap();
    let row = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT reason, limited, reset_at, hold_token FROM engine_queue WHERE thread_id='t'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        row.get("reason"),
        Some(&ace_store::Value::Text("limit".into()))
    );
    assert_eq!(row.get("limited"), Some(&ace_store::Value::Integer(1)));
    assert_eq!(row.get("reset_at"), Some(&ace_store::Value::Integer(9000)));
    assert_eq!(row.get("hold_token"), Some(&ace_store::Value::Integer(4)));
    assert!(
        core.with_state(|state| state.recovery.cancel.is_none())
            .unwrap()
    );
}

#[test]
fn a_due_deadline_resumes_once_and_firing_its_timer_again_does_nothing() {
    let conn = home("t", &header("t"));
    with_due_deadline(&conn);
    let (engine, shell) = engine_on(&conn);
    let core = engine.core();
    schedule(core).unwrap();
    settle(&engine);
    let key = armed_deadline(&engine);
    // The timer fires the automatic Resume once; the deadline is consumed with it.
    shell.fire(key);
    settle(&engine);
    assert_eq!(engine_commands(&conn), 1);
    let row = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT resume_at FROM engine_queue WHERE thread_id='t'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(row.get("resume_at"), Some(&ace_store::Value::Null));
    assert!(
        core.with_state(|state| state.recovery.cancel.is_none())
            .unwrap()
    );
    // The same timer key again reaches no task: it settled its run.
    shell.fire(key);
    settle(&engine);
    assert_eq!(engine_commands(&conn), 1);
}

#[test]
fn a_fired_deadline_replaced_before_the_pump_never_acts_and_the_replacement_does() {
    let conn = home("t", &header("t"));
    with_due_deadline(&conn);
    let (engine, shell) = engine_on(&conn);
    let core = engine.core();
    schedule(core).unwrap();
    settle(&engine);
    let first = armed_deadline(&engine);
    shell.fire(first);
    // The next receipt replaces the deadline before the fired task gets its turn.
    schedule(core).unwrap();
    settle(&engine);
    assert_eq!(engine_commands(&conn), 0, "the replaced deadline acted");
    assert!(
        core.with_state(|state| state.recovery.cancel.is_some())
            .unwrap(),
        "the replacement stays armed"
    );
    // The replacement is the one that acts, once.
    let replacement = armed_deadline(&engine);
    shell.fire(replacement);
    settle(&engine);
    assert_eq!(engine_commands(&conn), 1);
}

#[test]
fn a_deadline_that_fires_as_the_engine_closes_acts_on_nothing() {
    let conn = home("t", &header("t"));
    with_due_deadline(&conn);
    let (engine, shell) = engine_on(&conn);
    let core = engine.core();
    schedule(core).unwrap();
    settle(&engine);
    let key = armed_deadline(&engine);
    // Only the close is set: the key is still the armed one, so only the close guard can stop
    // the report.
    core.with_state(|state| {
        state.recovery.closed = true;
    })
    .unwrap();
    shell.fire(key);
    settle(&engine);
    assert_eq!(engine_commands(&conn), 0);
    let row = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT resume_at FROM engine_queue WHERE thread_id='t'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(row.get("resume_at"), Some(&ace_store::Value::Integer(0)));
}

#[test]
fn a_receipt_reads_the_gate_once_and_its_answer_arms_the_deadline() {
    let conn = home("t", &header("t"));
    with_deadline(&conn);
    let (engine, shell) = engine_on(&conn);
    let core = engine.core();
    // Let readiness and its restart pass finish first: their own schedule reads the gate too.
    settle(&engine);
    let before = shell.admits_calls();
    // A second `admits` call would throw: only the receipt's own answer may be used.
    shell.throw_admits_from(before + 2);
    core.store
        .atomic(|_tx| {
            schedule(core)?;
            Ok(())
        })
        .unwrap();
    settle(&engine);
    assert_eq!(shell.admits_calls(), before + 1);
    assert!(shell.armed().contains(&armed_deadline(&engine)));
}

#[test]
fn a_refused_gate_arms_no_deadline() {
    let conn = home("t", &header("t"));
    with_deadline(&conn);
    let (engine, shell) = engine_on(&conn);
    shell.answer_admits(Some(false));
    schedule(engine.core()).unwrap();
    settle(&engine);
    assert!(
        engine
            .core()
            .with_state(|state| state.recovery.cancel.is_none())
            .unwrap()
    );
}

#[test]
fn a_gate_that_throws_inside_a_receipt_rolls_back_and_keeps_the_old_timer() {
    let conn = home("t", &header("t"));
    with_deadline(&conn);
    let (engine, shell) = engine_on(&conn);
    let core = engine.core();
    schedule(core).unwrap();
    settle(&engine);
    let old = armed_deadline(&engine);
    shell.throw_admits_from(shell.admits_calls() + 1);
    let outcome = core.store.atomic(|_tx| {
        schedule(core)?;
        Ok(())
    });
    assert!(outcome.is_err());
    settle(&engine);
    // The old timer is still armed and never cancelled: nothing committed.
    assert!(shell.armed().contains(&old));
    assert!(!shell.cancelled().contains(&old));
}

/// A stored header whose root agent still carries its quota evidence.
fn limited_header(thread: &str) -> String {
    let mut state: ace_core::state::ThreadState =
        ace_json::from_value(&ace_json::parse(&header(thread)).unwrap()).unwrap();
    state.root_key = Some("root".to_owned());
    let record: ace_core::state::AgentRecord = ace_json::from_value(
        &ace_json::parse(&format!(
            r#"{{"agent":{{"id":"root","threadId":"{thread}","parentId":null,"origin":"person","native":{{"provider":"codex","nativeId":"native-root"}},"fidelity":"full","cwd":"/tmp","status":{{"state":"idle"}},"createdAt":0}},"activity":"idle","lastSignalAt":0,"limited":{{"until":9000}}}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    state.agents.insert("root".to_owned(), record);
    let text = ace_json::ser::to_string(&state).unwrap();
    format!(r#"{{"engineSnapshot":9,{}"#, &text[1..])
}
