// SPDX-License-Identifier: Apache-2.0
//! Session-bound work over a real store, at a restart's task index.
//!
//! Ported cases: `session-bound-tasks.process.test.ts:41` ("a Claude child placeholder left by a
//! previous daemon run stops holding its thread after restart") and `:125` ("a command a done
//! thread left running reads as lost after a crash and restart, not running forever"). The file's
//! middle case (`:97`, a Claude session that exits settles the child work inside it) drives the
//! same function from E5.6's session exit; its decision is the bound predicate asserted below.

use super::*;
use crate::repository::testsupport::{Shell, home, sql_text};
use ace_core::state::{CoreConfig, create_thread_state};
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

fn task(id: &str, kind: &str, title: &str, status: &str, internal: bool) -> Value {
    ace_json::parse(&format!(
        r#"{{"id":"{id}","agentId":"agent-root","kind":"{kind}","title":"{title}","status":"{status}","ambient":false,"stoppable":true,"startedAt":1{}}}"#,
        if internal { r#","internal":true"# } else { "" }
    ))
    .unwrap()
}

/// A stored thread of `provider` with the tasks the index names, and their records in the store.
fn thread_with(conn: &Arc<ace_store::Connection>, provider: &str, tasks: &[(&str, Value)]) {
    let mut state = create_thread_state(
        "t".to_owned(),
        None,
        CoreConfig {
            provider: provider.to_owned(),
            silence_ms: 100.0,
            liveness: None,
        },
    )
    .unwrap();
    state.root_key = Some("root".to_owned());
    let record: ace_core::state::AgentRecord = ace_json::from_value(
        &ace_json::parse(
            r#"{"agent":{"id":"agent-root","threadId":"t","parentId":null,"origin":"person","native":{"provider":"codex","nativeId":"native-root"},"fidelity":"full","cwd":"/tmp","status":{"state":"idle"},"createdAt":0},"activity":"idle","lastSignalAt":0}"#,
        )
        .unwrap(),
    )
    .unwrap();
    state.agents.insert("root".to_owned(), record);
    state
        .indexes
        .agent_keys_by_id
        .insert("agent-root".to_owned(), "root".to_owned());
    for (key, _) in tasks {
        state.indexes.running_tasks.insert((*key).to_owned(), true);
    }
    let text = ace_json::ser::to_string(&state).unwrap();
    conn.exec(&format!(
        "UPDATE thread_state SET state={} WHERE thread_id='t'",
        sql_text(&format!(r#"{{"engineSnapshot":9,{}"#, &text[1..]))
    ))
    .unwrap();
    conn.exec(&format!(
        "UPDATE threads SET provider='{provider}' WHERE id='t'"
    ))
    .unwrap();
    // The records a real home carries: each task, the index entry naming it, and the root's
    // agent id → key.
    conn.exec(
        "INSERT INTO engine_state_records VALUES ('t', 'agentKeysById', 'agent-root', '\"root\"')",
    )
    .unwrap();
    for (key, task) in tasks {
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'tasks', {}, {})",
            sql_text(key),
            sql_text(&ace_json::to_string(task))
        ))
        .unwrap();
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'runningTasks', {}, 'true')",
            sql_text(key)
        ))
        .unwrap();
    }
}

/// The task's stored record, as the section keeps it.
fn task_record(conn: &Arc<ace_store::Connection>, key: &str) -> Value {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT value FROM engine_state_records WHERE thread_id='t' AND section='tasks' AND key=?",
        vec![ace_store::Value::Text(key.to_owned())],
    )
    .unwrap()
    .unwrap();
    let text = row
        .get("value")
        .and_then(crate::repository::residency::cell_text)
        .unwrap()
        .to_owned();
    ace_json::parse(&text).unwrap()
}

fn status(conn: &Arc<ace_store::Connection>, key: &str) -> (String, Option<i64>) {
    let task = task_record(conn, key);
    (
        task.get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        task.get("endedAt").and_then(Value::as_i64),
    )
}

fn claude_tasks() -> Vec<(&'static str, Value)> {
    vec![
        (
            "claude:s:p1:unbound:toolu_1",
            task(
                "claude:s:p1:unbound:toolu_1",
                "subagent",
                "Subagent",
                "unknown",
                false,
            ),
        ),
        (
            "claude:s:p1:unbound:overflow",
            task(
                "claude:s:p1:unbound:overflow",
                "other",
                "Unregistered subagent transcripts",
                "unknown",
                true,
            ),
        ),
        (
            "claude:s:p1:task:a1",
            task(
                "claude:s:p1:task:a1",
                "subagent",
                "Fix stale lease",
                "unknown",
                false,
            ),
        ),
        (
            "claude:s:p1:task:b1",
            task(
                "claude:s:p1:task:b1",
                "shell",
                "bun run dev",
                "unknown",
                false,
            ),
        ),
    ]
}

#[test]
fn a_claude_child_placeholder_left_by_a_previous_run_stops_holding_its_thread_after_restart() {
    let conn = home("t", "");
    thread_with(&conn, "claude", &claude_tasks());
    let engine = engine_on(&conn);
    let core = engine.core();
    let snapshot = core
        .with_state(|state| state.repo.require_state(&core.store, "t"))
        .unwrap()
        .unwrap();
    let facts = settle_session_bound_tasks(core, "t", &snapshot).unwrap();
    assert_eq!(facts.len(), 3, "{facts:?}");
    let payload = ace_json::to_string(&Value::Array(facts.into()));
    core.apply("t", &payload, 2.0, None).unwrap();
    for key in [
        "claude:s:p1:unbound:toolu_1",
        "claude:s:p1:unbound:overflow",
        "claude:s:p1:task:a1",
    ] {
        assert_eq!(status(&conn, key), ("stopped".to_owned(), Some(2)), "{key}");
    }
    // A background shell may outlive the CLI: ace still reports it as possibly running.
    assert_eq!(
        status(&conn, "claude:s:p1:task:b1"),
        ("unknown".to_owned(), None)
    );
}

#[test]
fn a_shell_a_done_thread_left_running_reads_as_lost_after_a_restart_not_running_forever() {
    let conn = home("t", "");
    let shells: Vec<String> = (0..9).map(|at| format!("codex:shell:{at}")).collect();
    let tasks: Vec<(&str, Value)> = shells
        .iter()
        .map(|key| {
            (
                key.as_str(),
                task(
                    key,
                    "shell",
                    &format!("bun run job-{key}"),
                    "running",
                    false,
                ),
            )
        })
        .collect();
    thread_with(&conn, "codex", &tasks);
    let engine = engine_on(&conn);
    let core = engine.core();
    let snapshot = core
        .with_state(|state| state.repo.require_state(&core.store, "t"))
        .unwrap()
        .unwrap();
    // Codex has no session-bound work: nothing is stopped, only orphaned.
    assert!(
        settle_session_bound_tasks(core, "t", &snapshot)
            .unwrap()
            .is_empty()
    );
    let state = {
        let borrowed = snapshot.try_borrow().unwrap();
        settle_orphaned_tasks(&borrowed.state)
    };
    assert_eq!(state.len(), 9);
    let payload = ace_json::to_string(&Value::Array(state.into()));
    core.apply("t", &payload, 2.0, None).unwrap();
    for key in &shells {
        assert_eq!(status(&conn, key), ("unknown".to_owned(), Some(2)), "{key}");
    }
    for key in &shells {
        let index = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT 1 AS held FROM engine_state_records WHERE thread_id='t' AND section='runningTasks' AND key=?",
            vec![ace_store::Value::Text(key.clone())],
        )
        .unwrap();
        assert!(
            index.is_none(),
            "a lost shell no longer counts as running: {key}"
        );
    }
}

#[test]
fn only_claude_work_inside_its_process_is_session_bound() {
    assert!(claude_session_bound_task(
        "claude:s:p1:unbound:toolu_1",
        "subagent"
    ));
    assert!(claude_session_bound_task("claude:s:p1:task:a1", "subagent"));
    assert!(!claude_session_bound_task("claude:s:p1:task:b1", "shell"));
    assert!(!claude_session_bound_task("codex:shell:1", "subagent"));
}
