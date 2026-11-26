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

/// `readMessageFacts` (`message-facts.ts:89`): what the engine knows about an accepted message
/// that decides when it reaches the model, read from the same checks the queue uses.
pub fn message_facts(
    core: &Core,
    state: &mut State,
    id: &str,
    command_id: &str,
) -> Result<Value, EngineError> {
    let capabilities = thread_capabilities(core, state, id)?;
    let conn = core.store.conn();
    let intent = crate::intents::store::delivery(conn, id, command_id)?;
    let queue = crate::queue::store::get(&core.store, id)?;
    let header = crate::intents::header::headers(conn, Some(id), None)?
        .into_iter()
        .find(|entry| entry.command_id == command_id);
    let waiting: Vec<String> = crate::queue::page::snapshot(&core.store, id)?
        .get("messages")
        .and_then(Value::as_array)
        .map(|messages| {
            messages
                .iter()
                .filter_map(|message| message.get("id").and_then(Value::as_str).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    let at = waiting.iter().position(|message| message == command_id);
    let restarts = capabilities
        .as_ref()
        .is_some_and(crate::steering::route::steer_restarts_turn);
    let person = match &header {
        None => true,
        Some(header) => crate::steering::route::is_person_steer(
            header,
            crate::steering::notes::person_chose(conn, header.id)?,
        ),
    };
    let fate = crate::inputs::fate::read(&core.store, id, command_id)?;
    let fate_state = fate
        .get("state")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_owned();
    let fate_error = fate.get("error").and_then(Value::as_str).map(str::to_owned);
    let snapshot = state.repo.state(&core.store, id)?;
    let has_state = snapshot.is_some();
    let turn_running = snapshot.as_ref().is_some_and(|snapshot| {
        crate::steering::route::root_run(&snapshot.borrow().state).is_some()
    });
    let accepts_input = match &header {
        None => true,
        Some(_) if !has_state => true,
        Some(header) => ready_for_input(core, state, header)?,
    };
    let steers = capabilities
        .as_ref()
        .and_then(|capabilities| capabilities.get("steer"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && (person || !restarts);
    let mut out = ace_json::Map::new();
    out.insert("fate", Value::from(fate_state.as_str()));
    if fate_state == "failed" {
        out.insert(
            "error",
            Value::from(fate_error.unwrap_or_default().as_str()),
        );
    }
    out.insert(
        "delivery",
        Value::from(
            intent
                .as_ref()
                .map_or("queue", |intent| intent.delivery.as_str()),
        ),
    );
    out.insert(
        "fromParent",
        Value::Bool(
            intent.as_ref().and_then(|intent| intent.trigger.as_deref()) == Some("parent_agent"),
        ),
    );
    out.insert(
        "ahead",
        Value::from(at.map_or(waiting.len(), |at| at) as f64),
    );
    out.insert(
        "held",
        Value::Bool(
            queue.paused
                || queue.limited
                || crate::intents::store::recovering(conn, id)?
                || crate::intents::store::recovery_acknowledgement(conn, id)?,
        ),
    );
    out.insert("turnRunning", Value::Bool(turn_running));
    out.insert("acceptsInput", Value::Bool(accepts_input));
    out.insert("steers", Value::Bool(steers));
    out.insert("restartsTurn", Value::Bool(restarts && person));
    Ok(Value::Object(out))
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

    fn facts(conn: &std::sync::Arc<ace_store::Connection>, command: &str) -> Value {
        let engine = engine_on(conn);
        let core = engine.core();
        core.with_state(|state| message_facts(core, state, "t", command))
            .unwrap()
            .unwrap()
    }

    fn send(command: &str, extra: &str) -> String {
        let payload = format!(
            r#"{{"id":"{command}","deviceId":"device","payload":{{"type":"thread.send","threadId":"t","input":[{{"type":"text","text":"hello"}}]}}}}"#
        );
        format!(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position{}) \
             VALUES ('{command}','t','thread.send','{payload}','pending','queue',1{})",
            if extra.is_empty() {
                ""
            } else {
                ",trigger,error"
            },
            if extra.is_empty() {
                String::new()
            } else {
                format!(",{extra}")
            }
        )
    }

    #[test]
    fn a_waiting_send_reads_waiting_and_the_queue_would_send_it() {
        let conn = home("t", &header("t"));
        conn.exec("INSERT INTO engine_queue (thread_id) VALUES ('t')")
            .unwrap();
        conn.exec(&send("c", "")).unwrap();
        let facts = facts(&conn, "c");
        assert_eq!(facts.get("fate").and_then(Value::as_str), Some("waiting"));
        assert_eq!(facts.get("delivery").and_then(Value::as_str), Some("queue"));
        assert_eq!(facts.get("ahead").and_then(Value::as_f64), Some(0.0));
        assert_eq!(facts.get("held"), Some(&Value::Bool(false)));
        assert_eq!(facts.get("turnRunning"), Some(&Value::Bool(false)));
        assert_eq!(facts.get("acceptsInput"), Some(&Value::Bool(true)));
        assert_eq!(facts.get("fromParent"), Some(&Value::Bool(false)));
        assert_eq!(facts.get("steers"), Some(&Value::Bool(false)));
        assert_eq!(facts.get("restartsTurn"), Some(&Value::Bool(false)));
    }

    #[test]
    fn a_parents_send_reads_from_parent_and_a_held_queue_reads_held() {
        let conn = home("t", &header("t"));
        conn.exec("INSERT INTO engine_queue (thread_id, paused, reason) VALUES ('t', 1, 'manual')")
            .unwrap();
        conn.exec(&send("c", "'parent_agent',NULL")).unwrap();
        let facts = facts(&conn, "c");
        assert_eq!(facts.get("fromParent"), Some(&Value::Bool(true)));
        assert_eq!(facts.get("held"), Some(&Value::Bool(true)));
        // A paused queue still accepts the input between turns; the hold is what stops it.
        assert_eq!(facts.get("acceptsInput"), Some(&Value::Bool(true)));
    }

    #[test]
    fn a_failed_input_carries_its_reason() {
        let conn = home("t", &header("t"));
        conn.exec("INSERT INTO engine_queue (thread_id) VALUES ('t')")
            .unwrap();
        conn.exec(
            "INSERT INTO intents (command_id,thread_id,kind,payload,status,delivery,position,error) \
             VALUES ('c','t','thread.send','{\"id\":\"c\",\"deviceId\":\"device\",\"payload\":{\"type\":\"thread.send\",\"threadId\":\"t\",\"input\":[{\"type\":\"text\",\"text\":\"hello\"}]}}','failed','queue',1,'Message not sent')",
        )
        .unwrap();
        let facts = facts(&conn, "c");
        assert_eq!(facts.get("fate").and_then(Value::as_str), Some("failed"));
        assert_eq!(
            facts.get("error").and_then(Value::as_str),
            Some("Message not sent")
        );
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
