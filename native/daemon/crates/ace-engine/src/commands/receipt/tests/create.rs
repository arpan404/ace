// SPDX-License-Identifier: Apache-2.0
//! The create's validation, id, model and stored row.

use super::*;

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
fn a_created_threads_silence_is_the_engines_default() {
    let receipt = Receipt::new(LimitOverrides::default());
    assert_eq!(
        receipt
            .handle(&create(None))
            .get("ok")
            .and_then(Value::as_bool),
        Some(true)
    );
    // `silence.forWorkspace(workspaceId)` with no workspace override (`silence.ts:56`): five
    // minutes, not the engine's old 30 seconds.
    assert_eq!(
        receipt.cell(
            "SELECT CAST(json_extract(state,'$.config.silenceMs') AS INTEGER) AS value \
             FROM thread_state WHERE thread_id='new'"
        ),
        Some(300_000)
    );
}

#[test]
fn a_fresh_create_projects_its_thread_row_before_the_rows_that_reference_it() {
    let receipt = Receipt::new(LimitOverrides::default());
    // The daemon's own connection: `thread_state`, sessions and the queue all reference the
    // `threads` row, and the shell holds the receipt's event writes (`thread.created` projects
    // it) exactly as `NativeEngine::handle` does.
    receipt.exec("PRAGMA foreign_keys=ON");
    let accepted = receipt.handle(&create(None));
    assert_eq!(
        accepted.get("ok").and_then(Value::as_bool),
        Some(true),
        "{accepted}"
    );
    assert_eq!(
        receipt.text("SELECT id AS value FROM threads WHERE id='new'"),
        Some("new".to_owned())
    );
    assert_eq!(
        receipt.cell("SELECT COUNT(*) AS value FROM thread_state WHERE thread_id='new'"),
        Some(1)
    );
}

#[test]
fn a_create_admits_its_first_prompt_like_a_send() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.shell.hold_after_commit();
    let accepted = receipt.handle(&create(None));
    assert_eq!(
        accepted.get("ok").and_then(Value::as_bool),
        Some(true),
        "{accepted}"
    );
    assert_eq!(
        accepted.get("threadId").and_then(Value::as_str),
        Some("new")
    );
    // The prompt is the thread's first input: an intent in the queue, the queue bumped, the
    // naming prompt after the commit, and a wake (`handler.ts:374`-`:380`, `:489`-`:553`).
    assert_eq!(
        receipt.text("SELECT kind AS value FROM intents WHERE command_id='create'"),
        Some("thread.create".to_owned())
    );
    assert_eq!(
        receipt.text("SELECT delivery AS value FROM intents WHERE command_id='create'"),
        Some("queue".to_owned())
    );
    assert_eq!(
        receipt.cell("SELECT revision AS value FROM engine_queue WHERE thread_id='new'"),
        Some(1)
    );
    // The prompt is recorded in the input journal (`acceptInput`): one row whose item key is the
    // command's input and whose origin is the person's.
    let all = ace_store::stmt_cache::all_rows(
        &receipt.conn,
        "SELECT thread_id, item_key FROM engine_inputs",
        Vec::new(),
    )
    .unwrap();
    eprintln!("inputs: {all:?}");
    assert_eq!(
        receipt.cell(
            "SELECT COUNT(*) AS value FROM engine_inputs \
             WHERE thread_id='new' AND item_key='input:create'"
        ),
        Some(1)
    );
    let origin = receipt.text(
        "SELECT origin AS value FROM engine_inputs WHERE thread_id='new' AND item_key='input:create'",
    );
    assert!(
        origin
            .as_deref()
            .is_some_and(|origin| origin.contains("person")),
        "{origin:?}"
    );
    assert!(
        receipt.shell.naming().is_empty(),
        "the prompt waits for the commit"
    );
    receipt.core().release_after_commit();
    let naming = receipt.shell.naming();
    assert_eq!(naming.len(), 1, "{naming:?}");
    assert_eq!(naming[0].0, "new");
    assert!(naming[0].1.contains("hello"), "{}", naming[0].1);
    assert!(
        receipt.core().wakes().iter().any(|wake| wake == "new"),
        "{:?}",
        receipt.core().wakes()
    );
}

#[test]
fn a_thrown_receipt_leaves_no_reclaim_marks_behind() {
    let receipt = Receipt::new(LimitOverrides {
        max_active_threads: Some(1.0),
        ..LimitOverrides::default()
    });
    // A finished thread's warm session holds the one slot (`reclaimIdleSlot`);
    receipt.exec("INSERT INTO engine_slots VALUES ('warm')");
    receipt
        .core()
        .with_state(|state| {
            let mut actor = crate::actor::Actor::new("warm".to_owned(), 1, 0);
            actor.session_attached = true;
            actor.idle_since = Some(1.0);
            state.actors.by_thread.insert("warm".to_owned(), actor);
        })
        .unwrap();
    // The create reclaims the slot, then its first write fails and the transaction rolls back.
    receipt.shell.fail_write_at(1);
    let command = ace_json::parse(&create(None)).expect("json");
    let core = receipt.core();
    let outcome = core.store.atomic(|_| {
        core.with_state(|state| crate::commands::prelude::handle(core, state, &command))?
    });
    assert!(outcome.is_err(), "the failed write rolls the receipt back");
    receipt.shell.drop_deferred();
    core.with_state(|state| {
        assert!(
            state.repo.retiring.is_empty(),
            "no retirement survived the rollback"
        );
        assert!(
            !state.actors.by_thread.get("warm").expect("actor").idle_due,
            "the warm session is not marked due"
        );
    })
    .unwrap();
    // The next admission reclaims the same session, and this time the mark commits with it.
    let accepted = receipt.handle(&send("next"));
    assert_eq!(
        accepted.get("ok").and_then(Value::as_bool),
        Some(true),
        "{accepted}"
    );
    core.with_state(|state| {
        assert!(state.repo.retiring.contains("warm"));
        assert!(state.actors.by_thread.get("warm").expect("actor").idle_due);
    })
    .unwrap();
}

#[test]
fn a_handoff_that_names_a_live_source_reaches_the_unwired_port() {
    let receipt = Receipt::new(LimitOverrides::default());
    // A missing source is validation's own refusal.
    assert_eq!(
        receipt.handle(&create_with(r#","handoffFrom":"missing""#)),
        result("create", "handoff_source_not_found")
    );
    // A live source reaches `portableHandoff`, which is not bound: a throw, not a refusal.
    receipt
        .shell
        .set_thread("source", r#"{"id":"source","provider":"codex"}"#.to_owned());
    let command = ace_json::parse(&create_with(r#","handoffFrom":"source""#)).expect("json");
    let core = receipt.core();
    let outcome = core.store.atomic(|_| {
        core.with_state(|state| crate::commands::prelude::handle(core, state, &command))?
    });
    let error = outcome.expect_err("the unwired handoff read throws");
    assert!(error.to_string().contains("handoff"), "{error}");
    assert!(
        receipt.shell.events("new").is_empty(),
        "the throw wrote no thread"
    );
}

/// The harness's create, plus extra payload fields.
fn create_with(extra: &str) -> String {
    format!(
        r#"{{"id":"create","deviceId":"device","payload":{{"type":"thread.create","workspaceId":"workspace","provider":"codex","threadId":"new","input":[{{"type":"text","text":"hello"}}]{extra}}}}}"#
    )
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
