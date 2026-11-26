// SPDX-License-Identifier: Apache-2.0
//! The live-work reads' cases: an operation counts while its thread may still run, a finished
//! thread counts nothing, and attention keeps a thread unfinished.

use super::*;
use crate::executor::{Notified, Notifier};
use crate::repository::testsupport::{Shell, header, home};
use std::rc::Rc;
use std::sync::Arc;

struct Pump;

impl Notifier for Pump {
    fn notify(&self) -> Notified {
        Notified::Posted
    }
}

struct Home {
    engine: crate::Engine,
    shell: Rc<Shell>,
    conn: Arc<ace_store::Connection>,
}

impl Home {
    fn new(queue: &str) -> Home {
        let conn = home("t", &header("t"));
        let (_, shell) = Shell::store_with_controls(&conn);
        let engine = crate::Engine::new(
            shell.clone(),
            shell.clone(),
            crate::Inputs::default(),
            "[]",
            Box::new(Pump),
            &conn,
            Rc::new(crate::actor::ActorDeps::production(
                Rc::new(crate::frames::live::UnportedLive),
                0.0,
            )),
        )
        .expect("engine");
        conn.exec(queue).expect("queue");
        shell.set_thread(
            "t",
            r#"{"id":"t","provider":"codex","status":{"state":"done"}}"#.to_owned(),
        );
        Home {
            engine,
            shell,
            conn,
        }
    }

    fn core(&self) -> &Rc<crate::Core> {
        self.engine.core()
    }

    fn exec(&self, sql: &str) -> &Home {
        self.conn.exec(sql).expect("seed");
        self
    }

    fn live(&self) -> LiveWork {
        let core = self.core();
        core.with_state(|state| live(core, state, "t", &|_| false))
            .unwrap()
            .unwrap()
    }

    fn active(&self) -> bool {
        let core = self.core();
        core.with_state(|state| active(core, state, "t"))
            .unwrap()
            .unwrap()
    }

    fn unfinished(&self) -> bool {
        let core = self.core();
        core.with_state(|state| unfinished(core, state, "t"))
            .unwrap()
            .unwrap()
    }
}

#[test]
fn a_queued_send_counts_as_an_operation_and_a_paused_queue_does_not() {
    let home = Home::new("INSERT INTO engine_queue (thread_id) VALUES ('t')");
    home.exec(
        "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) \
         VALUES ('send','t','thread.send','{}','pending','queue',1)",
    );
    assert_eq!(home.live().operations_running, 1);
    assert_eq!(home.live().agents_running, 0, "no session is attached");

    let paused =
        Home::new("INSERT INTO engine_queue (thread_id, paused, reason) VALUES ('t', 1, 'manual')");
    paused.exec(
        "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) \
         VALUES ('send','t','thread.send','{}','pending','queue',1)",
    );
    assert_eq!(paused.live().operations_running, 0);
}

#[test]
fn a_running_intent_or_an_opening_session_counts_even_on_a_held_queue() {
    let home =
        Home::new("INSERT INTO engine_queue (thread_id, paused, reason) VALUES ('t', 1, 'manual')");
    home.exec(
        "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) \
         VALUES ('send','t','thread.send','{}','running','queue',1)",
    );
    assert_eq!(home.live().operations_running, 1);
}

#[test]
fn work_in_the_state_is_active_and_an_idle_thread_is_not() {
    let home = Home::new("INSERT INTO engine_queue (thread_id) VALUES ('t')");
    assert!(!home.active());
    // A background task running is work, whatever the run says.
    // A running task is a section row (`load_indexes`), as the opener writes it.
    home.exec(
        "INSERT INTO engine_state_records VALUES ('t', 'runningTasks', 'task', 'true'); UPDATE thread_state SET seq = seq + 1 WHERE thread_id='t'",
    );
    assert!(home.active());
}

#[test]
fn a_thread_needing_the_person_is_unfinished_and_a_done_one_with_nothing_queued_is_not() {
    let home = Home::new(
        "INSERT INTO engine_queue (thread_id, paused, reason) VALUES ('t', 1, 'not_sent')",
    );
    assert!(home.unfinished());
    let clean = Home::new("INSERT INTO engine_queue (thread_id) VALUES ('t')");
    assert!(!clean.unfinished());
    // A thread that is not done yet is unfinished even with nothing queued.
    clean.shell.set_thread(
        "t",
        r#"{"id":"t","provider":"codex","status":{"state":"working","agents":1}}"#.to_owned(),
    );
    assert!(clean.unfinished());
}
