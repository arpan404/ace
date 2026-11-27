// SPDX-License-Identifier: Apache-2.0
//! Children a usage limit stranded (`recover-limited-children.ts`): a parent's account move also
//! switches each limited child and queues it a continue, in commands whose ids make a replay
//! harmless.

use ace_json::Value;

use crate::{Core, EngineError, State};

const CONTINUE_TEXT: &str = "Continue your existing delegated task on the selected replacement provider. Preserve completed work and check unfinished operations before restarting them.";

/// `limitedChildren` (`:7`): captured before the source closes; working and manually stopped
/// children keep their owner.
pub fn limited_children(
    core: &Core,
    state: &mut State,
    thread: &str,
) -> Result<Vec<String>, EngineError> {
    let snapshot = state.repo.require_state(&core.store, thread)?;
    let children: Vec<String> = {
        let borrowed = snapshot.try_borrow().map_err(|_| EngineError::Reentrant)?;
        borrowed
            .state
            .agents
            .values()
            .filter(|record| {
                record
                    .external_status
                    .as_ref()
                    .is_some_and(|status| status.state() == "limited")
            })
            .filter_map(|record| record.agent.child_thread_id.clone())
            .collect()
    };
    let mut limited = Vec::new();
    for child in children {
        if super::threads::get(&core.store, &child)?.is_none() {
            continue;
        }
        if crate::queue::store::has_uncertain(core.store.conn(), &child)?
            || crate::intents::store::recovering(core.store.conn(), &child)?
        {
            continue;
        }
        let queue = crate::queue::store::get(&core.store, &child)?;
        if queue.paused && matches!(queue.reason.as_deref(), Some("manual") | Some("stopped")) {
            continue;
        }
        limited.push(child);
    }
    Ok(limited)
}

/// `recoverLimitedChildren` (`:24`): the parent's switch and these child commands commit together;
/// receipts make replay harmless. The first refusal is the caller's error, with its text.
pub fn recover_limited_children(
    core: &Core,
    children: &[String],
    selection: &Value,
    source: &Value,
    dispatch: &mut dyn FnMut(&Value) -> Result<Value, EngineError>,
) -> Result<(), EngineError> {
    let mut seen = Vec::new();
    let source_id = source.get("id").and_then(Value::as_str).unwrap_or_default();
    let device = source
        .get("deviceId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    for id in children {
        if seen.iter().any(|seen| seen == id) {
            continue;
        }
        seen.push(id.clone());
        let Some(current) = super::threads::get(&core.store, id)? else {
            continue;
        };
        if current.status.get("state").and_then(Value::as_str) != Some("limited") {
            continue;
        }
        let base = format!("{source_id}:child:{id}");
        let mut switched = ace_json::Map::new();
        switched.insert("id", Value::from(format!("{base}:switch")));
        switched.insert("deviceId", Value::from(device));
        let mut switch_payload = ace_json::Map::new();
        switch_payload.insert("type", Value::from("thread.switch"));
        switch_payload.insert("threadId", Value::from(id.as_str()));
        switch_payload.insert("selection", selection.clone());
        switched.insert("payload", Value::Object(switch_payload));
        let result = dispatch(&Value::Object(switched))?;
        if result.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(EngineError::Records(format!(
                "Could not switch limited child {id}: {}",
                result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )));
        }
        let mut sent = ace_json::Map::new();
        sent.insert("id", Value::from(format!("{base}:continue")));
        sent.insert("deviceId", Value::from(device));
        let mut send_payload = ace_json::Map::new();
        send_payload.insert("type", Value::from("thread.send"));
        send_payload.insert("threadId", Value::from(id.as_str()));
        send_payload.insert("delivery", Value::from("queue"));
        let mut part = ace_json::Map::new();
        part.insert("type", Value::from("text"));
        part.insert("text", Value::from(CONTINUE_TEXT));
        send_payload.insert("input", Value::Array(vec![Value::Object(part)].into()));
        sent.insert("payload", Value::Object(send_payload));
        let result = dispatch(&Value::Object(sent))?;
        if result.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(EngineError::Records(format!(
                "Could not continue limited child {id}: {}",
                result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
