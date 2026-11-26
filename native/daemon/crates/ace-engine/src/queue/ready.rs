// SPDX-License-Identifier: Apache-2.0
//! `message-facts.ts:42`-`:87` (E5.4f): the capabilities a thread's live provider reports, and
//! the queue's rule for sending a waiting input while no steer carries it.

use ace_core::state::ThreadState;
use ace_json::Value;

use crate::intents::header::IntentHeader;
use crate::{Core, EngineError, State};

/// `threadCapabilities`: the backend's capabilities when the thread's record can steer, and the
/// record's own otherwise. A thread whose record says it can't steer never steers.
pub fn thread_capabilities(
    core: &Core,
    state: &mut State,
    id: &str,
) -> Result<Option<Value>, EngineError> {
    let Some(thread) = crate::commands::prelude::thread_row(core, id)? else {
        return Ok(None);
    };
    let Some(provider) = thread.get("provider").and_then(Value::as_str) else {
        return Ok(None);
    };
    if !state.registry.has(provider) {
        return Ok(None);
    }
    let effective = thread.get("effectiveCapabilities").filter(|v| !v.is_null());
    let recorded = effective
        .or_else(|| thread.get("capabilities"))
        .cloned()
        .or_else(|| {
            state
                .registry
                .get(provider, None)
                .ok()
                .map(|entry| entry.capabilities.clone())
        });
    let Some(recorded) = recorded else {
        return Ok(None);
    };
    let steers = recorded
        .get("steer")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !steers || effective.is_some() {
        return Ok(Some(recorded));
    }
    let Ok(backend) = state.backend(&core.store, id) else {
        return Ok(Some(recorded));
    };
    Ok(state
        .registry
        .get(provider, backend.as_deref())
        .map(|entry| entry.capabilities.clone())
        .unwrap_or(recorded)
        .into())
}

/// `hasNextTurnSelection` (`input-delivery.ts`): the intent names a model or options.
pub fn has_selection(core: &Core, intent_id: i64) -> Result<bool, EngineError> {
    const SQL: &str = "SELECT json_type(payload,'$.payload.model') AS model,json_type(payload,'$.payload.options') AS options FROM intents WHERE id=?";
    let row = ace_store::stmt_cache::get_row(
        core.store.conn(),
        SQL,
        vec![ace_store::Value::Integer(intent_id)],
    )?;
    let present = |value: Option<&ace_store::Value>| {
        value.is_some_and(|value| !matches!(value, ace_store::Value::Null))
    };
    Ok(row.is_some_and(|row| present(row.get("model")) || present(row.get("options"))))
}

/// `readyForInput`: whether the sends lane may deliver this intent now.
pub fn ready_for_input(
    core: &Core,
    state: &mut State,
    intent: &IntentHeader,
) -> Result<bool, EngineError> {
    let thread = intent.thread_id.clone();
    if intent.trigger.as_deref() == Some("subagent_result") {
        let snapshot = state.repo.require_state(&core.store, &thread)?;
        let ready = ace_core::external::ready_for_child_results(&snapshot.borrow().state);
        return Ok(ready);
    }
    if crate::transitions::switch_ready::quiescent(core, state, &thread)? {
        return Ok(true);
    }
    let selection = has_selection(core, intent.id)?;
    if selection {
        let snapshot = state.repo.require_state(&core.store, &thread)?;
        if crate::transitions::switch_ready::runs_provider_work(&snapshot.borrow().state) {
            return Ok(false);
        }
    }
    // A replied thread reads done while the commands it left running still run (ADR 0116).
    let status = {
        let snapshot = state.repo.require_state(&core.store, &thread)?;
        let mut state_view: ThreadState = snapshot.borrow().state.clone();
        state_view.queue_count = state_view.queue_sources.provider;
        ace_core::status::derive_thread_status(&state_view)
    };
    if matches!(
        status,
        ace_core::status::ThreadStatus::New
            | ace_core::status::ThreadStatus::Done
            | ace_core::status::ThreadStatus::Failed
    ) {
        return Ok(true);
    }
    if intent.kind != "thread.send" || selection {
        return Ok(false);
    }
    let person = matches!(
        intent.trigger.as_deref(),
        None | Some("user") | Some("parent_agent")
    );
    if !person {
        return Ok(false);
    }
    let now = core.ports.now() as i64;
    crate::transitions::readiness::accepts_person_input(state, &thread, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::executor::{Notified, Notifier};
    use crate::repository::testsupport::{Shell, header, home};

    struct ManualPump;

    impl Notifier for ManualPump {
        fn notify(&self) -> Notified {
            Notified::Posted
        }
    }

    fn engine_on(conn: &std::sync::Arc<ace_store::Connection>) -> crate::Engine {
        let (_, shell) = Shell::store_with_controls(conn);
        crate::Engine::new(
            shell.clone(),
            shell,
            crate::Inputs::default(),
            "[]",
            Box::new(ManualPump),
            conn,
            std::rc::Rc::new(crate::actor::ActorDeps::production(
                std::rc::Rc::new(crate::frames::live::UnportedLive),
                0.0,
            )),
        )
        .expect("engine")
    }

    #[test]
    fn a_selection_is_the_intents_own_model_or_options() {
        let conn = home("t", &header("t"));
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position) VALUES
             ('plain','t','thread.send','{\"payload\":{\"type\":\"thread.send\",\"input\":[]}}','queued','queue',1),
             ('model','t','thread.send','{\"payload\":{\"type\":\"thread.send\",\"model\":\"m\",\"input\":[]}}','queued','queue',2),
             ('options','t','thread.send','{\"payload\":{\"type\":\"thread.send\",\"options\":{\"effort\":\"high\"},\"input\":[]}}','queued','queue',3)",
        )
        .unwrap();
        let engine = engine_on(&conn);
        let core = engine.core();
        assert!(!has_selection(core, 1).unwrap());
        assert!(has_selection(core, 2).unwrap());
        assert!(has_selection(core, 3).unwrap());
        assert!(!has_selection(core, 99).unwrap());
    }
}
