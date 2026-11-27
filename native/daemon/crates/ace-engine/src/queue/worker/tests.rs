// SPDX-License-Identifier: Apache-2.0
//! One pass of the sends lane (`index.ts:1300`-`:1384`): a held queue never dispatches, a
//! runnable send reaches E5.5's delivery stub once, and a moving thread takes no work here.

use super::*;
use crate::actor::{ActorDeps, ActorInstance};
use crate::executor::{Notified, Notifier};
use crate::frames::live::UnportedLive;
use crate::repository::testsupport::{Shell, header, home};
use std::sync::Arc;

struct ManualPump;

impl Notifier for ManualPump {
    fn notify(&self) -> Notified {
        Notified::Posted
    }
}

struct Pass {
    engine: crate::Engine,
    conn: Arc<ace_store::Connection>,
}

impl Pass {
    /// A thread with state, a session row and a queue row, and its actor at rest.
    fn new(queue: &str, extra_thread_state: &str) -> Pass {
        let conn = home("t", &header_with(extra_thread_state));
        let (_, shell) = Shell::store_with_controls(&conn);
        let engine = crate::Engine::new(
            shell.clone(),
            shell.clone(),
            crate::Inputs::default(),
            "[]",
            Box::new(ManualPump),
            &conn,
            Rc::new(ActorDeps::production(Rc::new(UnportedLive), 0.0)),
        )
        .expect("engine");
        conn.exec(
            "INSERT OR REPLACE INTO engine_sessions (thread_id, cwd, backend) VALUES ('t', '/tmp', NULL)",
        )
        .expect("session");
        conn.exec(queue).expect("queue");
        let pass = Pass { engine, conn };
        pass.core()
            .with_state(|state| {
                state.actors.by_thread.insert(
                    "t".to_owned(),
                    Rc::new(std::cell::RefCell::new(ActorInstance::new(
                        "t".to_owned(),
                        0,
                    ))),
                );
                // E5.7's obsolete-interaction check is not ported; the seam's pass-through
                // answers it, so a pass that folds queue facts can be tested now.
                state.repo.probe_passthrough = true;
            })
            .unwrap();
        pass
    }

    fn core(&self) -> &Rc<crate::Core> {
        self.engine.core()
    }

    fn exec(&self, sql: &str) -> &Pass {
        self.conn.exec(sql).expect("seed");
        self
    }

    fn status(&self, command: &str) -> Option<String> {
        let row = ace_store::stmt_cache::get_row(
            &self.conn,
            "SELECT status AS value FROM intents WHERE command_id=?",
            vec![ace_store::Value::Text(command.to_owned())],
        )
        .expect("row");
        row.and_then(|row| {
            row.get("value")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
        })
    }

    fn pass(&self) -> Result<(), EngineError> {
        futures::executor::block_on(work(Rc::clone(self.core()), "t".to_owned()))
    }
}

/// The header with extra root fields, so a pass sees the agent it needs.
fn header_with(extra: &str) -> String {
    let header = header("t");
    if extra.is_empty() {
        return header;
    }
    header.replace("\"agents\":{}", &format!("\"agents\":{extra}"))
}

fn queued_send(command: &str, text: &str) -> String {
    format!(
        "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) \
         VALUES ('{command}','t','thread.send','{{\"id\":\"{command}\",\"deviceId\":\"device\",\"payload\":{{\"type\":\"thread.send\",\"threadId\":\"t\",\"input\":[{{\"type\":\"text\",\"text\":\"{text}\"}}]}}}}','pending','queue',1)"
    )
}

#[test]
fn a_send_on_a_held_queue_is_never_dispatched() {
    let pass = Pass::new(
        "INSERT INTO engine_queue (thread_id, paused, reason) VALUES ('t', 1, 'manual')",
        "",
    );
    pass.exec(&queued_send("held", "hello"));
    pass.pass().expect("a held pass is not an error");
    // It stays where it was: not claimed, not marked, not failed.
    assert_eq!(pass.status("held").as_deref(), Some("pending"));
    let queue = crate::queue::store::get(&pass.core().store, "t").expect("queue");
    assert!(queue.paused);
    assert_eq!(queue.revision, 0, "a held pass changes nothing");
}

#[test]
fn a_runnable_send_reaches_delivery_which_reports_e5_5() {
    let pass = Pass::new("INSERT INTO engine_queue (thread_id) VALUES ('t')", "");
    pass.exec(&queued_send("runnable", "hello"));
    let error = pass.pass().expect_err("delivery is E5.5's");
    assert!(error.to_string().contains("E5.5"), "{error}");
    // Claimed for the pass, and left to delivery's claim.
    assert_eq!(pass.status("runnable").as_deref(), Some("queued"));
}

#[test]
fn a_moving_thread_takes_no_new_work_here() {
    let pass = Pass::new("INSERT INTO engine_queue (thread_id) VALUES ('t')", "");
    pass.exec(&queued_send("moving", "hello"));
    pass.exec(
        "INSERT INTO thread_ownership (thread_id, state, transfer_id, peer, epoch, at) VALUES ('t', 'moved', 'transfer', '{}', 1, 0)",
    );
    pass.pass().expect("a fenced pass is not an error");
    assert_eq!(pass.status("moving").as_deref(), Some("pending"));
}

#[test]
fn a_cursor_reconcile_leaves_an_admitted_send_pending_until_the_hold_releases() {
    let pass = Pass::new("INSERT INTO engine_queue (thread_id) VALUES ('t')", "");
    pass.exec(&queued_send("behind-reconcile", "hello"));
    pass.core()
        .with_state(|state| crate::cursor_reconcile::mark(state, "t"))
        .unwrap();
    let held = pass.pass();
    assert!(held.is_ok(), "{held:?}");
    assert_eq!(pass.status("behind-reconcile").as_deref(), Some("pending"));
    pass.core()
        .with_state(|state| crate::cursor_reconcile::release(state, "t"))
        .unwrap();
    let _ = pass.pass();
    assert_eq!(pass.status("behind-reconcile").as_deref(), Some("queued"));
}

/// A stored intent of any kind, as the TypeScript engine writes it.
fn intent(kind: &str, delivery: &str, position: i64, extra: &str) -> String {
    format!(
        "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position{}) \
         VALUES ('{kind}','t','{kind}','{{}}','pending','{delivery}',{position}{})",
        if extra.is_empty() {
            String::new()
        } else {
            ",awaiting".to_owned()
        },
        if extra.is_empty() {
            String::new()
        } else {
            format!(",{extra}")
        }
    )
}

#[test]
fn a_thread_with_nothing_to_run_releases_its_actor_and_slot() {
    let pass = Pass::new("INSERT INTO engine_queue (thread_id) VALUES ('t')", "");
    pass.exec("INSERT INTO engine_slots VALUES ('t')");
    pass.pass().expect("an empty pass is not an error");
    // No session, no work, no hold: the actor goes and its slot with it.
    assert!(
        !pass
            .core()
            .with_state(|state| state.repo.reserved_slot(&pass.core().store, "t"))
            .unwrap()
            .unwrap()
    );
    assert!(
        !pass
            .core()
            .with_state(|state| state.actors.by_thread.contains_key("t"))
            .unwrap()
    );
}

#[test]
fn an_awaiting_input_holds_the_next_send() {
    let pass = Pass::new("INSERT INTO engine_queue (thread_id) VALUES ('t')", "");
    // The provider has the thread's input and has not acknowledged it: nothing else goes.
    pass.exec(&intent("thread.send", "queue", 1, "1"));
    pass.exec(&queued_send("next", "later"));
    pass.pass().expect("an awaiting thread is not an error");
    assert_eq!(pass.status("next").as_deref(), Some("pending"));
}

#[test]
fn a_recovery_intent_runs_even_when_the_queue_is_paused() {
    let pass = Pass::new(
        "INSERT INTO engine_queue (thread_id, paused, reason) VALUES ('t', 1, 'manual')",
        "",
    );
    pass.exec(&intent("thread.resume", "queue", 1, ""));
    let error = pass.pass().expect_err("delivery is E5.5's");
    assert!(error.to_string().contains("E5.5"), "{error}");
}

#[test]
fn a_transition_intent_runs_before_a_waiting_message() {
    let pass = Pass::new("INSERT INTO engine_queue (thread_id) VALUES ('t')", "");
    pass.exec(&intent("thread.switch", "queue", 1, ""));
    pass.exec(&queued_send("after", "hello"));
    let error = pass.pass().expect_err("delivery is E5.5's");
    assert!(error.to_string().contains("E5.5"), "{error}");
    // The message was never marked for delivery.
    assert_eq!(pass.status("after").as_deref(), Some("pending"));
}

#[test]
fn a_committed_send_runs_a_worker_for_a_reserved_thread_without_an_actor() {
    let conn = home("t", &header("t"));
    let (_, shell) = Shell::store_with_controls(&conn);
    let engine = crate::Engine::new(
        shell.clone(), shell.clone(), crate::Inputs::default(),
        r#"[{"provider":"claude","adapter":1,"capabilities":{"steer":false,"childControls":"full"},"discovery":{},"current":true}]"#,
        Box::new(ManualPump), &conn, Rc::new(ActorDeps::production(Rc::new(UnportedLive), 0.0)),
    ).unwrap();
    struct Turn;
    impl crate::executor::Budget for Turn {
        fn start(&mut self) {}
        fn spent(&self, started: usize) -> bool {
            started >= 64
        }
    }
    for _ in 0..8 {
        engine.pump(&mut Turn);
    }
    assert!(engine.is_ready(), "{:?}", shell.reports());
    let core = engine.core();
    core.with_state(|state| state.repo.probe_passthrough = true)
        .unwrap();
    let command = ace_json::parse(
        r#"{"id":"wake-worker","deviceId":"device","payload":{"type":"thread.send","threadId":"t","input":[{"type":"text","text":"hello"}]}}"#,
    ).unwrap();
    let accepted = core
        .store
        .atomic(|_| {
            core.with_state(|state| crate::commands::prelude::handle(core, state, &command))?
        })
        .unwrap()
        .unwrap();
    assert_eq!(
        accepted.get("ok").and_then(Value::as_bool),
        Some(true),
        "{accepted}"
    );
    assert_eq!(
        crate::intents::store::command_status(&conn, "wake-worker")
            .unwrap()
            .as_deref(),
        Some("pending")
    );
    core.release_after_commit();
    for _ in 0..8 {
        engine.pump(&mut Turn);
    }
    assert_eq!(
        crate::intents::store::command_status(&conn, "wake-worker")
            .unwrap()
            .as_deref(),
        Some("queued"),
        "{:?}",
        shell.reports()
    );
}
