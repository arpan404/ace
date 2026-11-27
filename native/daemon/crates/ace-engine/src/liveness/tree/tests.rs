// SPDX-License-Identifier: Apache-2.0
//! `threadTree`'s cases, moved: the tree's shape, the order and the remote child that is its own
//! machine's.

use super::*;
use crate::repository::testsupport::{Shell, home};
use ace_core::state::{AgentRecord, CoreConfig, create_thread_state};
use ace_json::Value;

fn value(text: &str) -> Value {
    ace_json::parse(text).expect("json")
}

/// A stored thread whose agents own the children named.
fn store_with(
    thread: &str,
    children: &[(&str, Option<&str>)],
) -> std::sync::Arc<ace_store::Connection> {
    let mut state = create_thread_state(
        thread.to_owned(),
        None,
        CoreConfig {
            provider: "codex".to_owned(),
            silence_ms: 1_000.0,
            liveness: None,
        },
    )
    .expect("state");
    state.root_key = Some("root".to_owned());
    for (index, (child, machine)) in children.iter().enumerate() {
        let record: AgentRecord = ace_json::from_value(&value(&format!(
            r#"{{"agent":{{"id":"agent-{index}","threadId":"{thread}","parentId":null,"origin":"ace","native":{{"provider":"codex"}},"status":{{"state":"idle"}},"fidelity":"summary","cwd":"/tmp","background":false,"createdAt":1,"childThreadId":"{child}"{}}},"activity":"idle","lastSignalAt":1}}"#,
            machine
                .map(|name| format!(r#","machine":{{"machine":"{name}","name":"{name}"}}"#))
                .unwrap_or_default()
        )))
        .expect("record");
        state.agents.insert(format!("ace-child:{child}"), record);
    }
    let header = ace_json::ser::to_string(&state).expect("header");
    let header = format!(r#"{{"engineSnapshot":9,{}"#, &header[1..]);
    home(thread, &header)
}

fn engine(conn: &std::sync::Arc<ace_store::Connection>) -> crate::Engine {
    let (_, shell) = Shell::store_with_controls(conn);
    crate::Engine::new(
        shell.clone(),
        shell,
        crate::Inputs::default(),
        "[]",
        Box::new(Pump),
        conn,
        std::rc::Rc::new(crate::actor::ActorDeps::production(
            std::rc::Rc::new(crate::frames::live::UnportedLive),
            0.0,
        )),
    )
    .expect("engine")
}

struct Pump;

impl crate::executor::Notifier for Pump {
    fn notify(&self) -> crate::executor::Notified {
        crate::executor::Notified::Posted
    }
}

fn tree(conn: &std::sync::Arc<ace_store::Connection>, thread: &str) -> Vec<String> {
    let engine = engine(conn);
    let core = engine.core();
    core.with_state(|state| thread_tree(core, state, thread))
        .unwrap()
        .unwrap()
}

#[test]
fn a_thread_with_no_children_is_itself() {
    let conn = store_with("root-thread", &[]);
    assert_eq!(tree(&conn, "root-thread"), vec!["root-thread"]);
}

#[test]
fn a_local_child_joins_the_tree_and_a_remote_one_does_not() {
    let conn = store_with(
        "root-thread",
        &[("local-child", None), ("remote-child", Some("Studio"))],
    );
    // The children's own states are absent, so the walk stops there: the shape is the root and
    // the local child, and the remote child is its own machine's.
    assert_eq!(
        tree(&conn, "root-thread"),
        vec!["root-thread", "local-child"]
    );
}

#[test]
fn the_walk_reaches_grandchildren_through_a_local_child() {
    let conn = store_with("root-thread", &[("child", None)]);
    // The child owns a grandchild in its own stored state.
    let mut child = create_thread_state(
        "child".to_owned(),
        None,
        CoreConfig {
            provider: "codex".to_owned(),
            silence_ms: 1_000.0,
            liveness: None,
        },
    )
    .expect("state");
    child.root_key = Some("root".to_owned());
    let record: AgentRecord = ace_json::from_value(&value(
        r#"{"agent":{"id":"agent-x","threadId":"child","parentId":null,"origin":"ace","native":{"provider":"codex"},"status":{"state":"idle"},"fidelity":"summary","cwd":"/tmp","background":false,"createdAt":1,"childThreadId":"grandchild"},"activity":"idle","lastSignalAt":1}"#,
    ))
    .expect("record");
    child
        .agents
        .insert("ace-child:grandchild".to_owned(), record);
    let header = ace_json::ser::to_string(&child).expect("header");
    let header = format!(r#"{{"engineSnapshot":9,{}"#, &header[1..]);
    conn.exec(
        "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) VALUES ('child', 'workspace', 'Child', 'codex', '{\"state\":\"new\"}', 0, 0)",
    )
    .unwrap();
    conn.exec(&format!(
        "INSERT INTO thread_state VALUES ('child', {}, 0)",
        crate::repository::testsupport::sql_text(&header)
    ))
    .unwrap();
    assert_eq!(
        tree(&conn, "root-thread"),
        vec!["root-thread", "child", "grandchild"]
    );
}

#[test]
fn the_resumable_kinds_are_the_sends_and_recoveries_and_a_control_is_not() {
    for kind in RESUMABLE {
        assert!(resumable(kind), "{kind}");
    }
    assert!(!resumable("thread.interrupt"));
    assert!(!resumable("interaction.resolve"));
    assert!(!resumable("background_task.stop"));
}
