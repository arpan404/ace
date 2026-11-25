// SPDX-License-Identifier: Apache-2.0
//! `queue-commands.ts` (E5.4d): the queue receipts and compare-and-swap edits, inside the
//! engine transaction. Every branch is the TypeScript's, in its order.

use ace_json::Value;

use super::page::{editable, head};
use crate::commands::{command_id, error, payload, payload_type};
use crate::queue::{holds, store, write};
use crate::{Core, EngineError, State};

/// `handleQueue` (`queue-commands.ts:17`): a queue command's result, or none for another type.
pub fn handle(
    core: &Core,
    state: &mut State,
    command: &Value,
) -> Result<Option<Value>, EngineError> {
    let kind = payload_type(command);
    if !kind.starts_with("queue.") && kind != "thread.resume" && kind != "thread.limit" {
        return Ok(None);
    }
    let id = command_id(command).to_owned();
    let p = payload(command).clone();
    let fail = |code: &str| error(&id, code);
    let Some(thread) = p.get("threadId").and_then(Value::as_str).map(str::to_owned) else {
        return Ok(Some(fail("invalid_queue_command")));
    };
    if p.get("expectedRevision").is_none() {
        return Ok(Some(fail("invalid_queue_command")));
    }
    if state.repo.state(&core.store, &thread)?.is_none() {
        return Ok(Some(fail("thread_not_found")));
    }
    let result = core
        .store
        .atomic(|_tx| run(core, state, command, &thread, &p, &id))?;
    Ok(Some(result))
}

fn run(
    core: &Core,
    state: &mut State,
    command: &Value,
    thread: &str,
    p: &Value,
    id: &str,
) -> Result<Value, EngineError> {
    let kind = payload_type(command);
    let now = core.ports.now();
    let fail = |code: &str| error(id, code);
    let queue = store::get(&core.store, thread)?;
    let expected = p
        .get("expectedRevision")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if expected != queue.revision {
        return Ok(fail("queue_conflict"));
    }
    let message = p.get("messageId").and_then(Value::as_str);
    let entry = match message {
        Some(message) => editable(&core.store, thread, message)?,
        None => None,
    };
    if message.is_some() && entry.is_none() {
        return Ok(fail("message_already_claimed"));
    }
    let entry_id = entry.as_ref().map(|(intent, _, _)| *intent);
    // A failed send keeps its message at the head of a held queue; removing or editing that
    // message releases the hold, so the head is tried in order.
    let releases_hold = entry_id.is_some()
        && queue.paused
        && matches!(
            queue.reason.as_deref(),
            Some("not_sent") | Some("model_unavailable")
        )
        && queue.continuation.is_none()
        && !queue.limited
        && head(&core.store, thread)? == entry_id;
    let release = || {
        write::set(
            &core.store,
            thread,
            r#"{"paused":false,"reason":null}"#,
            now,
        )
    };
    match kind {
        "queue.edit" if entry.is_some() => {
            let Some((intent, old, uncertain)) = entry.clone() else {
                return Ok(fail("message_already_claimed"));
            };
            if uncertain {
                return Ok(fail("uncertain_delivery"));
            }
            if ace_json::to_string(p).len() > 256 * 1024 {
                return Ok(fail("message_too_large"));
            }
            let old_payload = old.get("payload").cloned().unwrap_or(Value::Null);
            let old_kind = old_payload
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if old_kind != "thread.send" && old_kind != "thread.create" {
                return Ok(fail("invalid_queue_entry"));
            }
            let input = p.get("input").cloned().unwrap_or(Value::Null);
            let context = crate::rules::edited_context(
                old_payload.get("input").unwrap_or(&Value::Null),
                old_payload.get("context"),
                &input,
                p.get("context"),
            );
            let mut payload = old_payload.clone();
            if let Some(map) = payload.as_object_mut() {
                map.shift_remove("context");
                map.insert("input", input);
                if let Some(context) = context {
                    map.insert("context", context);
                }
                if old_kind == "thread.send" {
                    let delivery = p.get("delivery").or_else(|| old_payload.get("delivery"));
                    if let Some(delivery) = delivery {
                        map.insert("delivery", delivery.clone());
                    }
                }
            }
            let mut edited_command = old.clone();
            if let Some(map) = edited_command.as_object_mut() {
                map.insert("payload", payload);
            }
            let steer =
                crate::steering::selection::admit_steer(core, state, &edited_command, thread)?;
            let edited = steer.send.clone();
            crate::queue::messages::edit(core.store.conn(), intent, &edited, thread)?;
            let steered = p.get("delivery").and_then(Value::as_str) == Some("steer")
                && edited
                    .get("payload")
                    .and_then(|payload| payload.get("type"))
                    .and_then(Value::as_str)
                    == Some("thread.send")
                && edited
                    .get("payload")
                    .and_then(|payload| payload.get("delivery"))
                    .and_then(Value::as_str)
                    == Some("steer");
            if steered {
                let device = command
                    .get("deviceId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if ["ace-agent", "ace-reviewer", "engine"].contains(&device) {
                    crate::steering::notes::steered_again(core.store.conn(), intent)?;
                } else {
                    crate::steering::notes::person_steered(core.store.conn(), intent)?;
                }
            }
            state.revise_input(&core.store, &edited, thread, now)?;
            crate::steering::selection::queue_steer_selection(core, state, thread, steer, now)?;
            if releases_hold {
                release()?;
            }
        }
        "queue.remove" if entry.is_some() => {
            let Some((intent, stored, _)) = entry.clone() else {
                return Ok(fail("message_already_claimed"));
            };
            crate::queue::messages::remove(core.store.conn(), intent)?;
            state.remove_input(
                &core.store,
                thread,
                crate::commands::command_id(&stored),
                now,
            )?;
            if releases_hold {
                release()?;
            }
            let stored_kind = stored
                .get("payload")
                .and_then(|payload| payload.get("type"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            if ["thread.resume", "queue.resume", "thread.limit"].contains(&stored_kind) {
                crate::intents::store::finish_continuation(core.store.conn(), thread)?;
                write::set(
                    &core.store,
                    thread,
                    r#"{"continuation":null,"trigger":null}"#,
                    now,
                )?;
            }
        }
        "queue.resend" if entry.is_some() => {
            let Some((intent, stored, uncertain)) = entry.clone() else {
                return Ok(fail("message_already_claimed"));
            };
            if !uncertain {
                return Ok(fail("message_not_uncertain"));
            }
            let old = stored.get("payload").cloned().unwrap_or(Value::Null);
            let old_kind = old.get("type").and_then(Value::as_str).unwrap_or_default();
            let continuation =
                ["thread.resume", "queue.resume", "thread.limit"].contains(&old_kind);
            let held_continuation =
                continuation && queue.paused && queue.reason.as_deref() != Some("uncertain");
            if old_kind != "thread.create" && old_kind != "thread.send" && !continuation {
                return Ok(fail("invalid_queue_entry"));
            }
            if continuation && !held_continuation && !state.repo.reserve(&core.store, thread)? {
                return Ok(fail("engine_capacity_exceeded"));
            }
            let payload = if old_kind == "thread.create" || old_kind == "thread.send" {
                let mut payload = ace_json::Map::new();
                payload.insert("type", Value::from("thread.send"));
                payload.insert("threadId", Value::from(thread));
                for key in ["input", "context", "origin", "trigger"] {
                    if let Some(value) = old.get(key) {
                        payload.insert(key, value.clone());
                    }
                }
                let delivery = if old_kind == "thread.send" {
                    old.get("delivery").cloned()
                } else {
                    None
                };
                payload.insert("delivery", delivery.unwrap_or_else(|| Value::from("queue")));
                Value::Object(payload)
            } else {
                let mut payload = ace_json::Map::new();
                payload.insert("type", Value::from("queue.resume"));
                payload.insert("threadId", Value::from(thread));
                payload.insert("expectedRevision", Value::from(queue.revision as f64));
                Value::Object(payload)
            };
            let mut replacement = command.clone();
            if let Some(map) = replacement.as_object_mut() {
                map.insert("payload", payload);
            }
            crate::queue::messages::remove(core.store.conn(), intent)?;
            state.remove_input(
                &core.store,
                thread,
                crate::commands::command_id(&stored),
                now,
            )?;
            if !continuation {
                let replacement_id = command_id(&replacement).to_owned();
                let stored_id = crate::commands::command_id(&stored).to_owned();
                crate::inputs::journal::replace(
                    core.store.conn(),
                    thread,
                    &stored_id,
                    &replacement_id,
                )?;
            }
            if continuation {
                crate::intents::store::finish_continuation(core.store.conn(), thread)?;
            }
            if !held_continuation {
                crate::intents::lifecycle::add(&core.store, &replacement, thread, None, None)?;
            }
            if !continuation {
                state.accept_input(&core.store, &replacement, thread, now)?;
            }
            if queue.reason.as_deref() == Some("uncertain")
                && !store::has_uncertain(core.store.conn(), thread)?
                && !queue.limited
                && queue.continuation.is_none()
            {
                release()?;
            }
        }
        "queue.move" if entry.is_some() => {
            if store::has_uncertain(core.store.conn(), thread)? {
                return Ok(fail("uncertain_delivery"));
            }
            let Some((intent, _, _)) = entry.clone() else {
                return Ok(fail("message_already_claimed"));
            };
            let after = match p.get("after") {
                Some(Value::Null) | None => Some(None),
                Some(Value::String(after)) => {
                    editable(&core.store, thread, after)?.map(|(id, _, _)| Some(id))
                }
                _ => None,
            };
            let Some(after) = after else {
                return Ok(fail("invalid_queue_position"));
            };
            if !crate::queue::messages::move_message(core.store.conn(), thread, intent, after)? {
                return Ok(fail("invalid_queue_position"));
            }
        }
        "queue.pause" => {
            for intent in crate::intents::header::headers(core.store.conn(), Some(thread), None)? {
                if intent.status == "pending"
                    && ["thread.resume", "queue.resume", "thread.limit"]
                        .contains(&intent.kind.as_str())
                {
                    crate::intents::lifecycle::mark(
                        &core.store,
                        &intent,
                        "failed",
                        Some("Cancelled by queue pause"),
                    )?;
                }
            }
            let mut patch = format!(
                r#"{{"paused":true,"reason":"manual","resumeAt":null,"timerAction":null,"holdToken":{}}}"#,
                queue.hold_token + 1
            );
            if !queue.limited {
                patch.insert_str(patch.len() - 1, r#","resetAt":null"#);
            }
            write::set(&core.store, thread, &patch, now)?;
            holds::schedule(core)?;
            holds::wake(core, thread);
            return Ok(crate::commands::ok(id, None));
        }
        "thread.limit" | "thread.resume" | "queue.resume" => {
            return crate::queue::resume::limit_or_resume(
                core, state, command, thread, p, id, &queue, now, kind,
            );
        }
        _ => return Ok(fail("invalid_queue_command")),
    }
    let staged = write::reconcile_uncertainty(&core.store, thread, now)?;
    write::finish(&core.store, &staged)?;
    holds::sync(core, state, thread, now)?;
    if state.repo.reserved_slot(&core.store, thread)?
        || (!store::get(&core.store, thread)?.paused && state.repo.reserve(&core.store, thread)?)
    {
        holds::wake(core, thread);
    }
    Ok(crate::commands::ok(id, None))
}
