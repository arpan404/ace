// SPDX-License-Identifier: Apache-2.0
//! The receipt's refusals and what they commit (`handler.ts:55`-`:556`), moved from the
//! TypeScript's own cases: which refusal wins when two apply, and the writes a refusal made
//! before it refused stay committed.

use super::*;
use crate::actor::ActorDeps;
use crate::executor::{Budget, Notified, Notifier};
use crate::frames::live::UnportedLive;
use crate::limits::LimitOverrides;
use crate::repository::testsupport::{
    Shell, StoredAgent, header, header_with_agents, header_with_root_run, home, model_resolution,
};
use std::rc::Rc;
use std::sync::Arc;

struct ManualPump;

impl Notifier for ManualPump {
    fn notify(&self) -> Notified {
        Notified::Posted
    }
}

struct Turn;

impl Budget for Turn {
    fn start(&mut self) {}
    fn spent(&self, started: usize) -> bool {
        started >= 64
    }
}

/// A receipt over one temp home, with the thread's row under the test's control.
struct Receipt {
    engine: crate::Engine,
    shell: Rc<Shell>,
    conn: Arc<ace_store::Connection>,
}

/// The adapter entries a real engine's registry holds for a thread's provider: capabilities and
/// all, as `observe` hands them over (E5.1 step 7). A receipt validates against this registry.
const REGISTRY: &str = r#"[{"provider":"codex","adapter":1,"capabilities":{"steer":true,"childControls":"full"},"discovery":{},"current":true}]"#;

impl Receipt {
    fn new(limits: LimitOverrides) -> Receipt {
        Receipt::with_registry(limits, REGISTRY)
    }

    fn with_registry(limits: LimitOverrides, registry: &str) -> Receipt {
        let conn = home("t", &header("t"));
        let (_, shell) = Shell::store_with_controls(&conn);
        let engine = crate::Engine::new(
            shell.clone(),
            shell.clone(),
            crate::Inputs {
                limits,
                ..crate::Inputs::default()
            },
            registry,
            Box::new(ManualPump),
            &conn,
            Rc::new(ActorDeps::production(Rc::new(UnportedLive), 0.0)),
        )
        .expect("engine");
        let receipt = Receipt {
            engine,
            shell,
            conn,
        };
        // The fold's E5.7 collaborator is not ported yet; the seam's pass-through answers it
        // (E5.3 step 7), so a receipt that folds a queue fact can be tested now.
        receipt
            .core()
            .with_state(|state| state.repo.probe_passthrough = true)
            .unwrap();
        receipt.thread_row("{}");
        receipt.queue("INSERT INTO engine_queue (thread_id) VALUES ('t')");
        receipt.session(
            "INSERT INTO engine_sessions (thread_id, cwd, backend) VALUES ('t', '/tmp', NULL)",
        );
        receipt
    }

    fn core(&self) -> &Rc<crate::Core> {
        self.engine.core()
    }

    /// The row `getThread` answers, as JSON: `{}` plus the fields the test names.
    fn thread_row(&self, extra: &str) -> &Receipt {
        let body = extra.trim();
        let row = if body == "{}" || body.is_empty() {
            r#"{"id":"t","provider":"codex"}"#.to_owned()
        } else {
            format!(r#"{{"id":"t","provider":"codex",{}"#, &body[1..])
        };
        self.shell.set_thread("t", row);
        self
    }

    fn exec(&self, sql: &str) -> &Receipt {
        self.conn.exec(sql).expect("seed");
        self
    }

    fn queue(&self, sql: &str) -> &Receipt {
        self.exec(sql)
    }

    /// Replaces the thread's stored snapshot (the state the receipt folds against).
    fn state(&self, header: &str) -> &Receipt {
        self.exec(&format!(
            "UPDATE thread_state SET state = {}",
            crate::repository::testsupport::sql_text(header)
        ))
    }

    fn session(&self, sql: &str) -> &Receipt {
        self.exec(sql)
    }

    /// One receipt, inside the shell's transaction as the binding runs it.
    fn handle(&self, command: &str) -> Value {
        let command = ace_json::parse(command).expect("json");
        let core = self.core();
        let outcome = core.store.atomic(|_tx| {
            core.with_state(|state| crate::commands::prelude::handle(core, state, &command))?
        });
        match outcome {
            Ok(Some(result)) => result,
            Ok(None) => panic!("the prelude claimed the command"),
            Err(error) => panic!("the receipt threw: {error}"),
        }
    }

    fn cell(&self, sql: &'static str) -> Option<i64> {
        let row = ace_store::stmt_cache::get_row(&self.conn, sql, Vec::new()).expect("row");
        row.and_then(|row| {
            row.get("value")
                .and_then(crate::repository::residency::cell_int)
        })
    }

    fn text(&self, sql: &'static str) -> Option<String> {
        let row = ace_store::stmt_cache::get_row(&self.conn, sql, Vec::new()).expect("row");
        row.and_then(|row| {
            row.get("value")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
        })
    }

    fn settle(&self) {
        for _ in 0..6 {
            let mut budget = Turn;
            self.engine.pump(&mut budget);
        }
    }
}

fn send(id: &str) -> String {
    format!(
        r#"{{"id":"{id}","deviceId":"device","payload":{{"type":"thread.send","threadId":"t","input":[{{"type":"text","text":"hello"}}]}}}}"#
    )
}

fn result(command_id: &str, error: &str) -> Value {
    let mut value = ace_json::Map::new();
    value.insert("commandId", Value::from(command_id));
    value.insert("ok", Value::Bool(false));
    value.insert("error", Value::from(error));
    Value::Object(value)
}

fn refusal(command_id: &str, error: &str, title: &str, detail: &str) -> Value {
    let mut value = ace_json::Map::new();
    value.insert("commandId", Value::from(command_id));
    value.insert("ok", Value::Bool(false));
    value.insert("error", Value::from(error));
    value.insert("title", Value::from(title));
    value.insert("detail", Value::from(detail));
    Value::Object(value)
}

#[test]
fn a_deleting_thread_refuses_before_a_too_large_message_does() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt
        .core()
        .with_state(|state| {
            state.repo.cleaning.insert("t".to_owned());
        })
        .unwrap();
    let parts: Vec<String> = (0..65)
        .map(|n| format!(r#"{{"type":"text","text":"{n}"}}"#))
        .collect();
    let command = format!(
        r#"{{"id":"c","deviceId":"device","payload":{{"type":"thread.send","threadId":"t","input":[{}]}}}}"#,
        parts.join(",")
    );
    assert_eq!(receipt.handle(&command), result("c", "thread_deleting"));
    // The prelude's refusal writes nothing: no intent, no queue change.
    assert_eq!(
        receipt.cell("SELECT COUNT(*) AS value FROM intents"),
        Some(0)
    );
    assert!(receipt.shell.written_types("t").is_empty());
}

#[test]
fn a_retired_cursor_thread_refuses_before_the_size_check() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.thread_row(r#"{"continuation":{"state":"read_only","reason":"cursor_cli_retired","actionId":"thread.continue_new"}}"#);
    let parts: Vec<String> = (0..65)
        .map(|n| format!(r#"{{"type":"text","text":"{n}"}}"#))
        .collect();
    let command = format!(
        r#"{{"id":"c","deviceId":"device","payload":{{"type":"thread.send","threadId":"t","input":[{}]}}}}"#,
        parts.join(",")
    );
    assert_eq!(
        receipt.handle(&command),
        refusal(
            "c",
            "cursor_cli_retired",
            "This Cursor thread is read-only",
            "Continue in a new thread to carry its history to Cursor."
        )
    );
}

#[test]
fn an_unhandled_type_is_not_implemented_and_a_missing_thread_is_not_found() {
    let receipt = Receipt::new(LimitOverrides::default());
    assert_eq!(
        receipt.handle(
            r#"{"id":"c1","deviceId":"device","payload":{"type":"thread.rename","threadId":"t","title":"x"}}"#
        ),
        result("c1", "not_implemented")
    );
    receipt
        .shell
        .set_thread("gone", r#"{"id":"gone","provider":"codex"}"#.to_owned());
    receipt.exec("DELETE FROM thread_state WHERE thread_id='t'");
    receipt
        .shell
        .set_thread("t", r#"{"id":"t","provider":"codex"}"#.to_owned());
    assert_eq!(
        receipt.handle(&send("c2")),
        result("c2", "thread_not_found")
    );
}

#[test]
fn a_workspace_change_in_preparation_refuses_the_thread() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.thread_row(
        r#"{"details":{"workspaceChange":{"commandId":"w","state":"preparing","at":1}}}"#,
    );
    assert_eq!(
        receipt.handle(&send("c")),
        result("c", "workspace_change_in_progress")
    );
}

#[test]
fn a_message_over_sixty_four_parts_is_too_large() {
    let receipt = Receipt::new(LimitOverrides::default());
    let parts: Vec<String> = (0..65)
        .map(|n| format!(r#"{{"type":"text","text":"{n}"}}"#))
        .collect();
    let command = format!(
        r#"{{"id":"c","deviceId":"device","payload":{{"type":"thread.send","threadId":"t","input":[{}]}}}}"#,
        parts.join(",")
    );
    assert_eq!(receipt.handle(&command), result("c", "message_too_large"));
    // Exactly 64 parts is not.
    let parts: Vec<String> = (0..64)
        .map(|n| format!(r#"{{"type":"text","text":"{n}"}}"#))
        .collect();
    let command = format!(
        r#"{{"id":"ok","deviceId":"device","payload":{{"type":"thread.send","threadId":"t","input":[{}]}}}}"#,
        parts.join(",")
    );
    let accepted = receipt.handle(&command);
    assert_eq!(accepted.get("ok").and_then(Value::as_bool), Some(true));
}

#[test]
fn an_unknown_agent_a_stale_run_and_an_unsupported_goal_refuse() {
    let receipt = Receipt::new(LimitOverrides::default());
    assert_eq!(
        receipt.handle(
            r#"{"id":"a","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","agentId":"nobody"}}"#
        ),
        result("a", "agent_not_found")
    );
    assert_eq!(
        receipt.handle(
            r#"{"id":"r","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","runId":"run-1"}}"#
        ),
        result("r", "stale_interrupt")
    );
    assert_eq!(
        receipt.handle(
            r#"{"id":"g","deviceId":"device","payload":{"type":"thread.goal.set","threadId":"t","goal":{"text":"x"}}}"#
        ),
        result("g", "unsupported_goal")
    );
}

#[test]
fn a_stop_that_names_the_root_turns_run_interrupts_it() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.state(&header_with_root_run("t", "run-1", "active"));
    // The web's Stop carries `runId` and no `agentId` (`live-actions.ts:100`): the run is looked
    // up under the root's **state** key, whose record id is not the key itself.
    let accepted = receipt.handle(
        r#"{"id":"stop","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","cascade":true,"runId":"run-1"}}"#,
    );
    assert_eq!(
        accepted.get("ok").and_then(Value::as_bool),
        Some(true),
        "{accepted}"
    );
    assert_eq!(
        receipt.text("SELECT reason AS value FROM engine_queue WHERE thread_id='t'"),
        Some("stopped".to_owned())
    );
    // A run the root is not in, or one that already ended, is stale.
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.state(&header_with_root_run("t", "run-2", "active"));
    assert_eq!(
        receipt.handle(
            r#"{"id":"r","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","runId":"run-1"}}"#
        ),
        result("r", "stale_interrupt")
    );
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.state(&header_with_root_run("t", "run-1", "ended"));
    assert_eq!(
        receipt.handle(
            r#"{"id":"r","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","runId":"run-1"}}"#
        ),
        result("r", "stale_interrupt")
    );
}

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
    // The first write is the accepted input's own rows; the next one (the queue's bump) fails,
    // so the receipt rolls back after the prompt was deferred.
    receipt.shell.fail_write_at(2);
    let command = ace_json::parse(&send("c")).expect("json");
    let core = receipt.core();
    let outcome = core.store.atomic(|_tx| {
        core.with_state(|state| crate::commands::prelude::handle(core, state, &command))?
    });
    assert!(outcome.is_err(), "the failed write rolls the receipt back");
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

/// A `thread.create` for the harness's workspace, with an optional model.
fn create(model: Option<&str>) -> String {
    let model = model
        .map(|model| format!(r#","model":"{model}""#))
        .unwrap_or_default();
    format!(
        r#"{{"id":"create","deviceId":"device","payload":{{"type":"thread.create","workspaceId":"workspace","provider":"codex","threadId":"new","input":[{{"type":"text","text":"hello"}}]{model}}}}}"#
    )
}

/// The stored `thread.created` payload's `execution.model`.
fn stored_model(receipt: &Receipt) -> Option<String> {
    receipt
        .shell
        .events("new")
        .into_iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("thread.created"))
        .and_then(|event| {
            event
                .get("thread")
                .and_then(|thread| thread.get("execution"))
                .and_then(|execution| execution.get("model"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
}

#[test]
fn a_create_naming_an_existing_thread_refuses_thread_exists() {
    let receipt = Receipt::new(LimitOverrides::default());
    // The harness's thread `t` is stored: `validateCreation` refuses its id (`handler.ts:217`,
    // `creation-validation.ts:26`) instead of overwriting a live thread's snapshot.
    let command = r#"{"id":"create","deviceId":"device","payload":{"type":"thread.create","workspaceId":"workspace","provider":"codex","threadId":"t","input":[{"type":"text","text":"hello"}]}}"#;
    assert_eq!(receipt.handle(command), result("create", "thread_exists"));
    assert!(
        receipt.shell.events("t").is_empty(),
        "the refusal wrote no thread"
    );
    // A fresh id still creates.
    assert_eq!(
        receipt
            .handle(&create(None))
            .get("ok")
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn a_create_without_an_id_takes_the_ports_next_thread_id() {
    let receipt = Receipt::new(LimitOverrides::default());
    let command = r#"{"id":"create","deviceId":"device","payload":{"type":"thread.create","workspaceId":"workspace","provider":"codex","input":[{"type":"text","text":"hello"}]}}"#;
    let accepted = receipt.handle(command);
    assert_eq!(
        accepted.get("ok").and_then(Value::as_bool),
        Some(true),
        "{accepted}"
    );
    // `p.threadId ?? nextId()` (`handler.ts:244`): the port named it, not the empty string.
    assert_eq!(
        accepted.get("threadId").and_then(Value::as_str),
        Some("thread-1"),
        "{accepted}"
    );
    assert_eq!(
        receipt.text("SELECT id AS value FROM threads WHERE id='thread-1'"),
        Some("thread-1".to_owned())
    );
}

#[test]
fn a_read_only_child_adapter_refuses_a_stop_of_its_child() {
    let read_only = r#"[{"provider":"codex","adapter":1,"capabilities":{"steer":true,"childControls":"read-only"},"discovery":{},"current":true}]"#;
    let receipt = Receipt::with_registry(LimitOverrides::default(), read_only);
    receipt.state(&header_with_agents(
        "t",
        &[
            StoredAgent {
                key: "root",
                id: "root",
                parent: None,
                run: Some("run-1"),
            },
            StoredAgent {
                key: "child",
                id: "child-agent",
                parent: Some("root"),
                run: None,
            },
        ],
        &[("run-1", "active")],
    ));
    // Cursor's SDK adapter cannot control a child (`adapter-cursor/src/policy.ts:17`): the Stop
    // is refused where its root's own Stop is fine.
    assert_eq!(
        receipt.handle(
            r#"{"id":"child","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","agentId":"child-agent"}}"#
        ),
        result("child", "unsupported_child_control")
    );
    assert_eq!(
        receipt
            .handle(
                r#"{"id":"root","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","agentId":"root"}}"#
            )
            .get("ok")
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn the_inert_fields_are_the_typescripts_lists() {
    let value = |text: &str| ace_json::parse(text).expect("json");
    // `thread.updated`'s inert list (`thread-fence.ts:33`-`:44`) has no `details`: a detail
    // change can archive work, so it counts as work.
    assert!(changes_work(
        "thread.updated",
        &value(r#"{"details":{"workspace":{"kind":"local"}}}"#)
    ));
    assert!(!changes_work("thread.updated", &value(r#"{"title":"x"}"#)));
    assert!(!changes_work(
        "thread.updated",
        &value(r#"{"capabilities":{},"status":{"state":"new"}}"#)
    ));
    // `thread.client.updated`'s list (`:45`-`:70`) includes `host`: it never changes work.
    assert!(!changes_work(
        "thread.client.updated",
        &value(r#"{"changes":{"host":"machine","pinned":true}}"#)
    ));
    assert!(changes_work(
        "thread.client.updated",
        &value(r#"{"changes":{"queueRevision":2}}"#)
    ));
    // A user message is work; a synthetic one is not.
    assert!(changes_work(
        "item.created",
        &value(r#"{"item":{"type":"message","role":"user","parts":[]}}"#)
    ));
    assert!(!changes_work(
        "item.created",
        &value(r#"{"item":{"type":"message","role":"user","synthetic":true,"parts":[]}}"#)
    ));
    assert!(!changes_work("run.ended", &value(r#"{}"#)));
    assert!(changes_work("run.started", &value(r#"{}"#)));
}

#[test]
fn a_create_with_a_catalog_stores_the_model_the_catalog_resolves() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt
        .shell
        .answer_models(&model_resolution("gpt-5", Some("openai")), "{}");
    let accepted = receipt.handle(&create(None));
    assert_eq!(accepted.get("ok").and_then(Value::as_bool), Some(true));
    // `executionModelId(row)` prefixes the row's source provider (`execution-id.ts:8`).
    assert_eq!(stored_model(&receipt).as_deref(), Some("openai/gpt-5"));
    let created = receipt
        .shell
        .events("new")
        .into_iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("thread.created"))
        .expect("the create wrote its thread");
    let live_model = created
        .get("thread")
        .and_then(|thread| thread.get("live"))
        .and_then(|live| live.get("model"))
        .and_then(Value::as_str);
    assert_eq!(
        live_model,
        Some("openai/gpt-5"),
        "the live block names it too"
    );
}

#[test]
fn an_unknown_explicit_model_is_model_unavailable_with_one_callback() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.shell.answer_models(r#"{"ok":false}"#, "{}");
    assert_eq!(
        receipt.handle(&create(Some("gpt-9"))),
        result("create", "model_unavailable")
    );
    assert_eq!(
        receipt.shell.unavailable(),
        vec![("codex".to_owned(), "gpt-9".to_owned())]
    );
    // The refusal wrote no thread.
    assert!(receipt.shell.events("new").is_empty());
    assert_eq!(
        receipt.cell("SELECT COUNT(*) AS value FROM intents"),
        Some(0)
    );
    // And took no engine slot: the model is chosen before the thread reserves (`handler.ts:232`).
    assert_eq!(
        receipt.cell("SELECT COUNT(*) AS value FROM engine_slots"),
        Some(0)
    );
}

#[test]
fn a_created_thread_keeps_its_workspaces_kind_machine_and_capabilities() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.exec(
        "INSERT INTO workspace_metadata (workspace_id, kind) VALUES ('workspace','repository')",
    );
    receipt
        .shell
        .answer_machine(r#"{"host":"m1","name":"Arpan's MacBook Pro"}"#);
    let accepted = receipt.handle(&create(None));
    assert_eq!(accepted.get("ok").and_then(Value::as_bool), Some(true));
    let created = receipt
        .shell
        .events("new")
        .into_iter()
        .find(|event| event.get("type").and_then(Value::as_str) == Some("thread.created"))
        .expect("the create wrote its thread");
    let thread = created.get("thread").expect("the row");
    // The workspace's stored spelling, its metadata kind (`create-thread.ts:44`-`:49`), the
    // adapter's capabilities and the paired machine the daemon was given.
    assert_eq!(
        thread
            .get("details")
            .and_then(|details| details.get("workspace"))
            .and_then(|workspace| workspace.get("path"))
            .and_then(Value::as_str),
        Some("/tmp")
    );
    assert_eq!(
        thread
            .get("details")
            .and_then(|details| details.get("workspace"))
            .and_then(|workspace| workspace.get("kind"))
            .and_then(Value::as_str),
        Some("repository")
    );
    assert_eq!(
        thread
            .get("details")
            .and_then(|details| details.get("machine"))
            .and_then(|machine| machine.get("host"))
            .and_then(Value::as_str),
        Some("m1")
    );
    assert_eq!(
        thread
            .get("capabilities")
            .and_then(|capabilities| capabilities.get("steer"))
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn without_a_catalog_a_default_sentinel_is_dropped_and_an_explicit_model_kept() {
    let receipt = Receipt::new(LimitOverrides::default());
    assert_eq!(
        receipt
            .handle(&create(Some("default")))
            .get("ok")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(stored_model(&receipt), None, "a sentinel is not a model");

    let receipt = Receipt::new(LimitOverrides::default());
    assert_eq!(
        receipt
            .handle(&create(Some("gpt-5")))
            .get("ok")
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(stored_model(&receipt).as_deref(), Some("gpt-5"));
}
