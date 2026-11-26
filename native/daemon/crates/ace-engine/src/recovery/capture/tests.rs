// SPDX-License-Identifier: Apache-2.0
//! The captures and holds over a real store: what a shutdown leaves behind, what a Stop refuses,
//! and what a settled thread no longer waits for.
//!
//! Ported cases: `restart-resume.process.test.ts:345` ("a turn waiting on the person's answer
//! doesn't resume after a graceful restart"), `:188` ("a thread stopped while its turn wound down
//! stays stopped across a restart"), `:406` ("a provider that dies mid-turn while ace keeps
//! running holds its queue until Resume"); `queue-recovery.process.test.ts:486` ("an
//! unacknowledged send is never replayed: Resume refuses it and the next message goes ahead
//! without it").

use super::*;
use crate::repository::testsupport::{Shell, home};
use ace_core::state::{CoreConfig, create_thread_state};
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

/// A stored thread with a live run and, when asked, a question it waits on the person to answer.
fn live_header(thread: &str, question: bool) -> String {
    let mut state = create_thread_state(
        thread.to_owned(),
        None,
        CoreConfig {
            provider: "codex".to_owned(),
            silence_ms: 100.0,
            liveness: None,
        },
    )
    .unwrap();
    state.root_key = Some("root".to_owned());
    let record: ace_core::state::AgentRecord = ace_json::from_value(
        &ace_json::parse(&format!(
            r#"{{"agent":{{"id":"root","threadId":"{thread}","parentId":null,"origin":"person","native":{{"provider":"codex","nativeId":"native-root"}},"fidelity":"full","cwd":"/tmp","status":{{"state":"working","activity":"thinking"}},"createdAt":0}},"activity":"working","lastSignalAt":0,"activeRun":"run-1"}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    state.agents.insert("root".to_owned(), record);
    state.runs.insert(
        "run-1".to_owned(),
        ace_json::from_value(
            &ace_json::parse(&format!(
                r#"{{"id":"run-1","threadId":"{thread}","agentId":"root","trigger":"user","seq":1,"state":"active","startedAt":1}}"#
            ))
            .unwrap(),
        )
        .unwrap(),
    );
    if question {
        let interaction: ace_core::entity_model::Interaction = ace_json::from_value(
            &ace_json::parse(&format!(
                r#"{{"id":"ask-1","threadId":"{thread}","agentId":"root","blocking":true,"request":{{"kind":"question","questions":[{{"id":"q1","text":"Which branch?","options":[]}}]}},"state":"pending","createdAt":1}}"#
            ))
            .unwrap(),
        )
        .unwrap();
        state.interactions.insert("ask-1".to_owned(), interaction);
        state
            .indexes
            .pending_interactions
            .insert("ask-1".to_owned(), true);
    }
    let text = ace_json::ser::to_string(&state).unwrap();
    format!(r#"{{"engineSnapshot":9,{}"#, &text[1..])
}

/// Every thread an engine folds has its session binding row (the TypeScript's createEngineThread).
fn session_row(conn: &Arc<Connection>) {
    conn.exec("INSERT INTO engine_sessions (thread_id, cwd) VALUES ('t', '/tmp')")
        .unwrap();
}

fn queue(conn: &Arc<Connection>, sql: &str) {
    conn.exec(sql).unwrap();
}

fn queue_field(conn: &Arc<Connection>, name: &str) -> Option<String> {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT paused, reason, continuation, trigger, exited, hold_token FROM engine_queue WHERE thread_id='t'",
        Vec::new(),
    )
    .unwrap()?;
    row.get(name)
        .and_then(crate::repository::residency::cell_text)
        .map(str::to_owned)
        .or_else(|| {
            row.get(name)
                .and_then(crate::repository::residency::cell_int)
                .map(|value| value.to_string())
        })
}

#[test]
fn a_graceful_restart_captures_the_continue_and_the_question_it_waited_on() {
    let conn = home("t", &live_header("t", true));
    session_row(&conn);
    crate::restart::ensure_ledgers(&conn).unwrap();
    // The records a real home carries: the interaction and the index entry naming it.
    conn.exec(&format!(
        "INSERT INTO engine_state_records VALUES ('t', 'interactions', 'ask-1', {})",
        crate::repository::testsupport::sql_text(
            r#"{"id":"ask-1","threadId":"t","agentId":"root","blocking":true,"request":{"kind":"question","questions":[{"id":"q1","text":"Which branch?","options":[],"multiSelect":false,"allowOther":false,"secret":false}]},"state":"pending","createdAt":1,"raw":[]}"#
        )
    ))
    .unwrap();
    conn.exec(
        "INSERT INTO engine_state_records VALUES ('t', 'pendingInteractions', 'ask-1', 'true')",
    )
    .unwrap();
    let engine = engine_on(&conn);
    capture_restart(engine.core(), "t").unwrap();
    let continuation = queue_field(&conn, "continuation").expect("a continuation");
    assert!(
        continuation.starts_with("ace restarted while you were working"),
        "{continuation}"
    );
    assert_eq!(queue_field(&conn, "trigger").as_deref(), Some("restart"));
    // The person's question is saved beside it: it expires when the provider closes, so this
    // record is the only evidence startup can read.
    let capture = crate::restart::take_capture(&conn, "t").unwrap().unwrap();
    assert_eq!(capture.waiting_on.as_deref(), Some("Which branch?"));
}

#[test]
fn a_plain_capture_names_no_restart_and_drops_an_older_restart_capture() {
    let conn = home("t", &live_header("t", false));
    session_row(&conn);
    crate::restart::ensure_ledgers(&conn).unwrap();
    crate::restart::record_capture(
        &conn,
        "t",
        &crate::restart::RestartCapture {
            waiting_on: Some("old".to_owned()),
        },
    )
    .unwrap();
    let engine = engine_on(&conn);
    capture(engine.core(), "t").unwrap();
    assert_eq!(
        queue_field(&conn, "continuation").as_deref(),
        Some(ace_core::person_input::CONTINUE_MESSAGE)
    );
    assert!(!crate::restart::has_capture(&conn, "t").unwrap());
}

#[test]
fn a_thread_stopped_while_its_turn_wound_down_is_not_captured() {
    let conn = home("t", &live_header("t", false));
    session_row(&conn);
    queue(
        &conn,
        "INSERT INTO engine_queue (thread_id, paused, reason, hold_token) VALUES ('t', 1, 'stopped', 2)",
    );
    let engine = engine_on(&conn);
    capture_restart(engine.core(), "t").unwrap();
    assert_eq!(queue_field(&conn, "continuation"), None);
    assert_eq!(queue_field(&conn, "trigger"), None);
}

#[test]
fn an_uncertain_continuation_is_never_overwritten() {
    let conn = home("t", &live_header("t", false));
    session_row(&conn);
    crate::restart::ensure_ledgers(&conn).unwrap();
    queue(
        &conn,
        "INSERT INTO intents (command_id, thread_id, kind, payload, status, uncertain)
         VALUES ('resume-1', 't', 'thread.resume', '{}', 'running', 1)",
    );
    conn.exec("INSERT INTO engine_state_records VALUES ('t', 'engineRecovery', 'root', '1')")
        .unwrap();
    let engine = engine_on(&conn);
    capture_restart(engine.core(), "t").unwrap();
    assert_eq!(queue_field(&conn, "continuation"), None);
    assert!(!crate::restart::has_capture(&conn, "t").unwrap());
}

#[test]
fn a_discard_cancels_accepted_resumes_and_releases_the_queue_in_one_write() {
    let conn = home("t", &live_header("t", false));
    queue(
        &conn,
        "INSERT INTO engine_queue (thread_id, paused, reason, continuation, trigger, limited, hold_token)
         VALUES ('t', 1, 'manual', 'Continue where you left off.', 'restart', 1, 3)",
    );
    queue(
        &conn,
        "INSERT INTO intents (command_id, thread_id, kind, payload, status)
         VALUES ('resume-1', 't', 'thread.resume', '{}', 'pending')",
    );
    let engine = engine_on(&conn);
    discard(engine.core(), "t").unwrap();
    let intent = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT status, error FROM intents WHERE command_id='resume-1'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        intent
            .get("status")
            .and_then(crate::repository::residency::cell_text),
        Some("failed")
    );
    assert_eq!(
        intent
            .get("error")
            .and_then(crate::repository::residency::cell_text),
        Some("Cancelled before delivery")
    );
    assert_eq!(queue_field(&conn, "paused").as_deref(), Some("0"));
    assert_eq!(queue_field(&conn, "continuation"), None);
    assert_eq!(queue_field(&conn, "trigger"), None);
    assert_eq!(queue_field(&conn, "hold_token").as_deref(), Some("4"));
}

#[test]
fn a_provider_that_dies_with_work_in_flight_holds_the_queue_for_the_person() {
    let conn = home("t", &live_header("t", false));
    let engine = engine_on(&conn);
    hold_interrupted(engine.core(), "t").unwrap();
    assert_eq!(queue_field(&conn, "paused").as_deref(), Some("1"));
    assert_eq!(queue_field(&conn, "reason").as_deref(), Some("restart"));
    assert_eq!(
        queue_field(&conn, "continuation").as_deref(),
        Some(ace_core::person_input::CONTINUE_MESSAGE)
    );
    assert_eq!(queue_field(&conn, "trigger").as_deref(), Some("restart"));
    assert_eq!(queue_field(&conn, "exited").as_deref(), Some("1"));
    // A second interruption keeps the first hold's reason and what it is called.
    hold_interrupted(engine.core(), "t").unwrap();
    assert_eq!(queue_field(&conn, "reason").as_deref(), Some("restart"));
    assert_eq!(queue_field(&conn, "hold_token").as_deref(), Some("2"));
}

#[test]
fn a_settled_thread_finishes_a_restart_hold_instead_of_waiting_forever() {
    let conn = home("t", &live_header("t", false));
    conn.exec(r#"UPDATE threads SET client='{"settledAt":5}' WHERE id='t'"#)
        .unwrap();
    queue(
        &conn,
        "INSERT INTO engine_queue (thread_id, paused, reason, continuation, trigger, hold_token)
         VALUES ('t', 1, 'restart', 'Continue where you left off.', 'restart', 5)",
    );
    let engine = engine_on(&conn);
    close_settled(engine.core(), "t").unwrap();
    assert_eq!(queue_field(&conn, "paused").as_deref(), Some("0"));
    assert_eq!(queue_field(&conn, "reason"), None);
    assert_eq!(queue_field(&conn, "continuation"), None);
    assert_eq!(queue_field(&conn, "hold_token").as_deref(), Some("6"));
}

#[test]
fn a_settled_thread_keeps_its_hold_while_a_child_result_waits_under_it() {
    let conn = home("t", &live_header("t", false));
    conn.exec(r#"UPDATE threads SET client='{"settledAt":5}' WHERE id='t'"#)
        .unwrap();
    queue(
        &conn,
        "INSERT INTO engine_queue (thread_id, paused, reason, continuation, trigger, hold_token)
         VALUES ('t', 1, 'restart', 'Continue where you left off.', 'restart', 5)",
    );
    // A child result waits under the hold; sending it would start a turn in a settled thread.
    queue(
        &conn,
        "INSERT INTO intents (command_id, thread_id, kind, payload, status, trigger)
         VALUES ('child-1', 't', 'thread.send', '{}', 'queued', 'subagent_result')",
    );
    let engine = engine_on(&conn);
    close_settled(engine.core(), "t").unwrap();
    assert_eq!(queue_field(&conn, "paused").as_deref(), Some("1"));
    assert_eq!(
        queue_field(&conn, "continuation").as_deref(),
        Some("Continue where you left off.")
    );
}
