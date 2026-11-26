// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4d as a synchronous receipt dependency; owned by E5.9.
//!
//! `switch-admission.ts:48`-`:112` (`resolveSwitch`, `recordSwitch`): the receipt side of a
//! selecting steer. Executing the switch stays E5.9's.

use ace_json::Value;

use crate::{Core, EngineError, State};

/// The thread as it runs now, or the selection it moves to (`switch-route.ts:8`).
pub struct SwitchSide<'a> {
    pub provider: &'a str,
    pub instance_id: Option<&'a str>,
    pub backend: Option<&'a str>,
    pub acp_agent_id: Option<&'a str>,
}

/// `otherAccount`: a named account that differs from the current one.
fn other_account(current: &SwitchSide<'_>, next: &SwitchSide<'_>) -> bool {
    next.instance_id.is_some() && next.instance_id != current.instance_id
}

/// `switchRoute` (E5.4d, moving with the receipt's side of a switch).
pub fn switch_route(current: &SwitchSide<'_>, next: &SwitchSide<'_>) -> &'static str {
    let account_changed = other_account(current, next);
    if next.provider == "acp"
        && next.acp_agent_id.is_none()
        && (current.provider != "acp" || account_changed)
    {
        return "unsupported";
    }
    if current.backend == Some("cursor-sdk")
        && (next.provider != current.provider || account_changed)
    {
        return "new_thread";
    }
    if current.provider == "cursor" && next.provider == "cursor" && account_changed {
        return "new_thread";
    }
    "in_place"
}

/// What a thread runs on when it has never switched: its provider and its session metadata.
fn running(core: &Core, state: &mut State, id: &str) -> Result<Value, EngineError> {
    let provider = {
        let snapshot = state.repo.require_state(&core.store, id)?;
        snapshot.borrow().state.config.provider.clone()
    };
    let mut value = ace_json::Map::new();
    value.insert("provider", Value::from(provider.as_str()));
    value.insert("options", Value::Object(ace_json::Map::new()));
    if let Ok(session) = crate::sessions::metadata::session(&core.store, id) {
        if let Some(model) = session.model {
            value.insert("model", Value::from(model.as_str()));
        }
        if let Some(instance) = session.instance_id {
            value.insert("instanceId", Value::from(instance.as_str()));
        }
        if let Some(options) = session.options {
            value.insert("options", options);
        }
        if let Some(native) = session.native_session_id {
            value.insert("nativeSessionId", Value::from(native.as_str()));
        }
    }
    Ok(Value::Object(value))
}

/// `resolveSwitch` (`switch-admission.ts:48`): the selection a pending switch applies, or why
/// the thread can't take it. Nothing is written.
pub fn resolve_switch(
    core: &Core,
    state: &mut State,
    id: &str,
    requested: &Value,
    capabilities: impl Fn(&str) -> Value,
) -> Result<Result<Value, String>, EngineError> {
    let fallback = running(core, state, id)?;
    let selection = state.transition_selection(&core.store, id, &fallback, requested)?;
    let current = state
        .transition_get(&core.store, id)?
        .selection
        .unwrap_or(fallback);
    let provider = |value: &Value| {
        value
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let backend = state.session_backend(&core.store, id)?;
    let current_provider = provider(&current);
    let next_provider = provider(&selection);
    let route = switch_route(
        &SwitchSide {
            provider: &current_provider,
            instance_id: current.get("instanceId").and_then(Value::as_str),
            backend: backend.as_deref(),
            acp_agent_id: current.get("acpAgentId").and_then(Value::as_str),
        },
        &SwitchSide {
            provider: &next_provider,
            instance_id: selection.get("instanceId").and_then(Value::as_str),
            backend: None,
            acp_agent_id: requested.get("acpAgentId").and_then(Value::as_str),
        },
    );
    if route == "new_thread" {
        return Ok(Err("switch_requires_new_thread".to_owned()));
    }
    if route == "unsupported" {
        return Ok(Err("acp_identity_required".to_owned()));
    }
    let options = selection
        .get("options")
        .and_then(Value::as_object)
        .map(|options| options.len())
        .unwrap_or(0);
    if options > 0
        && capabilities(&next_provider)
            .get("sessionOptions")
            .and_then(Value::as_bool)
            != Some(true)
    {
        return Ok(Err("provider_options_unsupported".to_owned()));
    }
    for previous in crate::intents::header::headers(core.store.conn(), Some(id), None)? {
        if previous.kind == "thread.switch" && previous.status == "running" {
            return Ok(Err("switch_in_progress".to_owned()));
        }
    }
    Ok(Ok(selection))
}

/// `recordSwitch` (`:88`): the selection becomes the thread's one pending switch.
pub fn record_switch(
    core: &Core,
    state: &mut State,
    id: &str,
    selection: &Value,
    at: f64,
) -> Result<(), EngineError> {
    let fallback = running(core, state, id)?;
    let current = state.transition_get(&core.store, id)?.selection;
    let remembered = current.unwrap_or(fallback.clone());
    state.transition_remember(&core.store, id, &remembered)?;
    for previous in crate::intents::header::headers(core.store.conn(), Some(id), None)? {
        if previous.kind == "thread.switch" {
            crate::intents::lifecycle::mark(&core.store, &previous, "done", None)?;
        }
    }
    let provider = |value: &Value| {
        value
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let lossy = provider(selection) != provider(&fallback)
        || (provider(selection) == "acp"
            && selection.get("instanceId").and_then(Value::as_str)
                != fallback.get("instanceId").and_then(Value::as_str));
    let mut shown = ace_json::Map::new();
    shown.insert("selection", selection.clone());
    shown.insert("state", Value::from("queued"));
    shown.insert("lossy", Value::Bool(lossy));
    if lossy {
        shown.insert("recommendation", Value::from("delegate"));
    }
    shown.insert("at", Value::from(at));
    let mut event = ace_json::Map::new();
    event.insert("type", Value::from("thread.updated"));
    event.insert("switch", Value::Object(shown));
    let events = Value::Array(vec![Value::Object(event)].into());
    core.store
        .write_events(id, &ace_json::to_string(&events), at)?;
    Ok(())
}
