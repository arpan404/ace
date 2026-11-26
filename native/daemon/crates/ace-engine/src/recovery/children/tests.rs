// SPDX-License-Identifier: Apache-2.0
//! The limited children a parent's account move takes with it: who is captured, and the exact
//! commands each one gets.

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

fn thread(conn: &Arc<ace_store::Connection>, id: &str, status: &str) {
    conn.exec(&format!(
        "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at)
         VALUES ('{id}', 'workspace', 'Thread', 'codex', '{{\"state\":\"{status}\"}}', 0, 0)"
    ))
    .unwrap();
    let state = ace_core::state::create_thread_state(
        id.to_owned(),
        None,
        CoreConfig {
            provider: "codex".to_owned(),
            silence_ms: 100.0,
            liveness: None,
        },
    )
    .unwrap();
    let text = ace_json::ser::to_string(&state).unwrap();
    conn.exec(&format!(
        "INSERT INTO thread_state VALUES ('{id}', {}, 0)",
        crate::repository::testsupport::sql_text(&format!(
            r#"{{"engineSnapshot":9,{}"#,
            &text[1..]
        ))
    ))
    .unwrap();
    conn.exec(&format!(
        "INSERT INTO engine_queue (thread_id) VALUES ('{id}')"
    ))
    .unwrap();
    conn.exec(&format!(
        "INSERT INTO engine_sessions (thread_id, cwd) VALUES ('{id}', '/tmp')"
    ))
    .unwrap();
}

/// The parent with agents for each child, each child's external status as given.
fn parent(conn: &Arc<ace_store::Connection>, children: &[(&str, &str)]) {
    let mut state = ace_core::state::create_thread_state(
        "parent".to_owned(),
        None,
        CoreConfig {
            provider: "codex".to_owned(),
            silence_ms: 100.0,
            liveness: None,
        },
    )
    .unwrap();
    state.root_key = Some("root".to_owned());
    let root: ace_core::state::AgentRecord = ace_json::from_value(
        &ace_json::parse(r#"{"agent":{"id":"agent-root","threadId":"parent","parentId":null,"origin":"person","native":{"provider":"codex"},"fidelity":"full","cwd":"/tmp","status":{"state":"idle"},"createdAt":0},"activity":"idle","lastSignalAt":0}"#).unwrap(),
    )
    .unwrap();
    state.agents.insert("root".to_owned(), root);
    for (index, (child, external)) in children.iter().enumerate() {
        let key = format!("child-{index}");
        let record: ace_core::state::AgentRecord = ace_json::from_value(
            &ace_json::parse(&format!(
                r#"{{"agent":{{"id":"agent-{key}","threadId":"parent","parentId":"root","origin":"person","native":{{"provider":"codex"}},"fidelity":"full","cwd":"/tmp","status":{{"state":"idle"}},"createdAt":0,"childThreadId":"{child}"}},"activity":"idle","lastSignalAt":0,"externalStatus":{{"state":"{external}"}}}}"#
            ))
            .unwrap(),
        )
        .unwrap();
        state.agents.insert(key, record);
    }
    let text = ace_json::ser::to_string(&state).unwrap();
    thread(conn, "parent", "new");
    conn.exec(&format!(
        "UPDATE thread_state SET state={} WHERE thread_id='parent'",
        crate::repository::testsupport::sql_text(&format!(
            r#"{{"engineSnapshot":9,{}"#,
            &text[1..]
        ))
    ))
    .unwrap();
}

#[test]
fn a_working_child_and_a_manually_stopped_one_keep_their_owner() {
    let conn = home("t", "");
    for child in ["limited-1", "limited-2", "stopped", "working"] {
        thread(&conn, child, "limited");
    }
    parent(
        &conn,
        &[
            ("limited-1", "limited"),
            ("limited-2", "limited"),
            ("stopped", "limited"),
            ("working", "idle"),
        ],
    );
    conn.exec("UPDATE engine_queue SET paused=1, reason='stopped' WHERE thread_id='stopped'")
        .unwrap();
    let engine = engine_on(&conn);
    let core = engine.core();
    let children = core
        .with_state(|state| limited_children(core, state, "parent"))
        .unwrap()
        .unwrap();
    assert_eq!(
        children,
        vec!["limited-1".to_owned(), "limited-2".to_owned()]
    );
}

#[test]
fn the_parents_move_and_each_childs_continue_are_receipted_and_named_once_each() {
    let conn = home("t", "");
    for child in ["a", "b"] {
        thread(&conn, child, "limited");
    }
    parent(&conn, &[("a", "limited"), ("b", "limited")]);
    let mut dispatched: Vec<Value> = Vec::new();
    let mut dispatch = |command: &Value| {
        dispatched.push(command.clone());
        Ok(ace_json::parse(r#"{"ok":true}"#).unwrap())
    };
    let selection = ace_json::parse(r#"{"provider":"claude","options":{}}"#).unwrap();
    let source = ace_json::parse(r#"{"id":"move-1","deviceId":"device"}"#).unwrap();
    recover_limited_children(
        engine_on(&conn).core(),
        &["a".to_owned(), "a".to_owned(), "b".to_owned()],
        &selection,
        &source,
        &mut dispatch,
    )
    .unwrap();
    assert_eq!(dispatched.len(), 4);
    assert_eq!(
        dispatched[0].get("id").and_then(Value::as_str),
        Some("move-1:child:a:switch")
    );
    assert_eq!(
        dispatched[0]
            .get("payload")
            .and_then(|payload| payload.get("type"))
            .and_then(Value::as_str),
        Some("thread.switch")
    );
    assert_eq!(
        dispatched[1].get("id").and_then(Value::as_str),
        Some("move-1:child:a:continue")
    );
    let payload = dispatched[1].get("payload").unwrap();
    assert_eq!(
        payload.get("delivery").and_then(Value::as_str),
        Some("queue")
    );
    assert_eq!(
        payload
            .get("input")
            .and_then(Value::as_array)
            .and_then(|input| input.first())
            .and_then(|part| part.get("text"))
            .and_then(Value::as_str),
        Some(CONTINUE_TEXT)
    );
    assert_eq!(
        dispatched[2].get("id").and_then(Value::as_str),
        Some("move-1:child:b:switch")
    );
}

#[test]
fn a_child_that_is_no_longer_limited_is_never_switched() {
    let conn = home("t", "");
    thread(&conn, "a", "done");
    let mut dispatched = Vec::new();
    let mut dispatch = |command: &Value| {
        dispatched.push(command.clone());
        Ok(ace_json::parse(r#"{"ok":true}"#).unwrap())
    };
    let selection = ace_json::parse(r#"{"provider":"claude","options":{}}"#).unwrap();
    let source = ace_json::parse(r#"{"id":"move-1","deviceId":"device"}"#).unwrap();
    recover_limited_children(
        engine_on(&conn).core(),
        &["a".to_owned()],
        &selection,
        &source,
        &mut dispatch,
    )
    .unwrap();
    assert!(dispatched.is_empty());
}

#[test]
fn a_refused_switch_names_the_child_and_its_error() {
    let conn = home("t", "");
    thread(&conn, "a", "limited");
    let mut dispatch = |_command: &Value| {
        Ok(ace_json::parse(r#"{"ok":false,"error":"provider_disabled"}"#).unwrap())
    };
    let selection = ace_json::parse(r#"{"provider":"claude","options":{}}"#).unwrap();
    let source = ace_json::parse(r#"{"id":"move-1","deviceId":"device"}"#).unwrap();
    let error = recover_limited_children(
        engine_on(&conn).core(),
        &["a".to_owned()],
        &selection,
        &source,
        &mut dispatch,
    )
    .unwrap_err();
    assert_eq!(
        error.to_string(),
        "Could not switch limited child a: provider_disabled"
    );
}
