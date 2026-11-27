// SPDX-License-Identifier: Apache-2.0
//! The delegation rows' cases: the remote child's status, and the hold that keeps a parent from
//! reading done while a child works on another machine.

use super::*;
use crate::executor::{Notified, Notifier};
use crate::repository::testsupport::{Shell, header, home};
use std::rc::Rc;
use std::sync::Arc;

fn value(text: &str) -> Value {
    ace_json::parse(text).expect("json")
}

struct Pump;

impl Notifier for Pump {
    fn notify(&self) -> Notified {
        Notified::Posted
    }
}

fn engine_on(conn: &Arc<ace_store::Connection>) -> crate::Engine {
    let (_, shell) = Shell::store_with_controls(conn);
    crate::Engine::new(
        shell.clone(),
        shell,
        crate::Inputs::default(),
        "[]",
        Box::new(Pump),
        conn,
        Rc::new(crate::actor::ActorDeps::production(
            Rc::new(crate::frames::live::UnportedLive),
            0.0,
        )),
    )
    .expect("engine")
}

/// A parent thread whose root agent is `agent-root`.
fn parent() -> (Arc<ace_store::Connection>, crate::Engine) {
    let conn = home("parent", &header("parent"));
    conn.exec(
        "UPDATE thread_state SET state = json_set(state, '$.rootKey', 'root', '$.agents', json('{\"root\":{\"agent\":{\"id\":\"agent-root\",\"threadId\":\"parent\",\"parentId\":null,\"origin\":\"person\",\"native\":{\"provider\":\"codex\"},\"status\":{\"state\":\"idle\"},\"fidelity\":\"full\",\"cwd\":\"/tmp\",\"background\":false,\"createdAt\":1},\"activity\":\"idle\",\"lastSignalAt\":1}}'), '$.indexes.agentKeysById', json('{\"agent-root\":\"root\"}')) WHERE thread_id='parent'",
    )
    .unwrap();
    let row = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT state FROM thread_state WHERE thread_id='parent'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    let text = row
        .get("state")
        .and_then(crate::repository::residency::cell_text)
        .unwrap();
    let state: Value = ace_json::parse(text).unwrap();
    assert_eq!(
        state
            .get("indexes")
            .and_then(|indexes| indexes.get("agentKeysById"))
            .and_then(|keys| keys.get("agent-root"))
            .and_then(Value::as_str),
        Some("root"),
        "{text}"
    );
    // The indexes are sections (`load_indexes`), not only header fields: the opener writes both.
    conn.exec(
        "INSERT INTO engine_state_records VALUES ('parent', 'agentKeysById', 'agent-root', '\"root\"')",
    )
    .unwrap();
    let engine = engine_on(&conn);
    engine
        .core()
        .with_state(|state| state.repo.probe_passthrough = true)
        .unwrap();
    (conn, engine)
}

fn child(state: &str) -> MachineChild<'_> {
    MachineChild {
        id: "child",
        parent_id: "parent",
        parent_agent_id: "agent-root",
        machine: "Studio",
        name: "Studio",
        host_id: None,
        provider: "codex",
        model: None,
        role: "Reviewer",
        title: "Review the queue",
        status: value(r#"{"state":"working","agents":1}"#),
        state,
        outcome: None,
        contact: None,
    }
}

fn parent_state(engine: &crate::Engine) -> Rc<std::cell::RefCell<crate::snapshot::Snapshot>> {
    let core = engine.core();
    core.with_state(|state| state.repo.require_state(&core.store, "parent"))
        .unwrap()
        .unwrap()
}

fn task_status(engine: &crate::Engine, task: &str) -> Option<String> {
    parent_state(engine)
        .borrow_mut()
        .task(task)
        .unwrap()
        .map(|task| task.status)
}

#[test]
fn a_remote_childs_status_follows_its_machines_reading_and_a_lost_one_needs_the_person() {
    let status = value(r#"{"state":"working","agents":2}"#);
    assert_eq!(
        remote_child_status("done", &status, false),
        value(r#"{"state":"done"}"#)
    );
    assert_eq!(
        remote_child_status("cancelled", &status, false),
        value(r#"{"state":"done"}"#)
    );
    assert_eq!(
        remote_child_status("failed", &status, false),
        value(r#"{"state":"failed"}"#)
    );
    // Requests already open in the parent count there; the agent itself does not repeat them.
    assert_eq!(
        remote_child_status("needs_you", &status, false),
        value(r#"{"state":"needs_you","interactions":1}"#)
    );
    assert_eq!(
        remote_child_status("needs_you", &status, true),
        value(r#"{"state":"working","agents":1}"#)
    );
    // A queued child keeps a waiting status; anything else reads as waiting on its queue.
    assert_eq!(
        remote_child_status(
            "queued",
            &value(r#"{"state":"waiting","on":"limit"}"#),
            false
        ),
        value(r#"{"state":"waiting","on":"limit"}"#)
    );
    assert_eq!(
        remote_child_status("queued", &status, false),
        value(r#"{"state":"waiting","on":"queue"}"#)
    );
    // A working child keeps a live status and falls back to working for a settled one.
    assert_eq!(remote_child_status("working", &status, false), status);
    assert_eq!(
        remote_child_status("working", &value(r#"{"state":"done"}"#), false),
        value(r#"{"state":"working","agents":1}"#)
    );
}

#[test]
fn the_child_agent_key_is_the_one_both_ends_name() {
    assert_eq!(child_agent_key("child"), "ace-child:child");
    assert_eq!(
        outcome_state(Some(&value(r#"{"outcome":"completed"}"#))),
        "done"
    );
    assert_eq!(
        outcome_state(Some(&value(r#"{"outcome":"cancelled"}"#))),
        "cancelled"
    );
    assert_eq!(outcome_state(None), "failed");
}

#[test]
fn a_machine_child_opens_a_hold_that_keeps_the_parent_from_reading_done() {
    let (conn, engine) = parent();
    let core = engine.core();
    core.with_state(|state| {
        machine_child(core, state, 1_000.0, &child("working"), Some(Hold::Start))
    })
    .unwrap()
    .unwrap();
    assert_eq!(
        task_status(&engine, "ace-machine:child").as_deref(),
        Some("running")
    );
    // The summary agent exists in the parent with its machine's name.
    let summary = parent_state(&engine)
        .borrow_mut()
        .agent("ace-child:child")
        .unwrap()
        .expect("the summary agent");
    assert_eq!(
        summary
            .agent
            .machine
            .as_ref()
            .map(|machine| machine.name.as_str()),
        Some("Studio")
    );
    let _ = &conn;
    // Ending it with a completed outcome ends the hold, so the parent may read done.
    let mut done = child("done");
    done.outcome = Some(value(r#"{"outcome":"completed"}"#));
    core.with_state(|state| machine_child(core, state, 2_000.0, &done, Some(Hold::End)))
        .unwrap()
        .unwrap();
    assert_eq!(
        task_status(&engine, "ace-machine:child").as_deref(),
        Some("completed")
    );
}

#[test]
fn a_lost_contact_never_ends_the_hold_and_a_child_here_is_a_summary_agent() {
    let (_conn, engine) = parent();
    let core = engine.core();
    let mut lost = child("working");
    lost.contact = Some("lost");
    core.with_state(|state| machine_child(core, state, 1_000.0, &lost, Some(Hold::Start)))
        .unwrap()
        .unwrap();
    // No `end` for lost contact: not knowing whether a child ended is not knowing it did.
    assert_eq!(
        task_status(&engine, "ace-machine:child").as_deref(),
        Some("running")
    );

    // A child on this machine attaches as a summary agent with its own status.
    let child_thread =
        value(r#"{"id":"local-child","provider":"codex","status":{"state":"working","agents":1}}"#);
    core.with_state(|state| {
        attach_child(
            core,
            state,
            2_000.0,
            "parent",
            "agent-root",
            &Child {
                thread: &child_thread,
                role: "Reviewer",
                background: false,
            },
        )
    })
    .unwrap()
    .unwrap();
    let agent = parent_state(&engine)
        .borrow_mut()
        .agent("ace-child:local-child")
        .unwrap()
        .expect("the summary agent");
    assert_eq!(agent.agent.fidelity, "summary");
    assert!(
        matches!(
            agent.external_status,
            Some(ace_core::status::ThreadStatus::Working { agents: 1, .. })
        ),
        "{:?}",
        agent.external_status
    );
}

#[test]
fn a_settled_delegation_records_its_input_its_summaries_and_the_parents_item() {
    let (conn, engine) = parent();
    let core = engine.core();
    let results = vec![
        value(
            r#"{"threadId":"child","outcome":"completed","result":"all good","truncated":false}"#,
        ),
        value(&format!(
            r#"{{"threadId":"child-2","outcome":"failed","result":"{}"}}"#,
            "x".repeat(200)
        )),
    ];
    core.with_state(|state| {
        delegation_settled(
            core,
            state,
            1_000.0,
            &DelegationSettled {
                parent_id: "parent",
                parent_agent_id: "agent-root",
                command_id: "call-1",
                results: &results,
                delivery: "tool",
                text: Some("Two children came back"),
            },
        )
    })
    .unwrap()
    .unwrap();
    // The input the call carried is journalled as ace's own child result.
    let journal = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT origin FROM engine_inputs WHERE thread_id='parent' AND item_key='input:call-1'",
        Vec::new(),
    )
    .unwrap()
    .expect("the journal entry");
    let origin: Value = ace_json::parse(
        journal
            .get("origin")
            .and_then(crate::repository::residency::cell_text)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        origin.get("kind").and_then(Value::as_str),
        Some("subagent_result")
    );
    assert_eq!(
        origin
            .get("threadIds")
            .and_then(Value::as_array)
            .map(|ids| ids.len()),
        Some(2)
    );
    // The summaries are kept with their result truncated.
    let recorded = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT value FROM engine_ace_inputs WHERE thread_id='parent' AND command_id='call-1'",
        Vec::new(),
    )
    .unwrap()
    .expect("the ace input");
    let value: Value = ace_json::parse(
        recorded
            .get("value")
            .and_then(crate::repository::residency::cell_text)
            .unwrap(),
    )
    .unwrap();
    let results = value
        .get("results")
        .and_then(Value::as_array)
        .expect("results");
    assert_eq!(results.len(), 2);
    assert_eq!(
        results[1].get("truncated"),
        Some(&Value::Bool(true)),
        "a long result is marked truncated"
    );
    assert_eq!(
        results[1]
            .get("result")
            .and_then(Value::as_str)
            .map(|text| text.chars().count()),
        Some(128)
    );
    // And the parent shows one settled item for the call (the items are a section row).
    let item = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT value FROM engine_state_records WHERE thread_id='parent' AND section='items' AND key='ace-results:call-1'",
        Vec::new(),
    )
    .unwrap()
    .expect("the item");
    let item: Value = ace_json::parse(
        item.get("value")
            .and_then(crate::repository::residency::cell_text)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        item.get("type").and_then(Value::as_str),
        Some("delegation.settled")
    );
    assert_eq!(item.get("delivery").and_then(Value::as_str), Some("tool"));
    assert_eq!(
        item.get("results")
            .and_then(Value::as_array)
            .map(|results| results.len()),
        Some(2)
    );
}

fn settle_result(engine: &crate::Engine, text: &str) -> Result<(), EngineError> {
    let core = engine.core();
    core.with_state(|state| {
        delegation_settled(
            core,
            state,
            1_000.0,
            &DelegationSettled {
                parent_id: "parent",
                parent_agent_id: "agent-root",
                command_id: "result",
                results: &[value(r#"{"threadId":"child","outcome":"completed","result":"Done","truncated":false}"#)],
                delivery: "tool",
                text: Some(text),
            },
        )
    })?
}

fn settled_rows(conn: &Arc<ace_store::Connection>) -> (i64, i64, i64) {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT
            (SELECT count(*) FROM engine_inputs WHERE thread_id='parent' AND item_key='input:result') AS journal,
            (SELECT count(*) FROM engine_ace_inputs WHERE thread_id='parent' AND command_id='result') AS attribution,
            (SELECT count(*) FROM engine_state_records WHERE thread_id='parent' AND section='items' AND key='ace-results:result') AS item",
        Vec::new(),
    ).unwrap().unwrap();
    let count = |key| {
        row.get(key)
            .and_then(crate::repository::residency::cell_int)
            .unwrap()
    };
    (count("journal"), count("attribution"), count("item"))
}

#[test]
fn a_delegation_result_whose_item_fails_leaves_no_input_or_attribution() {
    let (conn, engine) = parent();
    conn.exec(
        "CREATE TEMP TRIGGER fail_result BEFORE INSERT ON engine_state_records
           WHEN NEW.key='ace-results:result'
           BEGIN SELECT RAISE(ABORT, 'result item cannot be stored'); END",
    )
    .unwrap();
    let error = settle_result(&engine, "The child finished").unwrap_err();
    assert!(error.to_string().contains("result item cannot be stored"));
    assert_eq!(settled_rows(&conn), (0, 0, 0));

    conn.exec("DROP TRIGGER fail_result").unwrap();
    settle_result(&engine, "The child finished").unwrap();
    assert_eq!(settled_rows(&conn), (1, 1, 1));
}

#[test]
fn a_delegation_result_with_empty_text_only_records_the_item() {
    let (conn, engine) = parent();
    settle_result(&engine, "").unwrap();
    assert_eq!(settled_rows(&conn), (0, 0, 1));
}
