// SPDX-License-Identifier: Apache-2.0
//! The send's admission tail: capacity, retirement, the title and the rollback.

use super::*;

#[test]
fn a_full_engine_refuses_a_send_and_keeps_the_slot_it_could_not_take() {
    let receipt = Receipt::new(LimitOverrides {
        max_active_threads: Some(1.0),
        ..LimitOverrides::default()
    });
    receipt.exec("INSERT INTO engine_slots VALUES ('other')");
    assert_eq!(
        receipt.handle(&send("c")),
        result("c", "engine_capacity_exceeded")
    );
    assert_eq!(
        receipt.cell("SELECT COUNT(*) AS value FROM intents"),
        Some(0)
    );
}

#[test]
fn two_hundred_and_fifty_six_inputs_in_flight_refuse_and_the_streak_is_already_cleared() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.exec("INSERT INTO engine_restart_resumes VALUES ('t', 3)");
    for n in 0..256 {
        receipt.exec(&format!(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) \
             VALUES ('old-{n}','t','thread.send','{{}}','pending','queue',{n})"
        ));
    }
    assert_eq!(
        receipt.handle(&send("c")),
        result("c", "queue_capacity_exceeded")
    );
    // The refusal is a `CommandResult`, so the transaction commits: the streak is gone.
    assert_eq!(
        receipt.cell("SELECT COUNT(*) AS value FROM engine_restart_resumes"),
        Some(0)
    );
    // And no new input was added.
    assert_eq!(
        receipt.cell("SELECT COUNT(*) AS value FROM intents WHERE command_id='c'"),
        Some(0)
    );
}

#[test]
fn a_full_engine_on_a_send_retires_the_uncertain_input_and_releases_the_stop_first() {
    let receipt = Receipt::new(LimitOverrides {
        max_active_threads: Some(1.0),
        ..LimitOverrides::default()
    });
    receipt.exec("INSERT INTO engine_slots VALUES ('other')");
    receipt.queue("UPDATE engine_queue SET paused=1, reason='stopped', hold_token=2");
    receipt.exec(
        "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position,uncertain) \
         VALUES ('uncertain','t','thread.send','{}','running','queue',1,1)",
    );
    assert_eq!(
        receipt.handle(&send("c")),
        result("c", "engine_capacity_exceeded")
    );
    // Retired: the input waits on the person no more.
    assert_eq!(
        receipt.cell("SELECT uncertain AS value FROM intents WHERE command_id='uncertain'"),
        Some(0)
    );
    // Released: the Stop's hold is gone, and its change was published.
    assert_eq!(
        receipt.text("SELECT reason AS value FROM engine_queue WHERE thread_id='t'"),
        None
    );
    assert!(
        receipt
            .shell
            .written_types("t")
            .iter()
            .any(|kind| kind == "queue.updated"),
        "the release publishes its queue.updated"
    );
}

#[test]
fn an_accepted_send_writes_its_intent_the_queue_bump_and_the_title() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.thread_row(r#"{"title":"Untitled thread","titleSource":"provisional"}"#);
    let accepted = receipt.handle(&send("c"));
    assert_eq!(accepted.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(accepted.get("threadId").and_then(Value::as_str), Some("t"));
    assert_eq!(
        receipt.text("SELECT kind AS value FROM intents WHERE command_id='c'"),
        Some("thread.send".to_owned())
    );
    assert_eq!(
        receipt.cell("SELECT revision AS value FROM engine_queue WHERE thread_id='t'"),
        Some(1),
        "an empty patch still bumps the revision"
    );
    let kinds = receipt.shell.written_types("t");
    assert!(
        kinds.iter().any(|kind| kind == "thread.updated"),
        "{kinds:?}"
    );
    assert!(
        kinds.iter().any(|kind| kind == "queue.updated"),
        "{kinds:?}"
    );
    receipt.settle();
}

#[test]
fn a_create_refuses_while_its_own_reservation_is_held_by_another_owner() {
    let receipt = Receipt::new(LimitOverrides::default());
    let command = r#"{"id":"c","deviceId":"device","payload":{"type":"thread.create","workspaceId":"workspace","provider":"codex","threadId":"new","input":[]}}"#;
    let parsed = ace_json::parse(command).unwrap();
    let core = receipt.core();
    core.with_state(|state| {
        let crate::State { commands, repo, .. } = state;
        let mut store = crate::commands::admissions::RepoStore {
            repo,
            store: &core.store,
        };
        commands
            .admissions
            .acquire(&mut store, &parsed, "next")
            .expect("held");
    })
    .unwrap();
    assert_eq!(
        receipt.handle(command),
        result("c", "thread_creation_in_progress")
    );
}

#[test]
fn an_accepted_send_names_the_thread_once_after_the_commit() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.shell.hold_after_commit();
    // The row is the provisional title of the message: the prompt only fires for that title.
    receipt.thread_row(r#"{"title":"hello","titleSource":"provisional"}"#);
    let accepted = receipt.handle(&send("c"));
    assert_eq!(accepted.get("ok").and_then(Value::as_bool), Some(true));
    // Inside the receipt nothing ran: the prompt waits for the commit.
    assert!(receipt.shell.naming().is_empty());
    receipt.core().release_after_commit();
    let naming = receipt.shell.naming();
    assert_eq!(naming.len(), 1, "{naming:?}");
    assert_eq!(naming[0].0, "t");
    // The parts it names from are the message's own.
    assert!(naming[0].1.contains("hello"), "{}", naming[0].1);
}

#[test]
fn a_receipt_that_rolls_back_never_names_its_thread() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.shell.hold_after_commit();
    receipt.thread_row(r#"{"title":"hello","titleSource":"provisional"}"#);
    // The shell holds the receipt's event writes and flushes them before the commit; the flush
    // fails, so the receipt rolls back after the prompt was deferred.
    receipt.shell.fail_write_at(1);
    let command = ace_json::parse(&send("c")).expect("json");
    let core = receipt.core();
    let outcome = core.store.atomic(|_tx| {
        let result =
            core.with_state(|state| crate::commands::prelude::handle(core, state, &command))?;
        core.store.flush_events()?;
        result
    });
    assert!(outcome.is_err(), "the failed write rolls the receipt back");
    receipt.shell.drop_deferred();
    // The stack drops a rolled-back frame's deferreds; nothing runs when the commit would.
    let dropped = receipt.shell.dropped();
    core.discard_after_commit(&dropped);
    core.release_after_commit();
    assert!(
        receipt.shell.naming().is_empty(),
        "{:?}",
        receipt.shell.naming()
    );
    // And nothing the receipt wrote survived.
    assert_eq!(
        receipt.cell("SELECT COUNT(*) AS value FROM intents"),
        Some(0)
    );
}
