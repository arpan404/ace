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
        engine
            .core()
            .with_state(|state| {
                state.actors.by_thread.insert(
                    "t".to_owned(),
                    crate::actor::Actor::new("t".to_owned(), 1, 0),
                );
            })
            .unwrap();
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

#[test]
fn a_session_that_is_still_working_counts_its_agents_and_one_that_is_closing_counts_an_operation() {
    let home = Home::new("INSERT INTO engine_queue (thread_id) VALUES ('t')");
    // A live session on a thread whose root works: the tree is not quiescent, so its agents
    // count, with the root at least once.
    home.exec(
        "UPDATE thread_state SET state = json_set(state, '$.rootKey', 'root', '$.agents', json('{\"root\":{\"agent\":{\"id\":\"agent-1\",\"threadId\":\"t\",\"parentId\":null,\"origin\":\"person\",\"native\":{\"provider\":\"codex\"},\"status\":{\"state\":\"working\",\"activity\":\"thinking\"},\"fidelity\":\"full\",\"cwd\":\"/tmp\",\"background\":false,\"createdAt\":1},\"activity\":\"thinking\",\"lastSignalAt\":1}}')), seq = seq + 1 WHERE thread_id='t'",
    );
    home.exec(
        "INSERT INTO engine_state_records VALUES ('t', 'agentKeysById', 'agent-1', '\"root\"')",
    );
    // A request waiting on the person is live work: the tree is not quiescent.
    home.exec(
        "INSERT INTO engine_state_records VALUES ('t', 'pendingInteractions', 'ask', 'true'); UPDATE thread_state SET seq = seq + 1 WHERE thread_id='t'",
    );
    home.core()
        .with_state(|state| {
            state
                .actors
                .by_thread
                .get_mut("t")
                .expect("the actor")
                .session_attached = true;
        })
        .unwrap();
    let work = home.live();
    assert!(work.agents_running >= 1, "{work:?}");
    assert_eq!(work.operations_running, 0);
    // A closing session counts as an operation even with nothing queued.
    let closing = Home::new("INSERT INTO engine_queue (thread_id) VALUES ('t')");
    let core = closing.core();
    let work = core
        .with_state(|state| live(core, state, "t", &|_| true))
        .unwrap()
        .unwrap();
    assert_eq!(work.operations_running, 1);
}

#[test]
fn an_uncertain_message_keeps_a_thread_unfinished() {
    let home = Home::new("INSERT INTO engine_queue (thread_id) VALUES ('t')");
    home.exec(
        "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position,uncertain) \
         VALUES ('c','t','thread.send','{\"id\":\"c\",\"deviceId\":\"device\",\"payload\":{\"type\":\"thread.send\",\"threadId\":\"t\",\"input\":[{\"type\":\"text\",\"text\":\"hello\"}]}}','running','queue',1,1)",
    );
    assert!(home.unfinished());
}
