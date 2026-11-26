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
use crate::transitions::switch_admission::{
    AgentChoice, record_switch, resolve_switch, switch_agent,
};
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
    let selection = match resolved {
        Ok(selection) => selection,
        Err(code) => return Ok(fail(id, &code)),
    };
    if !state.repo.reserve(&core.store, thread_id)? {
        return Ok(fail(id, "engine_capacity_exceeded"));
    }
    record_switch(core, state, thread_id, &selection, core.ports.now())?;
    crate::intents::lifecycle::add(&core.store, command, thread_id, None, None)?;
    Ok(ok(id, None))
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

    fn engine_on(conn: &Arc<ace_store::Connection>) -> Engine {
        let (_, shell) = Shell::store_with_controls(conn);
        Engine::new(
            shell.clone(),
            shell,
            Inputs::default(),
            "[]",
            Box::new(ManualPump),
            conn,
            Rc::new(crate::actor::ActorDeps::production(
                Rc::new(UnportedLive),
                0.0,
            )),
        )
        .expect("the test engine constructs")
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
        let engine = engine_on(&conn);
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
