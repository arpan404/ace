// SPDX-License-Identifier: Apache-2.0
//! Imported-thread adoption: its live root enters the engine with the native session the import
//! recorded, and a thread already resident is left alone.

use super::*;
use crate::repository::testsupport::{Shell, home, sql_text};
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

/// A thread imported from Claude's history, with its root agent stored.
fn imported(conn: &Arc<ace_store::Connection>, native_id: Option<&str>) {
    // An imported thread has no engine state of its own yet: adoption builds it.
    conn.exec("DELETE FROM thread_state WHERE thread_id='t'")
        .unwrap();
    conn.exec(
        r#"UPDATE threads SET imported='{"native":{"nativeId":"import-native"},"instanceId":"instance-1"}' WHERE id='t'"#,
    )
    .unwrap();
    conn.exec("UPDATE threads SET root_agent_id='agent-imported' WHERE id='t'")
        .unwrap();
    conn.exec("UPDATE threads SET provider='claude' WHERE id='t'")
        .unwrap();
    let native = native_id.map_or(String::new(), |id| format!(r#","nativeId":"{id}""#));
    conn.exec(&format!(
        "INSERT INTO mcp_agents VALUES ('t', 'agent-imported', {})",
        sql_text(&format!(
            r#"{{"id":"agent-imported","threadId":"t","parentId":null,"origin":"person","native":{{"provider":"claude"{native}}},"fidelity":"full","cwd":"/tmp","status":{{"state":"idle"}},"createdAt":0,"model":"sonnet"}}"#
        ))
    ))
    .unwrap();
}

fn column(conn: &Arc<ace_store::Connection>, sql: &'static str) -> Option<String> {
    ace_store::stmt_cache::get_row(conn, sql, Vec::new())
        .unwrap()
        .and_then(|row| {
            row.get("value")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
        })
}

#[test]
fn an_imported_thread_enters_the_engine_with_its_native_session_and_live_root() {
    let conn = home("t", &crate::repository::testsupport::header("t"));
    imported(&conn, Some("root-native"));
    let engine = engine_on(&conn);
    let core = engine.core();
    core.with_state(|state| adopt_imported_thread(core, state, "t", 5.0, 100.0))
        .unwrap()
        .unwrap();
    assert_eq!(
        column(
            &conn,
            "SELECT native_session_id AS value FROM engine_sessions WHERE thread_id='t'"
        ),
        Some("root-native".to_owned())
    );
    assert_eq!(
        column(
            &conn,
            "SELECT model AS value FROM engine_sessions WHERE thread_id='t'"
        ),
        Some("sonnet".to_owned())
    );
    assert!(
        column(
            &conn,
            "SELECT instance_id AS value FROM engine_sessions WHERE thread_id='t'"
        )
        .is_some_and(|instance| instance == "instance-1")
    );
    assert!(
        column(
            &conn,
            "SELECT thread_id AS value FROM engine_queue WHERE thread_id='t'"
        )
        .is_some()
    );
    assert!(
        column(
            &conn,
            "SELECT thread_id AS value FROM engine_permissions WHERE thread_id='t'"
        )
        .is_some()
    );
    let state = column(
        &conn,
        "SELECT state AS value FROM thread_state WHERE thread_id='t'",
    )
    .unwrap();
    let state: Value = ace_json::parse(&state).unwrap();
    assert_eq!(state.get("rootKey").and_then(Value::as_str), Some("root"));
    // The live root and its id → key are records, as every saved home keeps them.
    let root = column(
        &conn,
        "SELECT value AS value FROM engine_state_records WHERE thread_id='t' AND section='agents' AND key='root'",
    )
    .unwrap();
    let root: Value = ace_json::parse(&root).unwrap();
    assert_eq!(
        root.get("activity").and_then(Value::as_str),
        Some("thinking")
    );
    assert_eq!(
        column(
            &conn,
            "SELECT value AS value FROM engine_state_records WHERE thread_id='t' AND section='agentKeysById' AND key='agent-imported'",
        ),
        Some("\"root\"".to_owned())
    );
}

#[test]
fn adopting_a_thread_that_cannot_supply_its_parts_says_which_one() {
    let conn = home("t", &crate::repository::testsupport::header("t"));
    conn.exec("DELETE FROM thread_state WHERE thread_id='t'")
        .unwrap();
    let engine = engine_on(&conn);
    let core = engine.core();
    let error = core
        .with_state(|state| adopt_imported_thread(core, state, "t", 5.0, 100.0))
        .unwrap()
        .unwrap_err();
    assert_eq!(error.to_string(), "Imported thread unavailable");
    // An import with no native identity is refused with its own words.
    imported(&conn, None);
    conn.exec("DELETE FROM thread_state WHERE thread_id='t'")
        .unwrap();
    conn.exec(r#"UPDATE threads SET imported='{"instanceId":"i"}' WHERE id='t'"#)
        .unwrap();
    let error = core
        .with_state(|state| adopt_imported_thread(core, state, "t", 5.0, 100.0))
        .unwrap()
        .unwrap_err();
    assert_eq!(error.to_string(), "Native session identity unavailable");
}

#[test]
fn a_provider_that_cannot_resume_never_continues_an_import() {
    let conn = home("t", &crate::repository::testsupport::header("t"));
    imported(&conn, Some("root-native"));
    let engine = engine_on(&conn);
    let core = engine.core();
    let answer = core
        .with_state(|state| continue_answer(core, state, "t", "resume"))
        .unwrap()
        .unwrap();
    assert_eq!(
        answer,
        ContinueAnswer::Unsupported(
            "Import this session to read it. This provider cannot continue it in ace.".to_owned()
        )
    );
}
