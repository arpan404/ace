// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4d as a synchronous receipt dependency; owned by E5.10.
//!
//! `stop-intents.ts:5`-`:106` (`cancelPending`, `cancelDelegatedInputs`): what a Stop cancels,
//! defers or leaves for the person, and the guards its fallbacks release.

use ace_json::Value;
use std::collections::HashSet;

use crate::snapshot::touched::Touched;
use crate::{Core, EngineError, State};

const CANCELLED: &str = "Cancelled before delivery";

/// `cancelPending` (`:5`): the threads whose transition guards the Stop released.
pub fn cancel_pending(
    core: &Core,
    state: &mut State,
    id: &str,
    now: f64,
) -> Result<Vec<String>, EngineError> {
    core.store.atomic(|_tx| {
        let mut released: Vec<String> = Vec::new();
        let mut release = |threads: Vec<String>| {
            for thread in threads {
                if !released.contains(&thread) {
                    released.push(thread);
                }
            }
        };
        let headers = crate::intents::header::headers(core.store.conn(), Some(id), None)?;
        for intent in &headers {
            if !matches!(intent.status.as_str(), "pending" | "queued") {
                continue;
            }
            if matches!(
                intent.kind.as_str(),
                "thread.resume" | "queue.resume" | "thread.limit"
            ) {
                // Stop supersedes recovery authorized before its hold token; the durable
                // continuation stays for an explicit Resume.
                crate::intents::lifecycle::mark(&core.store, intent, "failed", Some(CANCELLED))?;
                continue;
            }
            // Stop ends execution, not the replacement provider the person already selected.
            if intent.kind != "thread.merge" {
                continue;
            }
            crate::intents::lifecycle::mark(&core.store, intent, "failed", Some(CANCELLED))?;
            release(state.transition_release_guards(&core.store, &intent.command_id)?);
        }
        // Fork intents belong to their new thread, never to the lineage source.
        for intent in &headers {
            if intent.kind != "thread.fork" || intent.status == "running" {
                continue;
            }
            release(state.transition_release_guards(&core.store, &intent.command_id)?);
        }
        let snapshot = state.repo.require_state(&core.store, id)?;
        let (active_runs, run_keys) = {
            let borrowed = snapshot.borrow();
            let runs: HashSet<String> = borrowed
                .state
                .agents
                .values()
                .filter_map(|record| record.active_run.clone())
                .collect();
            let list: Vec<String> = runs.iter().cloned().collect();
            (runs, list)
        };
        let mut stopped: Vec<Value> = Vec::new();
        let in_run_keys = crate::inputs::journal::in_runs(core.store.conn(), id, &run_keys)?;
        {
            let mut borrowed = snapshot
                .try_borrow_mut()
                .map_err(|_| EngineError::Reentrant)?;
            let mut touched = Touched::default();
            touched.items.extend(in_run_keys.iter().cloned());
            let keys: Vec<String> = headers
                .iter()
                .filter(|intent| {
                    matches!(
                        intent.kind.as_str(),
                        "thread.send" | "thread.create" | "thread.fork"
                    )
                })
                .map(|intent| format!("input:{}", intent.command_id))
                .collect();
            touched.items.extend(keys);
            borrowed.hydrate(&touched)?;
            for key in &in_run_keys {
                if let Some(item) = borrowed.state.items.get_mut(key)
                    && let ace_core::items::Item::Message {
                        base,
                        role,
                        not_answered,
                        ..
                    } = item
                    && role == "user"
                    && base
                        .run_id
                        .as_ref()
                        .is_some_and(|run| active_runs.contains(run))
                {
                    *not_answered = Some("stopped".to_owned());
                    stopped.push(item_updated(item));
                }
            }
            for intent in &headers {
                if intent.status != "running" && !intent.awaiting {
                    continue;
                }
                if !matches!(
                    intent.kind.as_str(),
                    "thread.send" | "thread.create" | "thread.fork"
                ) {
                    continue;
                }
                if intent.submitted_generation.is_none() && !intent.acknowledged {
                    crate::intents::lifecycle::defer(core.store.conn(), intent)?;
                    continue;
                }
                let key = format!("input:{}", intent.command_id);
                if let Some(item) = borrowed.state.items.get_mut(&key)
                    && let ace_core::items::Item::Message { not_answered, .. } = item
                    && not_answered.is_none()
                {
                    *not_answered = Some("stopped".to_owned());
                    stopped.push(item_updated(item));
                }
                crate::intents::lifecycle::mark(&core.store, intent, "failed", Some(CANCELLED))?;
            }
            if !stopped.is_empty() {
                let payloads = ace_json::to_string(&Value::Array(stopped.into()));
                let touched = {
                    let mut touched = Touched::default();
                    for key in headers
                        .iter()
                        .filter(|intent| intent.status == "running" || intent.awaiting)
                        .map(|intent| format!("input:{}", intent.command_id))
                    {
                        touched.items.insert(key);
                    }
                    touched
                };
                drop(borrowed);
                state.save(&core.store, id, &snapshot, &payloads, now, &touched)?;
            }
        }
        crate::queue::write::set(&core.store, id, "{}", now)?;
        Ok(released)
    })
}

/// `cancelDelegatedInputs` (`:78`): retire a subtree's work, switching provider included.
pub fn cancel_delegated_inputs(
    core: &Core,
    state: &mut State,
    id: &str,
    now: f64,
) -> Result<Vec<String>, EngineError> {
    core.store.atomic(|_tx| {
        let mut released = cancel_pending(core, state, id, now)?;
        for intent in crate::intents::header::headers(core.store.conn(), Some(id), None)? {
            let live = matches!(
                intent.kind.as_str(),
                "thread.send" | "thread.create" | "thread.fork" | "thread.switch"
            ) && (matches!(intent.status.as_str(), "pending" | "queued" | "running")
                || intent.awaiting);
            if !live {
                continue;
            }
            crate::intents::lifecycle::mark(&core.store, &intent, "failed", Some(CANCELLED))?;
            crate::queue::messages::prune(core.store.conn(), intent.id)?;
            if intent.kind != "thread.switch" {
                continue;
            }
            for thread in state.transition_release_guards(&core.store, &intent.command_id)? {
                if !released.contains(&thread) {
                    released.push(thread);
                }
            }
            let pending = crate::commands::prelude::thread_row(core, id)?
                .and_then(|row| row.get("switch").cloned());
            if pending
                .as_ref()
                .and_then(|switch| switch.get("state"))
                .and_then(Value::as_str)
                == Some("queued")
                && let Some(mut shown) = pending
                    .as_ref()
                    .and_then(|switch| switch.as_object())
                    .cloned()
            {
                shown.insert("state", Value::from("failed"));
                shown.insert("error", Value::from(CANCELLED));
                shown.insert("at", Value::from(now));
                let mut event = ace_json::Map::new();
                event.insert("type", Value::from("thread.updated"));
                event.insert("switch", Value::Object(shown));
                let events = Value::Array(vec![Value::Object(event)].into());
                core.store
                    .write_events(id, &ace_json::to_string(&events), now)?;
            }
        }
        crate::queue::write::set(&core.store, id, "{}", now)?;
        Ok(released)
    })
}

/// One user message's `item.updated` event with its stopped marker.
fn item_updated(item: &ace_core::items::Item) -> Value {
    let text = ace_json::ser::to_string(item).unwrap_or_default();
    let value = ace_json::parse(&text).unwrap_or(Value::Null);
    let mut event = ace_json::Map::new();
    event.insert("type", Value::from("item.updated"));
    event.insert("item", value);
    Value::Object(event)
}
