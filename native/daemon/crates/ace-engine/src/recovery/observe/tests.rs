// SPDX-License-Identifier: Apache-2.0
//! What a fold teaches recovery, over a real store: a completed turn lifts a limit and ends a
//! restart run, a quota turn installs the hold its policy asks for, and a Cursor turn a restart
//! cut short that its reconcile read back as finished releases the restart's hold.
//!
//! Ported cases: `limit-recovery.process.test.ts:93` ("resume at reset uses the account deadline
//! and cannot fire a millisecond early"), `:419` ("an account limit with no reset overrides a
//! provider retry estimate and never times a resume"); `restart-resume.process.test.ts:384` ("a
//! turn that finishes while ace shuts its provider down isn't continued after the restart").

use crate::repository::testsupport::{Shell, header, home};
use ace_store::Connection;
use std::rc::Rc;
use std::sync::Arc;

fn engine_on(conn: &Arc<Connection>) -> crate::Engine {
    struct ManualPump;
    impl crate::executor::Notifier for ManualPump {
        fn notify(&self) -> crate::executor::Notified {
            crate::executor::Notified::Posted
        }
    }
    let (_, shell) = Shell::store_with_controls(conn);
    let engine = crate::Engine::new(
        shell.clone(),
        shell,
        crate::Inputs::default(),
        "[]",
        Box::new(ManualPump),
        conn,
        Rc::new(crate::actor::ActorDeps::production(
            Rc::new(crate::frames::live::UnportedLive),
            0.0,
        )),
    )
    .unwrap();
    engine
        .core()
        .with_state(|state| state.repo.probe_passthrough = true)
        .unwrap();
    engine
}

/// A stored thread with its root agent resident (the state every fold of its work reads).
fn root_header(thread: &str, limited: &str) -> String {
    let mut state: ace_core::state::ThreadState =
        ace_json::from_value(&ace_json::parse(&header(thread)).unwrap()).unwrap();
    state.root_key = Some("root".to_owned());
    let record: ace_core::state::AgentRecord = ace_json::from_value(
        &ace_json::parse(&format!(
            r#"{{"agent":{{"id":"root","threadId":"{thread}","parentId":null,"origin":"person","native":{{"provider":"codex","nativeId":"native-root"}},"fidelity":"full","cwd":"/tmp","status":{{"state":"idle"}},"createdAt":0}},"activity":"idle","lastSignalAt":0{limited}}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    state.agents.insert("root".to_owned(), record);
    let text = ace_json::ser::to_string(&state).unwrap();
    format!(r#"{{"engineSnapshot":9,{}"#, &text[1..])
}

/// A stored thread whose root agent carries quota evidence (the TypeScript's replayable state).
fn limited_header(thread: &str, until: Option<i64>) -> String {
    let limited = until.map_or("{}".to_owned(), |until| format!(r#"{{"until":{until}}}"#));
    root_header(thread, &format!(r#","limited":{limited}"#))
}

/// Every thread an engine folds has its session binding row (the TypeScript's createEngineThread).
fn session_row(conn: &Arc<Connection>) {
    conn.exec("INSERT INTO engine_sessions (thread_id, cwd) VALUES ('t', '/tmp')")
        .unwrap();
}

fn queue(conn: &Arc<Connection>, sql: &str) {
    conn.exec(sql).unwrap();
}

fn field(conn: &Arc<Connection>, name: &str) -> Option<String> {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT paused, limited, reason, reset_at, resume_at, timer_action, continuation, trigger, hold_token
           FROM engine_queue WHERE thread_id='t'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    row.get(name)
        .and_then(crate::repository::residency::cell_text)
        .map(str::to_owned)
        .or_else(|| {
            row.get(name)
                .and_then(crate::repository::residency::cell_int)
                .map(|value| {
                    if value == 0 {
                        String::new()
                    } else {
                        value.to_string()
                    }
                })
        })
}

fn observe(engine: &crate::Engine, facts: &str) {
    engine.core().observe("t", facts, 0.0).unwrap();
}

#[test]
fn a_completed_turn_lifts_a_limit_hold_and_ends_the_restart_run() {
    // The root's quota evidence is gone (a switch dropped it) while the queue still holds a
    // limit; a turn that completes proves the account works, so the hold goes with it.
    let conn = home("t", &root_header("t", ""));
    session_row(&conn);
    queue(
        &conn,
        "INSERT INTO engine_queue (thread_id, limited, paused, reason, reset_at, resume_at, timer_action, continuation, trigger, hold_token)
         VALUES ('t', 1, 1, 'limit', 9000, 9000, 'resume', 'Continue where you left off.', 'limit_resume', 2)",
    );
    crate::restart::ensure_ledgers(&conn).unwrap();
    conn.exec("INSERT INTO engine_restart_resumes VALUES ('t', 2)")
        .unwrap();
    let engine = engine_on(&conn);
    observe(
        &engine,
        r#"[{"type":"turn.ended","agent":"root","outcome":"completed"}]"#,
    );
    assert_eq!(field(&conn, "paused").as_deref(), Some(""));
    assert_eq!(field(&conn, "limited").as_deref(), Some(""));
    assert_eq!(field(&conn, "reason"), None);
    assert_eq!(field(&conn, "continuation"), None);
    assert_eq!(field(&conn, "reset_at"), None);
    let streak = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT COUNT(*) AS n FROM engine_restart_resumes",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        streak
            .get("n")
            .and_then(crate::repository::residency::cell_int),
        Some(0)
    );
    // The root's quota evidence went with the limit, so the thread and account read available.
    let state = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT state FROM thread_state WHERE thread_id='t'",
        Vec::new(),
    )
    .unwrap()
    .unwrap()
    .get("state")
    .and_then(crate::repository::residency::cell_text)
    .unwrap()
    .to_owned();
    assert!(!state.contains("\"limited\""), "{state}");
}

#[test]
fn a_limit_with_no_reset_times_nothing_and_holds_the_continuation_for_the_person() {
    let conn = home("t", &limited_header("t", None));
    let engine = engine_on(&conn);
    observe(
        &engine,
        r#"[{"type":"turn.ended","agent":"root","outcome":"failed","error":{"kind":"quota"}}]"#,
    );
    assert_eq!(field(&conn, "paused").as_deref(), Some("1"));
    assert_eq!(field(&conn, "limited").as_deref(), Some("1"));
    assert_eq!(field(&conn, "reason").as_deref(), Some("limit"));
    assert_eq!(field(&conn, "resume_at"), None);
    assert_eq!(field(&conn, "timer_action"), None);
    assert_eq!(
        field(&conn, "continuation").as_deref(),
        Some(ace_core::person_input::CONTINUE_MESSAGE)
    );
    assert_eq!(field(&conn, "trigger").as_deref(), Some("limit_resume"));
}

#[test]
fn resume_at_reset_uses_the_accounts_reset_and_never_fires_before_it() {
    let conn = home("t", &limited_header("t", Some(9_000)));
    queue(
        &conn,
        r#"INSERT INTO engine_queue (thread_id, preferences) VALUES ('t', '{"followUpBehavior":"queue","limitPolicy":"resume_at_reset"}')"#,
    );
    let engine = engine_on(&conn);
    observe(
        &engine,
        r#"[{"type":"turn.ended","agent":"root","outcome":"failed","error":{"kind":"quota"}}]"#,
    );
    assert_eq!(field(&conn, "resume_at").as_deref(), Some("9000"));
    assert_eq!(field(&conn, "timer_action").as_deref(), Some("resume"));
    assert_eq!(field(&conn, "reason").as_deref(), Some("limit"));
    // Not a millisecond early: the queue's own due predicate decides.
    assert!(
        crate::queue::deadline::due(&conn, 8_999)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        crate::queue::deadline::due(&conn, 9_000).unwrap(),
        vec!["t".to_owned()]
    );
}

#[test]
fn migrate_now_times_nothing_and_leaves_the_move_to_the_policy() {
    let conn = home("t", &limited_header("t", Some(9_000)));
    queue(
        &conn,
        r#"INSERT INTO engine_queue (thread_id, preferences) VALUES ('t', '{"followUpBehavior":"queue","limitPolicy":"migrate_now"}')"#,
    );
    let engine = engine_on(&conn);
    observe(
        &engine,
        r#"[{"type":"turn.ended","agent":"root","outcome":"failed","error":{"kind":"quota"}}]"#,
    );
    assert_eq!(field(&conn, "paused").as_deref(), Some("1"));
    assert_eq!(field(&conn, "limited").as_deref(), Some("1"));
    assert_eq!(field(&conn, "resume_at"), None);
    assert_eq!(field(&conn, "timer_action"), None);
}

#[test]
fn a_cursor_turn_a_restart_cut_short_that_finished_while_closing_releases_the_restart_hold() {
    let conn = home("t", &root_header("t", ""));
    conn.exec(
        "INSERT INTO engine_sessions (thread_id, cwd, backend) VALUES ('t', '/tmp', 'cursor-sdk')",
    )
    .unwrap();
    queue(
        &conn,
        "INSERT INTO engine_queue (thread_id, paused, reason, continuation, trigger, hold_token)
         VALUES ('t', 1, 'restart', 'Continue where you left off.', 'restart', 4)",
    );
    crate::restart::ensure_ledgers(&conn).unwrap();
    crate::restart::record_capture(
        &conn,
        "t",
        &crate::restart::RestartCapture {
            waiting_on: Some("Which branch?".to_owned()),
        },
    )
    .unwrap();
    let engine = engine_on(&conn);
    observe(
        &engine,
        r#"[{"type":"turn.ended","agent":"root","outcome":"completed"}]"#,
    );
    assert_eq!(field(&conn, "paused").as_deref(), Some(""));
    assert_eq!(field(&conn, "reason"), None);
    assert_eq!(field(&conn, "continuation"), None);
    assert_eq!(field(&conn, "trigger"), None);
    assert!(!crate::restart::has_capture(&conn, "t").unwrap());
}

#[test]
fn a_fact_that_says_nothing_of_a_limit_leaves_its_hold_alone() {
    let conn = home("t", &limited_header("t", Some(9_000)));
    queue(
        &conn,
        "INSERT INTO engine_queue (thread_id, limited, paused, reason, reset_at, resume_at, timer_action, hold_token)
         VALUES ('t', 1, 1, 'limit', 9000, 9000, 'resume', 3)",
    );
    let engine = engine_on(&conn);
    observe(&engine, r#"[{"type":"usage","agent":"root"}]"#);
    assert_eq!(field(&conn, "paused").as_deref(), Some("1"));
    assert_eq!(field(&conn, "limited").as_deref(), Some("1"));
    assert_eq!(field(&conn, "resume_at").as_deref(), Some("9000"));
    assert_eq!(field(&conn, "hold_token").as_deref(), Some("3"));
}

#[test]
fn a_stale_restart_capture_is_dropped_when_the_provider_finished_the_turn_while_closing() {
    let conn = home("t", &root_header("t", ""));
    session_row(&conn);
    queue(
        &conn,
        "INSERT INTO engine_queue (thread_id, continuation, trigger, hold_token)
         VALUES ('t', 'Continue where you left off.', 'restart', 1)",
    );
    crate::restart::ensure_ledgers(&conn).unwrap();
    crate::restart::record_capture(
        &conn,
        "t",
        &crate::restart::RestartCapture { waiting_on: None },
    )
    .unwrap();
    // The state carries no run or live work: nothing was lost, so the capture is stale.
    let engine = engine_on(&conn);
    observe(
        &engine,
        r#"[{"type":"turn.ended","agent":"root","outcome":"completed"}]"#,
    );
    assert_eq!(field(&conn, "continuation"), None);
    assert_eq!(field(&conn, "trigger"), None);
    assert!(!crate::restart::has_capture(&conn, "t").unwrap());
}
