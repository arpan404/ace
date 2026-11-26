// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4d as a synchronous receipt dependency; owned by E5.5.
//!
//! `steer-selection.ts:20`-`:106`: a steer's fence, whether the run it named is gone, the split
//! of a selecting steer, and the switch it queues behind the send.

use ace_json::Value;

use crate::commands::{command_id, payload};use crate::transitions::switch_admission::{record_switch, resolve_switch};
use crate::{Core, EngineError, State};

/// A send ready to admit, and the pending switch split off it, if any.
#[derive(Debug, Clone)]
pub struct SteerAdmission {
    pub send: Value,
    pub selection: Option<(Value, Value)>,
}

/// `steerLostRun` (`:58`): the sender's run is not the active one (or, for `null`, one is).
pub fn steer_lost_run(
    core: &Core,
    state: &mut State,
    id: &str,
    run_id: Option<&str>,
) -> Result<bool, EngineError> {
    let snapshot = state.repo.require_state(&core.store, id)?;
    let (active, run_state) = {
        let borrowed = snapshot.borrow();
        let active = borrowed
            .state
            .root_key
            .as_deref()
            .and_then(|root| borrowed.state.agents.get(root))
            .and_then(|record| record.active_run.clone());
        let run_state = run_id
            .and_then(|run| borrowed.state.runs.get(run))
            .map(|run| run.state.clone());
        (active, run_state)
    };
    Ok(match run_id {
        None => active.is_some(),
        Some(run) => !(active.as_deref() == Some(run) && run_state.as_deref() == Some("active")),
    })
}

/// `fenceSteer` (`:20`): a steer aimed at a run that ended (or another that began) queues.
pub fn fence_steer(
    core: &Core,
    state: &mut State,
    command: &Value,
    id: &str,
) -> Result<Value, EngineError> {
    let p = payload(command);
    if p.get("type").and_then(Value::as_str) != Some("thread.send") {
        return Ok(command.clone());
    }
    let Some(run) = p.get("runId").map(|run| run.as_str().map(str::to_owned)) else {
        return Ok(command.clone());
    };
    if p.get("delivery").and_then(Value::as_str) == Some("steer")
        && !steer_lost_run(core, state, id, run.as_deref())?
    {
        return Ok(command.clone());
    }
    let mut stripped = p.clone();
    if let Some(map) = stripped.as_object_mut() {
        map.shift_remove("runId");
        if p.get("delivery").is_some() {
            map.insert("delivery", Value::from("queue"));
        }
    }
    let mut out = command.clone();
    if let Some(map) = out.as_object_mut() {
        map.insert("payload", stripped);
    }
    crate::intents::command::normalize(&out)
}

/// `activeRootRun` (`steer-selection.ts:71`): the root's running turn, or none between turns.
pub fn active_root_run(
    store: &crate::EngineStore,
    state: &mut State,
    id: &str,
) -> Result<Option<String>, EngineError> {
    let snapshot = state.repo.require_state(store, id)?;
    let active = {
        let borrowed = snapshot.borrow();
        borrowed
            .state
            .root_key
            .as_deref()
            .and_then(|root| borrowed.state.agents.get(root))
            .and_then(|record| record.active_run.clone())
    };
    Ok(active)
}

/// `aimSteerAtRun` (`:48`): a fresh steer is aimed at the turn the person is steering into, so
/// that once that turn ends the message queues instead of cancelling a later one. Only a session
/// that steers by cancelling the turn is aimed (`:57`); every other provider reads no run.
pub fn aim_steer_at_run(
    store: &crate::EngineStore,
    state: &mut State,
    command: &Value,
    id: &str,
    steers_by_cancel: bool,
) -> Result<Value, EngineError> {
    let p = payload(command);
    if p.get("type").and_then(Value::as_str) != Some("thread.send")
        || p.get("delivery").and_then(Value::as_str) != Some("steer")
        || p.get("runId").is_some()
        || !steers_by_cancel
    {
        return Ok(command.clone());
    }
    let run = active_root_run(store, state, id)?;
    let mut payload = p.clone();
    if let Some(map) = payload.as_object_mut() {
        map.insert("runId", run.map_or(Value::Null, Value::from));
    }
    let mut aimed = command.clone();
    if let Some(map) = aimed.as_object_mut() {
        map.insert("payload", payload);
    }
    crate::intents::command::normalize(&aimed)
}

/// `recordSteerAim` (`:78`): the turn an admitted steer went into, beside its payload. The
/// lane's cancel path reads it where a session has no payload target yet.
pub fn record_steer_aim(
    store: &crate::EngineStore,
    state: &mut State,
    intent: i64,
    id: &str,
    command: &Value,
) -> Result<(), EngineError> {
    let p = payload(command);
    if p.get("type").and_then(Value::as_str) != Some("thread.send")
        || p.get("delivery").and_then(Value::as_str) != Some("steer")
    {
        return Ok(());
    }
    let run = active_root_run(store, state, id)?;
    const RECORD: &str = "INSERT INTO engine_steer_aims(intent_id,run) VALUES (?,?) \
                          ON CONFLICT(intent_id) DO UPDATE SET run=excluded.run";
    ace_store::stmt_cache::run(
        store.conn(),
        RECORD,
        vec![
            ace_store::Value::Integer(intent),
            run.map_or(ace_store::Value::Null, ace_store::Value::Text),
        ],
    )?;
    Ok(())
}

/// `hasNextTurnSelection`: a model or options selection.
fn has_selection(p: &Value) -> bool {
    p.get("model").is_some() || p.get("options").is_some()
}

/// `admitSteer` (`:68`): a selecting steer splits while the tree works; otherwise it queues.
pub fn admit_steer(
    core: &Core,
    state: &mut State,
    command: &Value,
    id: &str,
) -> Result<SteerAdmission, EngineError> {
    let p = payload(command);
    if p.get("type").and_then(Value::as_str) != Some("thread.send")
        || p.get("delivery").and_then(Value::as_str) != Some("steer")
        || !has_selection(p)
    {
        return Ok(SteerAdmission {
            send: command.clone(),
            selection: None,
        });
    }
    let thread = crate::commands::prelude::thread_row(core, id)?;
    let capabilities = thread
        .as_ref()
        .and_then(|thread| {
            thread
                .get("effectiveCapabilities")
                .or_else(|| thread.get("capabilities"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    let can_steer = capabilities
        .get("steer")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let queued = thread
        .as_ref()
        .and_then(|thread| thread.get("switch"))
        .filter(|switch| switch.get("state").and_then(Value::as_str) == Some("queued"))
        .and_then(|switch| switch.get("selection"))
        .cloned();
    let mut current = match queued {
        Some(selection) => selection,
        None => match state.transition_get(&core.store, id)?.selection {
            Some(selection) => selection,
            None => {
                let provider = {
                    let snapshot = state.repo.require_state(&core.store, id)?;
                    snapshot.borrow().state.config.provider.clone()
                };
                let mut fallback = ace_json::Map::new();
                fallback.insert("provider", Value::from(provider.as_str()));
                fallback.insert("options", Value::Object(ace_json::Map::new()));
                if let Ok(session) = crate::sessions::metadata::session(&core.store, id) {
                    if let Some(model) = session.model {
                        fallback.insert("model", Value::from(model.as_str()));
                    }
                    if let Some(instance) = session.instance_id {
                        fallback.insert("instanceId", Value::from(instance.as_str()));
                    }
                    if let Some(options) = session.options {
                        fallback.insert("options", options);
                    }
                }
                Value::Object(fallback)
            }
        },
    };
    let mut requested = ace_json::Map::new();
    let provider = current
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    requested.insert("provider", Value::from(provider.as_str()));
    if let Some(instance) = current.get("instanceId") {
        requested.insert("instanceId", instance.clone());
    }
    let model = p.get("model").or_else(|| current.get("model"));
    if let Some(model) = model {
        requested.insert("model", model.clone());
    }
    if let Some(options) = p.get("options") {
        requested.insert("options", options.clone());
    }
    let requested = Value::Object(requested);
    let selection = if can_steer
        && !state.actor_quiescent(&core.store, id)?
        && state.repo.reserve(&core.store, id)?
    {
        resolve_switch(core, state, id, &requested, |_provider| {
            capabilities.clone()
        })?
    } else {
        Err("queued".to_owned())
    };
    let Ok(selection) = selection else {
        let mut queued = p.clone();
        if let Some(map) = queued.as_object_mut() {
            map.insert("delivery", Value::from("queue"));
        }
        current = command.clone();
        if let Some(map) = current.as_object_mut() {
            map.insert("payload", queued);
        }
        return Ok(SteerAdmission {
            send: crate::intents::command::normalize(&current)?,
            selection: None,
        });
    };
    let mut text = p.clone();
    if let Some(map) = text.as_object_mut() {
        map.shift_remove("model");
        map.shift_remove("options");
    }
    let mut send = command.clone();
    if let Some(map) = send.as_object_mut() {
        map.insert("payload", text);
    }
    let send = crate::intents::command::normalize(&send)?;
    let mut switch = ace_json::Map::new();
    switch.insert(
        "id",
        Value::from(format!("{}:selection", command_id(command))),
    );
    switch.insert(
        "deviceId",
        Value::from(
            command
                .get("deviceId")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ),
    );
    let mut switch_payload = ace_json::Map::new();
    switch_payload.insert("type", Value::from("thread.switch"));
    switch_payload.insert("threadId", Value::from(id));
    switch_payload.insert("selection", selection.clone());
    switch.insert("payload", Value::Object(switch_payload));
    Ok(SteerAdmission {
        send,
        selection: Some((
            crate::intents::command::normalize(&Value::Object(switch))?,
            selection,
        )),
    })
}

/// `queueSteerSelection` (`:100`): the switch goes right behind the send it was split from.
pub fn queue_steer_selection(
    core: &Core,
    state: &mut State,
    id: &str,
    admission: SteerAdmission,
    at: f64,
) -> Result<(), EngineError> {
    let Some((switch, selection)) = admission.selection else {
        return Ok(());
    };
    record_switch(core, state, id, &selection, at)?;
    crate::intents::lifecycle::add(&core.store, &switch, id, None, None)?;
    crate::intents::store::place_after(
        core.store.conn(),
        id,
        command_id(&switch),
        command_id(&admission.send),
    )
}

#[cfg(test)]
mod tests;
