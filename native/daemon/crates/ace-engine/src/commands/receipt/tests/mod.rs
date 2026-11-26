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

mod create;
mod interrupt;
mod send;
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
