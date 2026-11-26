// SPDX-License-Identifier: Apache-2.0
//! The deadline pass over a real store: which hold fires, what a failing thread costs the ones
//! after it, and what a closed maintenance gate leaves behind.
//!
//! Ported cases: `limit-recovery.process.test.ts:115` ("a reset deadline that fires while history
//! publication holds the store retries instead of crashing") and `:225` ("a deadline this build
//! can't read is put off on its own, and another thread's deadline still fires");
//! `restart-resume.process.test.ts:324` ("a restart continuation waits while maintenance holds new
//! work and goes out when it reopens").

use super::*;
use crate::actor::ActorDeps;
use crate::executor::{Notified, Notifier};
use crate::frames::live::{LiveStore, UnportedLive};
use crate::futures::future::LocalBoxFuture;
use crate::repository::testsupport::{Shell, header, home};
use ace_store::Connection;
use std::rc::Rc;
use std::sync::Arc;

struct ManualPump;

impl Notifier for ManualPump {
    fn notify(&self) -> Notified {
        Notified::Posted
    }
}

struct Turn;

impl crate::executor::Budget for Turn {
    fn start(&mut self) {}
    fn spent(&self, started: usize) -> bool {
        started >= 64
    }
}

/// A live store that reports history publication in progress, as a running publication does.
struct Publishing;

impl LiveStore for Publishing {
    fn writable_now(&self) -> bool {
        false
    }
    fn writable(&self) -> LocalBoxFuture<'static, ()> {
        Box::pin(async {})
    }
    fn history_writing(&self) -> bool {
        true
    }
    fn live_write_blocked(&self) -> bool {
        false
    }
    fn prepare_live_write(&self, _bytes: f64) -> Result<(), EngineError> {
        Ok(())
    }
    fn buffer_live_write(
        &self,
        _thread: &str,
        _events: &[ace_json::Value],
        _at: f64,
        _snapshot: Rc<dyn crate::frames::live::LiveSnapshot>,
    ) -> Result<(), EngineError> {
        Ok(())
    }
    fn run_scheduled(&self) {}
    fn flush_live_writes(&self) {}
    fn is_store_retry(&self, _error: &EngineError) -> bool {
        false
    }
}

fn engine_with(conn: &Arc<Connection>, live: Rc<dyn LiveStore>) -> (crate::Engine, Rc<Shell>) {
    let (_, shell) = Shell::store_with_controls(conn);
    let engine = crate::Engine::new(
        shell.clone(),
        shell.clone(),
        crate::Inputs::default(),
        "[]",
        Box::new(ManualPump),
        conn,
        Rc::new(ActorDeps::production(live, 0.0)),
    )
    .unwrap();
    // The E5.1 seam: unported collaborators answer their probe value, as the engine's own tests
    // drive every fold through the probe gate until each item lands.
    engine
        .core()
        .with_state(|state| state.repo.probe_passthrough = true)
        .unwrap();
    (engine, shell)
}

fn engine_on(conn: &Arc<Connection>) -> (crate::Engine, Rc<Shell>) {
    engine_with(conn, Rc::new(UnportedLive))
}

fn settle(engine: &crate::Engine) {
    for _ in 0..8 {
        let mut budget = Turn;
        engine.pump(&mut budget);
    }
}

fn armed(engine: &crate::Engine) -> u64 {
    engine
        .core()
        .with_state(|state| state.recovery.cancel)
        .unwrap()
        .expect("a deadline is armed")
}

fn engine_commands(conn: &Arc<Connection>) -> i64 {
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

fn resume_at(conn: &Arc<Connection>, thread: &str) -> ace_store::Value {
    let row = ace_store::stmt_cache::get_row(
        conn,
        "SELECT resume_at, timer_action FROM engine_queue WHERE thread_id=?",
        vec![ace_store::Value::Text(thread.to_owned())],
    )
    .unwrap()
    .unwrap();
    row.get("resume_at")
        .cloned()
        .unwrap_or(ace_store::Value::Null)
}

fn another_thread(conn: &Arc<Connection>, thread: &str) {
    conn.exec(&format!(
        "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at) \
         VALUES ('{thread}', 'workspace', 'Bad', 'claude', '{{\"state\":\"new\"}}', 0, 0)"
    ))
    .unwrap();
    conn.exec(&format!(
        "INSERT INTO thread_state VALUES ('{thread}', {}, 0)",
        crate::repository::testsupport::sql_text(&header(thread))
    ))
    .unwrap();
}

#[test]
fn a_deadline_that_fires_while_history_publication_holds_the_store_is_retried_not_skipped() {
    let conn = home("t", &header("t"));
    conn.exec("INSERT INTO engine_queue (thread_id, resume_at) VALUES ('t', 0)")
        .unwrap();
    let (engine, shell) = engine_with(&conn, Rc::new(Publishing));
    let core = engine.core();
    crate::queue::holds::schedule(core).unwrap();
    settle(&engine);
    let key = armed(&engine);
    shell.fire(key);
    settle(&engine);
    // The pass reported the publication and put its due deadlines back; nothing was consumed.
    assert!(
        shell
            .reports()
            .iter()
            .any(|report| report == "History publication in progress"),
        "{:?}",
        shell.reports()
    );
    assert_eq!(
        resume_at(&conn, "t"),
        ace_store::Value::Integer(0),
        "{:?}",
        shell.reports()
    );
    assert_eq!(engine_commands(&conn), 0);
    assert!(
        core.with_state(|state| state.recovery.cancel.is_some())
            .unwrap(),
        "the retry is armed"
    );
}

#[test]
fn a_deadline_that_cannot_be_read_is_put_off_and_the_next_threads_deadline_still_fires() {
    let conn = home("t", &header("t"));
    another_thread(&conn, "bad");
    // A record this build can't read: the reason is not one the queue defines.
    conn.exec("INSERT INTO engine_queue (thread_id, resume_at, reason) VALUES ('bad', 0, 'bogus')")
        .unwrap();
    conn.exec("INSERT INTO engine_queue (thread_id, resume_at) VALUES ('t', 0)")
        .unwrap();
    let (engine, shell) = engine_on(&conn);
    crate::queue::holds::schedule(engine.core()).unwrap();
    settle(&engine);
    let key = armed(&engine);
    shell.fire(key);
    settle(&engine);
    // The unreadable thread's deadline moves a second on, with a report naming it, and the
    // thread after it still resumes.
    assert_eq!(resume_at(&conn, "bad"), ace_store::Value::Integer(1_000));
    assert!(
        shell
            .reports()
            .iter()
            .any(|report| report == "Thread bad's deadline failed; tried again in 1000 ms"),
        "{:?}",
        shell.reports()
    );
    assert_eq!(engine_commands(&conn), 1);
    let deferred = engine
        .core()
        .with_state(|state| state.recovery.deferrals.get("bad").cloned())
        .unwrap()
        .expect("the deferral is kept");
    assert_eq!(deferred.delay, 1_000.0);
}

#[test]
fn a_restart_continuation_waits_while_maintenance_holds_new_work_and_goes_when_it_reopens() {
    let conn = home("t", &header("t"));
    conn.exec(
        "INSERT INTO engine_queue (thread_id, resume_at, paused, reason, continuation, trigger, hold_token)
         VALUES ('t', 0, 1, 'restart', 'Continue where you left off.', 'restart', 3)",
    )
    .unwrap();
    let (engine, shell) = engine_on(&conn);
    crate::queue::holds::schedule(engine.core()).unwrap();
    settle(&engine);
    let key = armed(&engine);
    // Maintenance closes after the deadline was armed, before it fires.
    shell.answer_admits(Some(false));
    shell.fire(key);
    settle(&engine);
    // The gate kept the due deadline on the queue, as a resume for when it reopens.
    assert_eq!(
        resume_at(&conn, "t"),
        ace_store::Value::Integer(0),
        "{:?}",
        shell.reports()
    );
    assert_eq!(engine_commands(&conn), 0);
    let row = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT timer_action FROM engine_queue WHERE thread_id='t'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        row.get("timer_action")
            .and_then(crate::repository::residency::cell_text),
        Some("resume")
    );
    // No deadline runs while the gate holds new work, so nothing is armed yet.
    assert!(
        engine
            .core()
            .with_state(|state| state.recovery.cancel.is_none())
            .unwrap()
    );
    // Reopening schedules again, and the continuation goes out once.
    shell.answer_admits(None);
    crate::queue::holds::schedule(engine.core()).unwrap();
    settle(&engine);
    let reopened = armed(&engine);
    shell.fire(reopened);
    settle(&engine);
    assert_eq!(engine_commands(&conn), 1);
}

#[test]
fn an_automatic_resume_with_no_capacity_waits_a_second_and_tries_again() {
    let conn = home("t", &header("t"));
    conn.exec("INSERT INTO engine_queue (thread_id, resume_at) VALUES ('t', 0)")
        .unwrap();
    // Every warm-session slot is taken, and nothing may reclaim one.
    for index in 0..64 {
        conn.exec(&format!("INSERT INTO engine_slots VALUES ('slot-{index}')"))
            .unwrap();
    }
    let (engine, shell) = engine_on(&conn);
    crate::queue::holds::schedule(engine.core()).unwrap();
    settle(&engine);
    let key = armed(&engine);
    shell.fire(key);
    settle(&engine);
    assert_eq!(engine_commands(&conn), 1);
    let receipt = ace_store::stmt_cache::get_row(
        &conn,
        "SELECT result FROM command_receipts WHERE device_id='engine'",
        Vec::new(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        receipt
            .get("result")
            .and_then(crate::repository::residency::cell_text),
        Some(r#"{"commandId":"command","ok":false,"error":"engine_capacity_exceeded"}"#)
    );
    assert_eq!(resume_at(&conn, "t"), ace_store::Value::Integer(1_000));
}
