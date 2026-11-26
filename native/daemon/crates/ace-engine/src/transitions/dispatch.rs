// SPDX-License-Identifier: Apache-2.0
//! Executes queued `thread.merge` and `thread.switch` intents after the receipt commits and on
//! restart, matching `IntentDelivery` (`intent-delivery.ts:84`).

use ace_json::Value;
use std::rc::Rc;

use crate::commands::{command_id, payload};
use crate::executor::Deferred;
use crate::intents::lifecycle::{self, mark};
use crate::transitions::execute::{self, MergeRequest};
use crate::transitions::metadata::admit_metadata;
use crate::transitions::metadata::metadata_json;
use crate::transitions::switch_admission::resolve_switch;
use crate::{Core, EngineError, EngineStore, State};

/// After a transition receipt commits, try to run the thread's queued transition intent.
pub fn schedule(core: &Rc<Core>, thread: &str) {
    let thread = thread.to_owned();
    let weak = Rc::downgrade(core);
    core.defer(Deferred::Run(Box::new(move || {
        if let Some(core) = weak.upgrade() {
            let _ = core.with_state(|state| run_thread(&core, state, &thread));
        }
    })));
}

/// On restart, resume any pending merge or switch for a recovered thread.
pub fn recover_thread(core: &Rc<Core>, state: &mut State, thread: &str) -> Result<(), EngineError> {
    run_thread(core, state, thread)
}

/// Claim and execute the next transition intent on `thread`, if any.
pub fn run_thread(core: &Rc<Core>, state: &mut State, thread: &str) -> Result<(), EngineError> {
    let Some(header) = crate::intents::store::transition(core.store.conn(), thread)? else {
        return Ok(());
    };
    let Some(intent) = lifecycle::claim(&core.store, &header)? else {
        return Ok(());
    };
    let command_id = intent.header.command_id.clone();
    let outcome = match intent.header.kind.as_str() {
        "thread.merge" => run_merge(core, state, &intent),
        "thread.switch" => run_switch(core, state, &intent),
        _ => Ok(()),
    };
    match outcome {
        Ok(()) => {
            if dispatch_store::command_status(core.store.conn(), &command_id)?
                == Some("running".to_owned())
            {
                mark(&core.store, &intent.header, "done", None)?;
            }
            let _ = state.transition_release_guards(&core.store, &command_id);
        }
        Err(error) => {
            mark(
                &core.store,
                &intent.header,
                "failed",
                Some(&error.to_string()),
            )?;
            let _ = state.transition_release_guards(&core.store, &command_id);
        }
    }
    Ok(())
}

fn run_merge(
    core: &Rc<Core>,
    state: &mut State,
    intent: &crate::intents::header::Intent,
) -> Result<(), EngineError> {
    let command = &intent.command;
    let fork = payload(command)
        .get("threadId")
        .and_then(Value::as_str)
        .ok_or_else(|| EngineError::Records("merge payload".into()))?;
    let summary = payload(command)
        .get("summary")
        .cloned()
        .unwrap_or(Value::Null);
    let citations = payload(command)
        .get("citations")
        .cloned()
        .unwrap_or(Value::Array(vec![].into()));
    let patch = payload(command).get("patch").filter(|p| !p.is_null());
    execute::merge(
        &core.store,
        state,
        &intent.header.thread_id,
        fork,
        MergeRequest {
            summary: &summary,
            citations: &citations,
            intent_id: intent.header.id,
            patch_applied: patch.is_some(),
            now: core.ports.now(),
        },
    )
}

fn run_switch(
    core: &Rc<Core>,
    state: &mut State,
    intent: &crate::intents::header::Intent,
) -> Result<(), EngineError> {
    let command = &intent.command;
    let thread = &intent.header.thread_id;
    let selection = payload(command)
        .get("selection")
        .cloned()
        .unwrap_or(Value::Null);
    let resolved = resolve_switch(
        core,
        state,
        thread,
        &selection,
        |_| ace_json::json!({ "resume": true, "sessionOptions": true }),
    )?;
    let selection = resolved.map_err(EngineError::Records)?;
    state.transition_admit_model(&core.store, thread, &selection)?;
    let previous = state.transition_get(&core.store, thread)?;
    let mut metadata = metadata_json(&previous);
    metadata.insert("selection", selection.clone());
    let admitted = admit_metadata(&Value::Object(metadata.clone()))?;
    dispatch_store::atomic_set_session_selection(&core.store, thread, &selection)?;
    state.transition_set(
        &core.store,
        thread,
        &Value::Object(metadata_json(&admitted)),
    )?;
    state.transition_remember(&core.store, thread, &selection)?;
    apply_switch_applied(core, state, thread, &selection, command_id(command))
}

fn apply_switch_applied(
    core: &Rc<Core>,
    _state: &mut State,
    thread: &str,
    selection: &Value,
    command: &str,
) -> Result<(), EngineError> {
    let provider = selection
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut shown = ace_json::Map::new();
    shown.insert("selection", selection.clone());
    shown.insert("state", Value::from("applied"));
    shown.insert("lossy", Value::Bool(false));
    shown.insert("at", Value::from(core.ports.now()));
    let mut event = ace_json::Map::new();
    event.insert("type", Value::from("thread.updated"));
    event.insert("provider", Value::from(provider));
    event.insert("switch", Value::Object(shown));
    event.insert(
        "execution",
        Value::Object({
            let mut map = ace_json::Map::new();
            map.insert("provider", Value::from(provider));
            if let Some(model) = selection.get("model") {
                map.insert("model", model.clone());
            }
            map
        }),
    );
    let payload = ace_json::to_string(&Value::Array(vec![Value::Object(event)].into()));
    core.store
        .write_events(thread, &payload, core.ports.now())?;
    let _ = command;
    Ok(())
}

mod dispatch_store {
    use super::*;

    pub fn command_status(
        conn: &std::sync::Arc<ace_store::Connection>,
        command_id: &str,
    ) -> Result<Option<String>, EngineError> {
        const SQL: &str = "SELECT status FROM intents WHERE command_id=? LIMIT 1";
        let row = ace_store::stmt_cache::get_row(
            conn,
            SQL,
            vec![ace_store::Value::Text(command_id.to_owned())],
        )?;
        Ok(row.and_then(|row| {
            row.get("status")
                .and_then(crate::repository::residency::cell_text)
                .map(str::to_owned)
        }))
    }

    pub fn atomic_set_session_selection(
        store: &EngineStore,
        thread: &str,
        selection: &Value,
    ) -> Result<(), EngineError> {
        let model = selection
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let instance = selection
            .get("instanceId")
            .and_then(Value::as_str)
            .map(str::to_owned);
        let provider = selection
            .get("provider")
            .and_then(Value::as_str)
            .ok_or_else(|| EngineError::Records("selection".into()))?;
        store.atomic(|_tx| {
            ace_store::stmt_cache::run(
                store.conn(),
                "UPDATE engine_sessions SET model=?,instance_id=? WHERE thread_id=?",
                vec![
                    model.map_or(ace_store::Value::Null, ace_store::Value::Text),
                    instance.map_or(ace_store::Value::Null, ace_store::Value::Text),
                    ace_store::Value::Text(thread.to_owned()),
                ],
            )?;
            let _ = provider;
            Ok(())
        })
    }
}
