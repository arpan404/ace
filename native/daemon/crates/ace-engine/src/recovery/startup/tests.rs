// SPDX-License-Identifier: Apache-2.0
//! Startup's decisions over a real store: a cut-off turn continues once, a question holds it, a
//! turn the provider finished is never continued, and unverified processes are never started
//! again.
//!
//! Ported cases: `restart-resume.process.test.ts:94` ("a turn a crash cut short continues by itself
//! with one restart continuation"), `:345` ("a turn waiting on the person's answer doesn't resume
//! after a graceful restart"), `:384` ("a turn that finishes while ace shuts its provider down isn't
//! continued after the restart"), `:453` (a resumed thread keeps its next message), and
//! `restart-unverified.process.test.ts` (a previous run's processes that can't be proven gone are
//! never started again).

use super::*;
use crate::repository::testsupport::{Shell, home, sql_text};
use ace_core::state::CoreConfig;
use std::rc::Rc;
use std::sync::Arc;

fn engine_on(conn: &Arc<ace_store::Connection>) -> (crate::Engine, Rc<Shell>) {
    struct ManualPump;
    impl crate::executor::Notifier for ManualPump {
        fn notify(&self) -> crate::executor::Notified {
            crate::executor::Notified::Posted
        }
    }
    let (_, shell) = Shell::store_with_controls(conn);
    let engine = crate::Engine::new(
        shell.clone(),
        shell.clone(),
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
    crate::restart::ensure_ledgers(conn).unwrap();
    (engine, shell)
}

/// A stored thread mid-turn: a live root run, its provider session, and waiting for a restart.
fn live_thread(conn: &Arc<ace_store::Connection>, question: bool) {
    let mut state = ace_core::state::create_thread_state(
        "t".to_owned(),
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
        &ace_json::parse(r#"{"agent":{"id":"agent-root","threadId":"t","parentId":null,"origin":"person","native":{"provider":"codex","nativeId":"native-root"},"fidelity":"full","cwd":"/tmp","status":{"state":"working","activity":"thinking"},"createdAt":0},"activity":"working","lastSignalAt":0,"activeRun":"run-1"}"#).unwrap(),
    )
    .unwrap();
    state.agents.insert("root".to_owned(), record);
    state
        .indexes
        .agent_keys_by_id
        .insert("agent-root".to_owned(), "root".to_owned());
    state.runs.insert(
        "run-1".to_owned(),
        ace_json::from_value(
            &ace_json::parse(r#"{"id":"run-1","threadId":"t","agentId":"root","trigger":"user","seq":1,"state":"active","startedAt":1}"#).unwrap(),
        )
        .unwrap(),
    );
    let text = ace_json::ser::to_string(&state).unwrap();
    conn.exec(&format!(
        "UPDATE thread_state SET state={} WHERE thread_id='t'",
        sql_text(&format!(r#"{{"engineSnapshot":9,{}"#, &text[1..]))
    ))
    .unwrap();
    // The thread a crash left mid-turn reads working, so the startup scan sees it.
    conn.exec(r#"UPDATE threads SET status='{"state":"working"}' WHERE id='t'"#)
        .unwrap();
    conn.exec(
        "INSERT OR REPLACE INTO engine_sessions (thread_id, cwd, native_session_id) VALUES ('t', '/tmp', 'native-1')",
    )
    .unwrap();
    if question {
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t','interactions','ask-1',{})",
            sql_text(
                r#"{"id":"ask-1","threadId":"t","agentId":"agent-root","blocking":true,"request":{"kind":"question","questions":[{"id":"q1","text":"Which branch?","options":[],"multiSelect":false,"allowOther":false,"secret":false}]},"state":"pending","createdAt":1,"raw":[]}"#
            )
        ))
        .unwrap();
        conn.exec(
            "INSERT INTO engine_state_records VALUES ('t','pendingInteractions','ask-1','true')",
        )
        .unwrap();
    }
}

fn contains_agent_key(conn: &Arc<ace_store::Connection>) -> bool {
    ace_store::stmt_cache::get_row(
        conn,
        "SELECT 1 AS found FROM engine_state_records WHERE thread_id='t' AND section='agentKeysById'",
        Vec::new(),
    )
    .unwrap()
    .is_some()
}

fn setup(conn: &Arc<ace_store::Connection>, question: bool) {
    live_thread(conn, question);
    // The agent's id → key record, as a real home carries it.
    conn.exec(
        "INSERT INTO engine_state_records VALUES ('t','agentKeysById','agent-root','\"root\"')",
    )
    .unwrap();
}

fn run(engine: &crate::Engine) {
    futures::executor::block_on(super::run(engine.core())).unwrap();
}

fn queue(conn: &Arc<ace_store::Connection>, name: &str) -> Option<String> {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT continuation, trigger, paused, reason FROM engine_queue WHERE thread_id='t'",
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
                .map(|value| value.to_string())
        })
}

fn resume_intents(conn: &Arc<ace_store::Connection>) -> i64 {
    ace_store::stmt_cache::get_row(
        conn,
        "SELECT COUNT(*) AS n FROM intents WHERE thread_id='t' AND kind IN ('thread.resume','queue.resume','thread.limit')",
        Vec::new(),
    )
    .unwrap()
    .and_then(|row| row.get("n").and_then(crate::repository::residency::cell_int))
    .unwrap_or(0)
}

fn notice(conn: &Arc<ace_store::Connection>) -> Option<Value> {
    let rows = ace_store::stmt_cache::all_rows(
        conn,
        "SELECT value FROM engine_state_records WHERE thread_id='t' AND section='items'",
        Vec::new(),
    )
    .unwrap();
    rows.iter().find_map(|row| {
        let text = row
            .get("value")
            .and_then(crate::repository::residency::cell_text)?;
        let item = ace_json::parse(text).ok()?;
        (item.get("type").and_then(Value::as_str) == Some("notice")).then_some(item)
    })
}

#[test]
fn a_turn_a_crash_cut_short_continues_by_itself_with_one_restart_continuation() {
    let conn = home("t", &crate::repository::testsupport::header("t"));
    setup(&conn, false);
    let (engine, _) = engine_on(&conn);
    run(&engine);
    let continuation = queue(&conn, "continuation").expect("a continuation");
    assert!(continuation.starts_with("ace restarted while you were working"));
    assert_eq!(queue(&conn, "trigger").as_deref(), Some("restart"));
    assert_eq!(resume_intents(&conn), 1);
    assert_eq!(crate::restart::streak(&conn, "t").unwrap(), 1);
    let notice = notice(&conn).expect("an interruption notice");
    assert_eq!(
        notice.get("code").and_then(Value::as_str),
        Some("restart_interrupted")
    );
    assert_eq!(
        notice.get("text").and_then(Value::as_str),
        Some("Interrupted by a restart. Continuing.")
    );
}

#[test]
fn a_turn_waiting_on_the_persons_answer_does_not_resume_after_a_graceful_restart() {
    let conn = home("t", &crate::repository::testsupport::header("t"));
    setup(&conn, true);
    let (engine, _) = engine_on(&conn);
    run(&engine);
    assert_eq!(resume_intents(&conn), 0);
    assert_eq!(queue(&conn, "paused").as_deref(), Some("1"));
    assert_eq!(queue(&conn, "reason").as_deref(), Some("restart"));
    let notice = notice(&conn).expect("an interruption notice");
    assert_eq!(
        notice.get("text").and_then(Value::as_str),
        Some(
            "Interrupted by a restart while waiting for your answer to \"Which branch?\". Continue and the agent asks again."
        )
    );
}

#[test]
fn a_turn_that_finished_while_ace_shut_its_provider_down_is_not_continued_after_the_restart() {
    let conn = home("t", &crate::repository::testsupport::header("t"));
    // A graceful close captured the continuation, then the provider finished the turn: the stored
    // state has no run and no live work.
    conn.exec(
        "INSERT INTO engine_queue (thread_id, paused, reason, continuation, trigger, hold_token)
         VALUES ('t', 1, 'restart', 'Continue where you left off.', 'restart', 2)",
    )
    .unwrap();
    conn.exec("INSERT OR REPLACE INTO engine_sessions (thread_id, cwd) VALUES ('t', '/tmp')")
        .unwrap();
    let (engine, _) = engine_on(&conn);
    run(&engine);
    assert_eq!(queue(&conn, "continuation"), None);
    assert_eq!(queue(&conn, "trigger"), None);
    assert_eq!(resume_intents(&conn), 0);
}

#[test]
fn processes_that_cannot_be_proven_gone_are_never_started_again() {
    let conn = home("t", &crate::repository::testsupport::header("t"));
    setup(&conn, false);
    let (engine, shell) = engine_on(&conn);
    shell.unverified_processes(true);
    run(&engine);
    // The turn is left alone, the queue held, and the person told why.
    assert_eq!(resume_intents(&conn), 0);
    assert!(queue(&conn, "continuation").is_some());
    assert!(contains_agent_key(&conn));
    let rows = ace_store::stmt_cache::all_rows(
        &conn,
        "SELECT value FROM engine_state_records WHERE thread_id='t' AND section='items'",
        Vec::new(),
    )
    .unwrap();
    assert!(rows.iter().any(|row| {
        let item = row
            .get("value")
            .and_then(crate::repository::residency::cell_text)
            .and_then(|text| ace_json::parse(text).ok());
        item.and_then(|item| item.get("text").and_then(Value::as_str).map(str::to_owned))
            == Some("Some processes from the previous run may still be running".to_owned())
    }));
}

#[test]
fn a_reopened_engine_repairs_a_done_parent_when_its_child_is_waiting_on_a_question() {
    use crate::repository::testsupport::header;
    let conn = home("t", &header("t"));
    setup(&conn, true);
    conn.exec(&format!(
        r#"UPDATE threads SET status='{{"state":"needs_you","interactions":1}}' WHERE id='t';
        INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at)
          VALUES ('parent', 'workspace', 'Parent', 'codex', '{{"state":"done"}}', 0, 0);
        INSERT INTO thread_state VALUES ('parent', {}, 0);
        INSERT INTO engine_sessions (thread_id,cwd) VALUES ('parent','/tmp');
        INSERT INTO engine_permissions (thread_id,parent) VALUES ('t','parent');
        INSERT INTO engine_state_records VALUES ('parent','agents','ace-child:t',
          '{{"agent":{{"id":"summary","threadId":"parent","parentId":null,"origin":"ace","native":{{"provider":"codex"}},"status":{{"state":"idle"}},"fidelity":"summary","cwd":"/tmp","background":false,"createdAt":1,"childThreadId":"t"}},"activity":"idle","lastSignalAt":1,"externalStatus":{{"state":"done"}}}}');"#,
        sql_text(&header("parent"))
    ))
    .unwrap();
    let conn = reopen(conn);
    pump_ready(&conn);
    let row = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT json_extract(value,'$.externalStatus.state') AS status
         FROM engine_state_records WHERE thread_id='parent' AND section='agents' AND key='ace-child:t'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        row.get("status")
            .and_then(crate::repository::residency::cell_text),
        Some("needs_you")
    );
}

fn reopen(conn: Arc<ace_store::Connection>) -> Arc<ace_store::Connection> {
    let database = ace_store::stmt_cache::get_row(&conn, "PRAGMA database_list", Vec::new())
        .unwrap()
        .unwrap();
    let path = database
        .get("file")
        .and_then(crate::repository::residency::cell_text)
        .unwrap()
        .to_owned();
    drop(conn);
    ace_store::Connection::open(
        &path,
        ace_store::OpenOptions {
            read_only: false,
            timeout_ms: 1000,
        },
    )
    .unwrap()
}

fn pump_ready(conn: &Arc<ace_store::Connection>) -> Vec<String> {
    let (engine, shell) = engine_on(conn);
    struct Budget;
    impl crate::executor::Budget for Budget {
        fn start(&mut self) {}
        fn spent(&self, started: usize) -> bool {
            started >= 64
        }
    }
    for _ in 0..256 {
        engine.pump(&mut Budget);
        if engine.is_ready() {
            break;
        }
    }
    assert!(engine.is_ready(), "{:?}", shell.reports());
    shell.reports()
}

#[test]
fn reopening_a_settled_tree_cancels_a_childs_request_and_holds_its_queued_send() {
    use crate::repository::testsupport::header;
    let conn = home("t", &header("t"));
    setup(&conn, true);
    conn.exec(&format!(
        r#"INSERT INTO threads (id, workspace_id, title, provider, status, client, created_at, updated_at)
          VALUES ('parent', 'workspace', 'Parent', 'codex', '{{"state":"done"}}', '{{"settledAt":5}}', 0, 0);
        INSERT INTO thread_state VALUES ('parent', {}, 0);
        INSERT INTO engine_sessions (thread_id,cwd) VALUES ('parent','/tmp');
        INSERT INTO engine_permissions (thread_id,parent) VALUES ('t','parent');
        INSERT INTO engine_state_records VALUES ('parent','agents','ace-child:t',
          '{{"agent":{{"id":"summary","threadId":"parent","parentId":null,"origin":"ace","native":{{"provider":"codex"}},"status":{{"state":"idle"}},"fidelity":"summary","cwd":"/tmp","background":false,"createdAt":1,"childThreadId":"t"}},"activity":"idle","lastSignalAt":1,"externalStatus":{{"state":"done"}}}}');
        INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position)
          VALUES ('next','t','thread.send','{{}}','pending','queue',1);"#,
        sql_text(&header("parent"))
    ))
    .unwrap();
    let conn = reopen(conn);
    pump_ready(&conn);
    let row = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT json_extract(value,'$.state') AS state FROM engine_state_records
         WHERE thread_id='t' AND section IN ('interactions','interactionHistory') AND key='ask-1'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        row.get("state")
            .and_then(crate::repository::residency::cell_text),
        Some("cancelled")
    );
    assert_eq!(queue(&conn, "reason").as_deref(), Some("stopped"));
    assert_eq!(
        crate::intents::store::command_status(&conn, "next")
            .unwrap()
            .as_deref(),
        Some("pending")
    );
}

#[test]
fn a_restart_retries_a_resume_whose_intent_did_not_commit() {
    let conn = home("t", &crate::repository::testsupport::header("t"));
    setup(&conn, false);
    conn.exec(
        "CREATE TRIGGER fail_resume BEFORE INSERT ON intents WHEN NEW.kind='thread.resume'
         BEGIN SELECT RAISE(ABORT, 'restart resume write failed'); END",
    )
    .unwrap();
    pump_ready(&conn);
    assert_eq!(resume_intents(&conn), 0);
    assert_eq!(crate::restart::streak(&conn, "t").unwrap(), 0);
    assert!(crate::restart::has_capture(&conn, "t").unwrap());
    assert_ne!(
        notice(&conn)
            .as_ref()
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str),
        Some("Interrupted by a restart. Continuing.")
    );

    let conn = reopen(conn);
    conn.exec("DROP TRIGGER fail_resume").unwrap();
    pump_ready(&conn);
    assert_eq!(resume_intents(&conn), 1);
    assert_eq!(crate::restart::streak(&conn, "t").unwrap(), 1);
    assert!(!crate::restart::has_capture(&conn, "t").unwrap());
}

#[test]
fn a_corrupt_outstanding_intent_is_reported_and_later_intents_still_recover() {
    let conn = home("t", &crate::repository::testsupport::header("t"));
    conn.exec(
        "INSERT INTO intents(id,command_id,thread_id,kind,payload,status,delivery)
         VALUES (41,'unreadable','t','thread.interrupt','{}','running','unrecognized'),
                (42,'later','t','thread.interrupt','{}','running','queue')",
    )
    .unwrap();
    let conn = reopen(conn);
    let reports = pump_ready(&conn);
    assert_eq!(
        crate::intents::store::command_status(&conn, "later")
            .unwrap()
            .as_deref(),
        Some("failed")
    );
    assert_eq!(
        crate::intents::store::command_status(&conn, "unreadable")
            .unwrap()
            .as_deref(),
        Some("running")
    );
    assert!(
        reports
            .iter()
            .any(|report| report.contains("intent 41") && report.contains("delivery")),
        "{reports:?}"
    );
}
