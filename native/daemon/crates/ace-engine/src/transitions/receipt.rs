// SPDX-License-Identifier: Apache-2.0
//! `transition-handler.ts` (E5.9): the receipt's acceptance of a switch, merge or fork, before
//! any session work. The fork's own acceptance waits for the create seam E5.4e owns, so a fork
//! still answers `NativeEngineIncomplete`; the switch and merge paths are complete here.
//!
//! Order is contract (`transition-handler.ts:32`): workspace-change refusal, missing thread,
//! a guarded thread, then the merge's queue, lineage, quiescence and citation checks, or the
//! switch's agent, registry, selection and slot. Every refusal keeps the TypeScript's code, and
//! every failure becomes `{commandId, ok:false, error}` as `acceptTransition` catches it.

use ace_json::Value;

use crate::commands::{command_id, error, ok, payload};
use crate::intents::header::headers;
use crate::transitions::history;
use crate::transitions::switch_admission::{AgentChoice, resolve_switch, switch_agent};
use crate::{Core, EngineError, State};

/// The refusals `acceptTransition` returns.
fn fail(command_id: &str, code: &str) -> Value {
    error(command_id, code)
}

fn thread_row(core: &Core, id: &str) -> Result<Option<Value>, EngineError> {
    Ok(core
        .store
        .get_thread(id)?
        .and_then(|json| ace_json::parse(&json).ok()))
}

fn quiescent(core: &Core, state: &mut State, id: &str) -> Result<bool, EngineError> {
    history::thread_quiescent(&core.store, state, id)
}

/// The merge receipt (`transition-handler.ts:151`): the fork is quiet, its lineage and citations
/// hold, and the source has room for one more merge.
fn accept_merge(core: &Core, state: &mut State, command: &Value) -> Result<Value, EngineError> {
    let id = command_id(command);
    let p = payload(command);
    let thread_id = p
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(thread) = thread_row(core, thread_id)? else {
        return Ok(fail(id, "thread_not_found"));
    };
    // The fork's own queue must be still; a held message goes nowhere until the person lets it.
    if !headers(core.store.conn(), Some(thread_id), None)?.is_empty() {
        return Ok(fail(id, "fork_tree_is_live"));
    }
    let Some(lineage) = thread.get("lineage") else {
        return Ok(fail(id, "thread_is_not_a_fork"));
    };
    if !quiescent(core, state, thread_id)? {
        return Ok(fail(id, "fork_tree_is_live"));
    }
    let citations = p
        .get("citations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut cited_ids = Vec::new();
    for citation in &citations {
        let thread = citation.get("threadId").and_then(Value::as_str);
        let item = citation.get("itemId").and_then(Value::as_str);
        let (Some(thread), Some(item)) = (thread, item) else {
            return Ok(fail(id, "invalid_citation_thread"));
        };
        if thread != thread_id {
            return Ok(fail(id, "invalid_citation_thread"));
        }
        cited_ids.push(item.to_owned());
    }
    if let Err(error) = history::validate_citations(&core.store, thread_id, &cited_ids) {
        return Ok(fail(id, &error.to_string()));
    }
    let Some(source_id) = lineage.get("parentThreadId").and_then(Value::as_str) else {
        return Ok(fail(id, "thread_not_found"));
    };
    if state.repo.state(&core.store, source_id)?.is_none() {
        return Ok(fail(id, "source_thread_not_found"));
    }
    let merges = headers(core.store.conn(), Some(source_id), None)?
        .into_iter()
        .filter(|intent| intent.kind == "thread.merge")
        .count();
    if merges >= 8 {
        return Ok(fail(id, "merge_queue_capacity_exceeded"));
    }
    if state.transition_guarded(&core.store, source_id)? {
        return Ok(fail(id, "thread_transition_in_progress"));
    }
    let patch = p.get("patch").filter(|patch| !matches!(patch, Value::Null));
    if patch.is_some() && !quiescent(core, state, source_id)? {
        return Ok(fail(id, "source_tree_is_live"));
    }
    if !state.repo.reserve(&core.store, source_id)? {
        return Ok(fail(id, "engine_capacity_exceeded"));
    }
    if patch.is_some() {
        state.transition_guard(&core.store, thread_id, id)?;
        state.transition_guard(&core.store, source_id, id)?;
    }
    crate::intents::lifecycle::add(&core.store, command, source_id, None, None)?;
    if let Some(engine) = core.self_rc() {
        crate::transitions::dispatch::schedule(&engine, source_id);
    }
    Ok(ok(id, None))
}

/// The switch receipt (`transition-handler.ts:172`): the destination is known, the selection
/// resolves, the thread has a slot, and one switch is now queued.
fn accept_switch(core: &Core, state: &mut State, command: &Value) -> Result<Value, EngineError> {
    let id = command_id(command);
    let p = payload(command);
    let thread_id = p
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let Some(thread) = thread_row(core, thread_id)? else {
        return Ok(fail(id, "thread_not_found"));
    };
    let selection = p.get("selection").cloned().unwrap_or(Value::Null);
    let agent = match switch_agent(&thread, &selection) {
        AgentChoice::Required => return Ok(fail(id, "acp_identity_required")),
        AgentChoice::Identity(identity) => Some(identity),
        AgentChoice::None => None,
    };
    let provider = selection
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    if !state.registry.has(&provider) {
        return Ok(fail(id, "provider_unavailable"));
    }
    let requested = if let Some(identity) = &agent {
        let mut requested = selection.clone();
        if let Some(object) = requested.as_object_mut() {
            object.insert(
                "acpAgentId",
                identity.get("acpAgentId").cloned().unwrap_or_default(),
            );
            object.insert(
                "installationId",
                identity.get("installationId").cloned().unwrap_or_default(),
            );
            object.insert(
                "instanceId",
                identity.get("instanceId").cloned().unwrap_or_default(),
            );
        }
        requested
    } else {
        selection
    };
    let config_provider = {
        let snapshot = state.repo.require_state(&core.store, thread_id)?;
        snapshot.borrow().state.config.provider.clone()
    };
    let backend =
        if requested.get("provider").and_then(Value::as_str) == Some(config_provider.as_str()) {
            state
                .session_backend(&core.store, thread_id)
                .unwrap_or(None)
        } else {
            None
        };
    let capabilities = match state.registry.get(&provider, backend.as_deref()) {
        Ok(entry) => entry.capabilities.clone(),
        Err(_) => return Ok(fail(id, "provider_unavailable")),
    };
    let resolved = resolve_switch(core, state, thread_id, &requested, |_| capabilities.clone())?;
    match resolved {
        Ok(_) => {}
        Err(code) => return Ok(fail(id, &code)),
    }
    // Every refusal above is the receipt's own. Executing the switch needs E5.6's sessions and
    // models ports (close the source session, prepare the destination's model), so until that
    // item lands a valid switch is refused rather than accepted and never run.
    Err(EngineError::not_ported("a thread switch", "E5.6"))
}

/// `acceptTransition` (`transition-handler.ts:16`): the receipt's answer, or none when the
/// command is not a transition.
pub fn accept(
    core: &Core,
    state: &mut State,
    command: &Value,
) -> Result<Option<Value>, EngineError> {
    let kind = crate::commands::payload_type(command);
    if !matches!(kind, "thread.switch" | "thread.merge" | "thread.fork") {
        return Ok(None);
    }
    let id = command_id(command);
    let thread_id = payload(command)
        .get("threadId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    // The workspace-change fence comes before the thread lookup, as it does today.
    if let Some(thread) = thread_row(core, thread_id)?
        && let Some(change) = thread
            .get("details")
            .and_then(|details| details.get("workspaceChange"))
        && (change.get("state").and_then(Value::as_str) == Some("preparing")
            || change.get("uncertain").and_then(Value::as_bool) == Some(true))
    {
        return Ok(Some(fail(id, "workspace_change_in_progress")));
    }
    if state.repo.state(&core.store, thread_id)?.is_none() {
        return Ok(Some(fail(id, "thread_not_found")));
    }
    if state.transition_guarded(&core.store, thread_id)? {
        return Ok(Some(fail(id, "thread_transition_in_progress")));
    }
    let result = match kind {
        "thread.merge" => accept_merge(core, state, command),
        "thread.switch" => accept_switch(core, state, command),
        _ => return Ok(None),
    };
    Ok(Some(match result {
        Ok(result) => result,
        Err(error) => fail(id, &error.to_string()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::prelude::handle;
    use crate::executor::{Notified, Notifier};
    use crate::frames::live::UnportedLive;
    use crate::repository::testsupport::{Shell, header, home, sql_text};
    use crate::{Engine, Inputs};
    use std::rc::Rc;
    use std::sync::Arc;

    struct ManualPump;

    impl Notifier for ManualPump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    fn engine_on(conn: &Arc<ace_store::Connection>) -> (Engine, Rc<Shell>) {
        let (_, shell) = Shell::store_with_controls(conn);
        let engine = Engine::new(
            shell.clone(),
            shell.clone(),
            Inputs::default(),
            r#"[
                {"provider":"codex","backend":"acp","adapter":1,"capabilities":{}},
                {"provider":"claude","backend":"sdk","adapter":2,"capabilities":{}}
            ]"#,
            Box::new(ManualPump),
            conn,
            Rc::new(crate::actor::ActorDeps::production(
                Rc::new(UnportedLive),
                0.0,
            )),
        )
        .expect("the test engine constructs");
        // E5.7's interaction ledger is not ported yet; its answers are the scaffold's, as every
        // fold test in this crate does.
        engine
            .core()
            .with_state(|state| state.repo.probe_passthrough = true)
            .expect("the state is free");
        (engine, shell)
    }

    /// A fork of `t` with an item of its own, so a merge has something to cite.
    fn fork_of_t(conn: &Arc<ace_store::Connection>) {
        let lineage = r#"{"lineage":{"parentThreadId":"t","parentAgentId":"root","point":{"type":"turn","runId":"r"},"mode":"portable","lossy":true}}"#;
        conn.exec(&format!(
            "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at, client) VALUES ('t2', 'workspace', 'Fork', 'claude', '{{\"state\":\"new\"}}', 0, 0, {})",
            sql_text(lineage)
        ))
        .expect("fork thread");
        conn.exec(&format!(
            "INSERT INTO thread_state VALUES ('t2', {}, 0)",
            sql_text(&header("t2"))
        ))
        .expect("fork state");
        conn.exec(&format!(
            "INSERT INTO items VALUES ('own', 't2', 1, {})",
            sql_text(
                r#"{"id":"own","agentId":"root","type":"message","role":"assistant","complete":true,"createdAt":1,"parts":[{"type":"text","text":"done"}]}"#
            )
        ))
        .expect("own item");
    }

    fn merge_command(patch: bool) -> Value {
        let patch = if patch {
            r#","patch":"diff --git a/x b/x""#
        } else {
            ""
        };
        ace_json::parse(&format!(
            r#"{{"id":"cmd-merge","deviceId":"d","payload":{{"type":"thread.merge","threadId":"t2","summary":"done","citations":[{{"threadId":"t2","itemId":"own"}}]{patch}}}}}"#
        ))
        .expect("command")
    }

    // A boot rebuild that has not reached a thread says nothing about it: its stored agent may
    // be working, so a transition may not treat it as ready.
    #[test]
    fn a_thread_the_boot_rebuild_has_not_reached_is_not_ready() {
        let conn = home("t", &header("t"));
        fork_of_t(&conn);
        conn.exec(&format!(
            "INSERT INTO engine_state_records VALUES ('t', 'agents', 'root', {})",
            sql_text(
                r#"{"agent":{"id":"root","threadId":"t","origin":"root","native":{"provider":"claude"},"fidelity":"full","cwd":"/tmp","status":{"state":"working","activity":"thinking"},"createdAt":1},"activity":"thinking","lastSignalAt":2,"activeRun":"run-1"}"#
            )
        ))
        .expect("working root");
        let (engine, _shell) = engine_on(&conn);
        let core = engine.core();
        let result = core
            .with_state(|state| {
                state.transitions.booting = true;
                state.transitions.rebuilt.insert("t2".to_owned());
                handle(core, state, &merge_command(true))
            })
            .expect("the state is free")
            .expect("receipt")
            .expect("a receipt");
        assert_eq!(
            result.get("error").and_then(Value::as_str),
            Some("source_tree_is_live")
        );
    }

    struct Turn;

    impl crate::executor::Budget for Turn {
        fn start(&mut self) {}
        fn spent(&self, started: usize) -> bool {
            started >= 64
        }
    }

    fn settle(engine: &Engine) {
        for _ in 0..8 {
            engine.pump(&mut Turn);
        }
    }

    /// The merged-context items a client was sent, as `(event type, item)`.
    fn merged_events(shell: &Shell) -> Vec<(String, Value)> {
        let mut items = Vec::new();
        for (_, payload, _) in shell.events() {
            let Ok(events) = ace_json::parse(&payload) else {
                continue;
            };
            for event in events.as_array().into_iter().flatten() {
                let kind = event
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if matches!(kind, "item.created" | "item.updated")
                    && let Some(item) = event.get("item")
                    && item.get("mergedContext").is_some()
                {
                    items.push((kind.to_owned(), item.clone()));
                }
            }
        }
        items
    }

    fn intent_status(conn: &std::sync::Arc<ace_store::Connection>) -> Option<String> {
        ace_store::stmt_cache::get_row(
            conn,
            "SELECT status FROM intents WHERE thread_id='t' ORDER BY id DESC LIMIT 1",
            Vec::new(),
        )
        .expect("intent")
        .and_then(|row| {
            row.get("status")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
        })
    }

    // From `thread-merge-account.process.test.ts`: the receipt's success is followed by the
    // merge itself — one synthetic transcript item, the intent settled and its guards gone.
    #[test]
    fn a_merge_receipt_is_executed_and_visible() {
        let conn = home("t", &header("t"));
        fork_of_t(&conn);
        let (engine, shell) = engine_on(&conn);
        let core = engine.core();
        let result = core
            .with_state(|state| handle(core, state, &merge_command(false)))
            .expect("the state is free")
            .expect("receipt")
            .expect("a receipt");
        assert_eq!(result.get("ok"), Some(&Value::Bool(true)), "{result:?}");
        settle(&engine);
        let items = merged_events(&shell);
        assert_eq!(items.len(), 1);
        assert_eq!(intent_status(&conn).as_deref(), Some("done"));
        let core = engine.core();
        assert!(
            !core
                .with_state(|state| state.transition_guarded(&core.store, "t"))
                .expect("the state is free")
                .expect("guarded")
        );
    }

    // A crash between the merge's write and its settlement, then the same intent again: one
    // item, one context entry and one grant.
    #[test]
    fn retrying_a_merge_through_the_engine_writes_once() {
        let conn = home("t", &header("t"));
        fork_of_t(&conn);
        let (engine, shell) = engine_on(&conn);
        let core = engine.core();
        core.with_state(|state| handle(core, state, &merge_command(true)))
            .expect("the state is free")
            .expect("receipt")
            .expect("a receipt");
        settle(&engine);
        // The crash's trace: the intent is queued again, as a restart would find it.
        conn.exec("UPDATE intents SET status='pending' WHERE thread_id='t'")
            .expect("requeue");
        core.with_state(|state| crate::transitions::dispatch::run_thread(core, state, "t"))
            .expect("the state is free")
            .expect("retry");
        let created = merged_events(&shell)
            .iter()
            .filter(|(kind, _)| kind == "item.created")
            .count();
        assert_eq!(created, 1, "the retry writes no second item");
        let context = core
            .with_state(|state| state.transition_get(&core.store, "t"))
            .expect("the state is free")
            .expect("metadata")
            .context;
        assert_eq!(context.len(), 1);
        let grants = ace_store::stmt_cache::all_rows(
            &conn,
            "SELECT source FROM engine_handoff_grants WHERE recipient='t'",
            Vec::new(),
        )
        .expect("grants");
        assert_eq!(grants.len(), 1);
    }

    // `handler.ts:403`: a send aimed at a thread a checkout move guards is refused, and the
    // restart's prune is what frees it when that command never became an intent.
    #[test]
    fn a_competing_send_is_refused_while_a_checkout_move_holds_the_thread() {
        let conn = home("t", &header("t"));
        let (store, _shell) = Shell::store_with_controls(&conn);
        let mut state = crate::State::default();
        state.transitions.rebuilt.insert("t".to_owned());
        crate::moves::workspace::begin(
            &store,
            &mut state,
            "t",
            crate::moves::workspace::BeginRequest {
                command_id: "move-1",
                now: 5.0,
                reservation: &crate::moves::workspace::Reservation {
                    roots: vec!["/w".into()],
                    ..Default::default()
                },
                has_owned_work: &|_| false,
                canonicalize: &|path| path.to_owned(),
            },
        )
        .expect("begin");
        let send = ace_json::parse(
            r#"{"id":"send-1","deviceId":"d","payload":{"type":"thread.send","threadId":"t","input":[{"type":"text","text":"hi"}]}}"#,
        )
        .expect("command");
        let (engine, _shell) = engine_on(&conn);
        let core = engine.core();
        let result = core
            .with_state(|state| handle(core, state, &send))
            .expect("the state is free")
            .expect("receipt")
            .expect("a receipt");
        assert_eq!(
            result.get("error").and_then(Value::as_str),
            Some("thread_transition_in_progress")
        );
    }

    // A restart finds every queued merge, not only the first: each settles its own intent.
    #[test]
    fn a_restart_runs_every_queued_merge() {
        let conn = home("t", &header("t"));
        fork_of_t(&conn);
        conn.exec(&format!(
            "INSERT INTO threads (id, workspace_id, title, provider, status, created_at, updated_at, client) VALUES ('t3', 'workspace', 'Fork', 'claude', '{{\"state\":\"new\"}}', 0, 0, {})",
            sql_text(
                r#"{"lineage":{"parentThreadId":"t","parentAgentId":"root","point":{"type":"turn","runId":"r"},"mode":"portable","lossy":true}}"#
            )
        ))
        .expect("second fork");
        conn.exec(&format!(
            "INSERT INTO thread_state VALUES ('t3', {}, 0)",
            sql_text(&header("t3"))
        ))
        .expect("second fork state");
        conn.exec(&format!(
            "INSERT INTO items VALUES ('own3', 't3', 2, {})",
            sql_text(
                r#"{"id":"own3","agentId":"root","type":"message","role":"assistant","complete":true,"createdAt":1,"parts":[{"type":"text","text":"done"}]}"#
            )
        ))
        .expect("second item");
        for (thread, item) in [("t2", "own"), ("t3", "own3")] {
            let command = format!(
                r#"{{"id":"merge-{thread}","deviceId":"d","payload":{{"type":"thread.merge","threadId":"{thread}","summary":"s","citations":[{{"threadId":"{thread}","itemId":"{item}"}}]}}}}"#
            );
            conn.exec(&format!(
                "INSERT INTO intents (command_id,thread_id,kind,payload,status,position) VALUES ('merge-{thread}','t','thread.merge',{},'pending',1)",
                sql_text(&command)
            ))
            .expect("intent");
        }
        let (engine, shell) = engine_on(&conn);
        let core = engine.core();
        core.with_state(|state| crate::transitions::dispatch::recover_thread(core, state, "t"))
            .expect("the state is free")
            .expect("dispatch");
        let statuses = ace_store::stmt_cache::all_rows(
            &conn,
            "SELECT status FROM intents WHERE thread_id='t' ORDER BY id",
            Vec::new(),
        )
        .expect("intents")
        .iter()
        .map(|row| {
            row.get("status")
                .and_then(crate::repository::residency::cell_text)
                .unwrap_or_default()
                .to_owned()
        })
        .collect::<Vec<_>>();
        assert_eq!(statuses, ["done", "done"]);
        assert_eq!(merged_events(&shell).len(), 2, "both merges wrote an item");
    }

    // A merge that cannot land is terminal: the intent says why and the guards it held are
    // released in the same transaction, so nothing stays pending or guarded.
    #[test]
    fn a_merge_that_cannot_land_fails_and_releases_its_guards() {
        let conn = home("t", &header("t"));
        fork_of_t(&conn);
        conn.exec("INSERT INTO engine_transition_guards VALUES ('t','cmd-bad')")
            .expect("source guard");
        conn.exec("INSERT INTO engine_transition_guards VALUES ('t2','cmd-bad')")
            .expect("fork guard");
        conn.exec(&format!(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,position) VALUES ('cmd-bad','t','thread.merge',{},'pending',1)",
            sql_text(
                r#"{"id":"cmd-bad","deviceId":"d","payload":{"type":"thread.merge","threadId":"t2","summary":"s","citations":[{"threadId":"t2","itemId":"missing"}],"patch":"diff"}}"#
            )
        ))
        .expect("intent");
        let (engine, _shell) = engine_on(&conn);
        let core = engine.core();
        core.with_state(|state| crate::transitions::dispatch::recover_thread(core, state, "t"))
            .expect("the state is free")
            .expect("dispatch");
        assert_eq!(intent_status(&conn).as_deref(), Some("failed"));
        let failure = ace_store::stmt_cache::get_row(
            &conn,
            "SELECT error FROM intents WHERE command_id='cmd-bad'",
            Vec::new(),
        )
        .expect("intent")
        .and_then(|row| {
            row.get("error")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
        });
        assert_eq!(failure.as_deref(), Some("Citation does not belong to fork"));
        let guards = ace_store::stmt_cache::all_rows(
            &conn,
            "SELECT thread_id FROM engine_transition_guards WHERE command_id='cmd-bad'",
            Vec::new(),
        )
        .expect("guards");
        assert!(guards.is_empty(), "no thread stays guarded");
    }

    // A switch the receipt can validate is still refused: its execution needs E5.6's sessions
    // and models, and a success with nothing run would leave the thread as it was.
    #[test]
    fn a_switch_is_refused_until_its_execution_lands() {
        let conn = home("t", &header("t"));
        conn.exec("INSERT INTO engine_sessions (thread_id,cwd,model,native_session_id,backend,instance_id,options) VALUES ('t','/w',NULL,'native','acp','a',NULL)")
            .expect("session");
        let (engine, _shell) = engine_on(&conn);
        let core = engine.core();
        let switch = ace_json::parse(
            r#"{"id":"sw-1","deviceId":"d","payload":{"type":"thread.switch","threadId":"t","selection":{"provider":"codex"}}}"#,
        )
        .expect("command");
        let result = core
            .with_state(|state| handle(core, state, &switch))
            .expect("the state is free")
            .expect("receipt")
            .expect("a receipt");
        assert_eq!(result.get("ok"), Some(&Value::Bool(false)));
        assert!(
            result
                .get("error")
                .and_then(Value::as_str)
                .is_some_and(|error| error.contains("lands in E5.6")),
            "{result:?}"
        );
        assert_eq!(
            crate::intents::store::command_status(&conn, "sw-1").expect("status"),
            None,
            "no intent is queued for work nothing can run"
        );
    }

    // From `transition-regressions`: a patch merge waits for the source tree, and a first send
    // the provider accepted but has not started a run is still live work.
    #[test]
    fn a_patch_merge_refuses_a_source_whose_accepted_first_send_has_no_run() {
        let conn = home("t", &header("t"));
        fork_of_t(&conn);
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,awaiting,position) \
             VALUES ('send-1','t','thread.send','{\"type\":\"thread.send\"}','pending',1,1)",
        )
        .expect("awaiting send");
        let (engine, _shell) = engine_on(&conn);
        let core = engine.core();
        let result = core
            .with_state(|state| handle(core, state, &merge_command(true)))
            .expect("the state is free")
            .expect("receipt")
            .expect("a receipt");
        assert_eq!(
            result.get("error").and_then(Value::as_str),
            Some("source_tree_is_live")
        );
        assert!(
            !core
                .with_state(|state| state.transition_guarded(&core.store, "t"))
                .expect("the state is free")
                .expect("guarded"),
            "a refused merge holds no guard"
        );
    }
}
