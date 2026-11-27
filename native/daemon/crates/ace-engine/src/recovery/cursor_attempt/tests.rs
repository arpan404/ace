// SPDX-License-Identifier: Apache-2.0
//! A Cursor send's fate over a real store: when settling would send it again, which held sends
//! are in doubt, and what a read-back that settles nothing says.
//!
//! Ported cases: `cursor-recovery.process.test.ts`'s settlement rule (a); the decisions here are
//! the ones `cursor-attempt-record.test.ts:71` and `:163` pin on the record.

use super::*;
use crate::repository::testsupport::{Shell, home};
use ace_core::state::CoreConfig;
use std::rc::Rc;
use std::sync::Arc;

fn engine_on(conn: &Arc<ace_store::Connection>) -> crate::Engine {
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

/// A stored thread with its root agent resident.
fn root_header(thread: &str) -> String {
    let mut state = ace_core::state::create_thread_state(
        thread.to_owned(),
        None,
        CoreConfig {
            provider: "cursor".to_owned(),
            silence_ms: 100.0,
            liveness: None,
        },
    )
    .unwrap();
    state.root_key = Some("root".to_owned());
    let record: ace_core::state::AgentRecord = ace_json::from_value(
        &ace_json::parse(&format!(
            r#"{{"agent":{{"id":"agent-root","threadId":"{thread}","parentId":null,"origin":"person","native":{{"provider":"cursor","nativeId":"native-root"}},"fidelity":"full","cwd":"/tmp","status":{{"state":"working","activity":"thinking"}},"createdAt":0}},"activity":"thinking","lastSignalAt":0}}"#
        ))
        .unwrap(),
    )
    .unwrap();
    state.agents.insert("root".to_owned(), record);
    state
        .indexes
        .agent_keys_by_id
        .insert("agent-root".to_owned(), "root".to_owned());
    let text = ace_json::ser::to_string(&state).unwrap();
    format!(r#"{{"engineSnapshot":9,{}"#, &text[1..])
}

fn session_row(conn: &Arc<ace_store::Connection>) {
    conn.exec(
        "INSERT OR REPLACE INTO engine_sessions (thread_id, cwd, native_session_id, backend) VALUES ('t', '/tmp', 'native-1', 'cursor-sdk')",
    )
    .unwrap();
}

/// A send held as uncertain (its delivery fate unread).
fn held_send(conn: &Arc<ace_store::Connection>, command_id: &str) -> i64 {
    let payload = format!(
        r#"{{"id":"{command_id}","deviceId":"device","payload":{{"type":"thread.send","threadId":"t","input":[{{"type":"text","text":"hi"}}]}}}}"#
    );
    conn.exec(&format!(
        "INSERT INTO intents (command_id, thread_id, kind, payload, status, uncertain, delivery)
         VALUES ('{command_id}', 't', 'thread.send', {}, 'running', 1, 'queue')",
        crate::repository::testsupport::sql_text(&payload)
    ))
    .unwrap();
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT id FROM intents WHERE command_id=?",
        vec![ace_store::Value::Text(command_id.to_owned())],
    )
    .unwrap()
    .unwrap();
    row.get("id")
        .and_then(crate::repository::residency::cell_int)
        .unwrap()
}

fn send_frame(conn: &Arc<ace_store::Connection>, command: &str) {
    let data = ace_json::parse(&format!(
        r#"{{"kind":"send","operationId":"{command}","commandId":"{command}","segment":0,"body":{{"attemptedAt":1,"runFramed":true}}}}"#
    ))
    .unwrap();
    super::super::provider_recovery::note(conn, "t", &data).unwrap();
}

fn notice(conn: &Arc<ace_store::Connection>, intent: i64) -> Option<Value> {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT value FROM engine_state_records WHERE thread_id='t' AND section='items' AND key=?",
        vec![ace_store::Value::Text(format!("intent:{intent}"))],
    )
    .unwrap()?;
    let text = row
        .get("value")
        .and_then(crate::repository::residency::cell_text)?;
    ace_json::parse(text).ok()
}

#[test]
fn settling_a_send_cursor_read_back_as_never_admitted_would_send_it_again() {
    let conn = home("t", &root_header("t"));
    session_row(&conn);
    held_send(&conn, "send-1");
    send_frame(&conn, "send-1");
    let engine = engine_on(&conn);
    let core = engine.core();
    // Attempted, held, and nothing beyond the attempt: settling re-queues it.
    assert!(may_requeue(core, "t", "send-1").unwrap());
    let data = ace_json::parse(
        r#"{"kind":"delta","operationId":"send-1","segment":0,"body":{"type":"text-delta"}}"#,
    )
    .unwrap();
    super::super::provider_recovery::note(&conn, "t", &data).unwrap();
    // Its run's output is proof Cursor had it: settling never sends it again.
    assert!(!may_requeue(core, "t", "send-1").unwrap());
}

#[test]
fn a_reopen_that_read_back_nothing_names_the_held_send_as_unconfirmed() {
    let conn = home("t", &root_header("t"));
    session_row(&conn);
    let intent = held_send(&conn, "send-1");
    send_frame(&conn, "send-1");
    let engine = engine_on(&conn);
    let core = engine.core();
    assert_eq!(in_doubt(core, "t").unwrap().len(), 1);
    core.with_state(|state| settle_cursor_attempt(core, state, "t", 9.0, true))
        .unwrap()
        .unwrap();
    let notice = notice(&conn, intent).expect("a notice");
    assert_eq!(
        notice.get("code").and_then(Value::as_str),
        Some("delivery_uncertain")
    );
    assert_eq!(
        notice.get("text").and_then(Value::as_str),
        Some(
            "ace couldn't confirm whether Cursor received this message. It is held in the queue: check the conversation before sending it again"
        )
    );
    // The send stays uncertain: nothing says it wasn't sent.
    let row = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT uncertain FROM intents WHERE id=?",
        vec![ace_store::Value::Integer(intent)],
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        row.get("uncertain")
            .and_then(crate::repository::residency::cell_int),
        Some(1)
    );
}

#[test]
fn a_thread_whose_attempt_is_past_its_kept_frames_holds_every_uncertain_send() {
    let conn = home("t", &root_header("t"));
    session_row(&conn);
    held_send(&conn, "send-1");
    held_send(&conn, "send-2");
    // An earlier build's thread: no send among its newest 4,096 frames.
    let mut values = Vec::new();
    for seq in 1..=4097 {
        values.push(format!(
            "('t','host',{seq},{})",
            crate::repository::testsupport::sql_text(&format!(
                r#"{{"seq":{seq},"t":{seq},"dir":"recv","channel":"sdk","data":{{"kind":"host-output","operationId":"other","segment":0,"body":{{}}}}}}"#
            ))
        ));
    }
    conn.exec(&format!(
        "INSERT INTO engine_provider_frames VALUES {}",
        values.join(",")
    ))
    .unwrap();
    let engine = engine_on(&conn);
    let core = engine.core();
    // The record is rebuilt as "older": which send it was is unknown, so all held sends wait.
    assert_eq!(in_doubt(core, "t").unwrap().len(), 2);
    assert!(super::super::provider_recovery::unknown_attempt(&conn, "t").unwrap());
}
