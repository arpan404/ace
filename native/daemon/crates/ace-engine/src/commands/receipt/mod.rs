// SPDX-License-Identifier: Apache-2.0
//! The receipt's thread commands (`handler.ts:376`-`:556`, `:562`-`:591`, E5.4e): the checks a
//! thread command makes, and the admission tail every accepted input shares.
//!
//! A refusal is a `CommandResult` and commits; a stub throws and the shell rolls back. Nothing
//! outside the database happens here: every wake, the deadline's arming and the naming prompt go
//! on the after-commit queue.

use ace_json::Value;

use crate::commands::create::Context;
use crate::commands::{command_id, error, ok, payload, payload_type};
use crate::steering::selection::{admit_steer, fence_steer, queue_steer_selection};
use crate::{Core, EngineError, State};

/// `changesWork` (`thread-fence.ts:70`): events that never start or add work.
const INERT: [&str; 9] = [
    "item.delta",
    "item.updated",
    "item.deleted",
    "run.ended",
    "run.client.updated",
    "agent.status",
    "agent.updated",
    "interaction.closed",
    "background_task.updated",
];

/// `thread.updated` fields that describe the thread without changing what runs in it.
const INERT_THREAD_FIELDS: [&str; 11] = [
    "type",
    "title",
    "titleSource",
    "archivedAt",
    "status",
    "permission",
    "capabilities",
    "effectiveCapabilities",
    "acpSupport",
    "goal",
    "details",
];

/// `thread.client.updated` fields: organization, read state and the list's projections.
const INERT_CLIENT_FIELDS: [&str; 24] = [
    "pinned",
    "pinOrder",
    "listOrder",
    "unread",
    "readAt",
    "settledAt",
    "settledReason",
    "settledOverQueue",
    "snoozedUntil",
    "snoozeWake",
    "snoozeWoke",
    "deletedAt",
    "activityAt",
    "autoSettleAt",
    "autoSettle",
    "settleWhenDone",
    "prSettled",
    "prSettledKey",
    "activitySeq",
    "hasSentMessage",
    "details",
    "live",
    "movedFrom",
    "hostKey",
];

/// `changesWork`: whether one stored event may be work the person didn't see.
pub fn changes_work(kind: &str, payload: &Value) -> bool {
    if INERT.contains(&kind) {
        return false;
    }
    let keys = |value: Option<&Value>| {
        value
            .and_then(Value::as_object)
            .map(|map| map.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    if kind == "thread.updated" {
        return keys(Some(payload))
            .iter()
            .any(|key| !INERT_THREAD_FIELDS.contains(&key.as_str()));
    }
    if kind == "thread.client.updated" {
        return keys(payload.get("changes"))
            .iter()
            .any(|key| !INERT_CLIENT_FIELDS.contains(&key.as_str()));
    }
    if kind == "item.created" {
        let item = payload.get("item");
        return item
            .and_then(|item| item.get("type"))
            .and_then(Value::as_str)
            == Some("message")
            && item
                .and_then(|item| item.get("role"))
                .and_then(Value::as_str)
                == Some("user")
            && item.and_then(|item| item.get("synthetic")) != Some(&Value::Bool(true));
    }
    true
}

/// `releaseInterruptedHold` (`handler.ts:562`): a new message is the go-ahead past a stop.
fn release_interrupted_hold(
    core: &Core,
    thread: &str,
    backend: &str,
    at: f64,
) -> Result<(), EngineError> {
    let queue = crate::queue::store::get(&core.store, thread)?;
    if !queue.paused || queue.limited {
        return Ok(());
    }
    if !matches!(queue.reason.as_deref(), Some("restart") | Some("stopped")) {
        return Ok(());
    }
    if crate::queue::store::has_uncertain(core.store.conn(), thread)?
        || crate::intents::store::recovering(core.store.conn(), thread)?
    {
        return Ok(());
    }
    if queue.reason.as_deref() == Some("restart") && backend == "cursor-sdk" {
        return Ok(());
    }
    crate::intents::store::finish_continuation(core.store.conn(), thread)?;
    let patch = format!(
        r#"{{"paused":false,"reason":null,"continuation":null,"trigger":null,"holdToken":{}}}"#,
        queue.hold_token + 1
    );
    crate::queue::write::set(&core.store, thread, &patch, at)
}

/// `stopsOneAgent` (`:583`): whether an interrupt names one of the thread's agents but its root.
fn stops_one_agent(
    state: &mut State,
    core: &Core,
    thread: &str,
    agent: Option<&str>,
) -> Result<bool, EngineError> {
    let snapshot = state.repo.require_state(&core.store, thread)?;
    let root = snapshot.borrow().root_agent_id();
    Ok(!crate::liveness::stop_scope::targets_root(
        agent,
        root.as_deref(),
    ))
}

/// The `limit.cleared` facts a Stop writes for every limited agent without an external status.
fn cleared_limits(state: &mut State, core: &Core, thread: &str) -> Result<Vec<Value>, EngineError> {
    let snapshot = state.repo.require_state(&core.store, thread)?;
    let mut facts = Vec::new();
    {
        let borrowed = snapshot.borrow();
        for (key, record) in borrowed.state.agents.iter() {
            if record.limited.is_none() || record.external_status.is_some() {
                continue;
            }
            let mut fact = ace_json::Map::new();
            fact.insert("type", Value::from("limit.cleared"));
            fact.insert("agent", Value::from(key.as_str()));
            facts.push(Value::Object(fact));
        }
    }
    Ok(facts)
}

/// The thread a `background_task.stop` names, when its task is running and stoppable.
fn task_target(
    core: &Core,
    state: &mut State,
    task_id: &str,
) -> Result<Option<String>, EngineError> {
    let Some(owner) = state.entity_thread(&core.store, "backgroundTasks", task_id)? else {
        return Ok(None);
    };
    let Some(snapshot) = state.repo.state(&core.store, &owner)? else {
        return Ok(None);
    };
    let key = state.native_entity(&core.store, &owner, "tasks", task_id)?;
    let mut borrowed = snapshot
        .try_borrow_mut()
        .map_err(|_| EngineError::Reentrant)?;
    let Some(task) = (match key {
        Some(key) => borrowed.task(&key)?,
        None => None,
    }) else {
        return Ok(None);
    };
    Ok((task.status == "running" && task.stoppable).then_some(owner))
}

/// `handler.ts:376`-`:556`: a thread command's receipt.
pub fn handle(core: &Core, state: &mut State, command: &Value) -> Result<Value, EngineError> {
    let id = command_id(command).to_owned();
    let kind = payload_type(command);
    let p = payload(command);
    let fail = |code: &str| error(&id, code);
    if kind == "thread.create" || kind == "thread.prepare" {
        return crate::commands::create::create(core, state, command, &Context::default());
    }
    if kind == "interaction.resolve" {
        return Err(EngineError::not_ported("an interaction answer", "E5.7"));
    }
    let Some(thread) = p.get("threadId").and_then(Value::as_str).map(str::to_owned) else {
        return Ok(fail("not_implemented"));
    };
    if kind == "thread.archive" {
        let Some(row) = crate::commands::prelude::thread_row(core, &thread)? else {
            return Ok(fail("thread_not_found"));
        };
        let _ = row;
        if p.get("beforeSeq").is_some() {
            // `threadTree` is E5.10's read; the fence cannot run without it.
            return Err(EngineError::not_ported("a thread's tree", "E5.10"));
        }
        let at = core.ports.now();
        let mut archived = ace_json::Map::new();
        archived.insert("type", Value::from("thread.updated"));
        archived.insert("archivedAt", Value::from(at));
        core.store.write_events(
            &thread,
            &ace_json::to_string(&Value::Array(vec![Value::Object(archived)].into())),
            at,
        )?;
        return Ok(ok(&id, None));
    }
    if kind == "background_task.stop" {
        let task_id = p.get("taskId").and_then(Value::as_str).unwrap_or_default();
        let Some(owner) = task_target(core, state, task_id)? else {
            return Ok(fail("task_not_found"));
        };
        return tail(core, state, command, &owner, &id, kind);
    }
    let Some(row) = crate::commands::prelude::thread_row(core, &thread)? else {
        return Ok(fail("thread_not_found"));
    };
    if row
        .get("deletedAt")
        .is_some_and(|deleted| !deleted.is_null())
    {
        return Ok(fail("thread_not_found"));
    }
    if state.repo.state(&core.store, &thread)?.is_none() {
        return Ok(fail("thread_not_found"));
    }
    if kind == "thread.send" && state.transition_guarded(&core.store, &thread)? {
        return Ok(fail("thread_transition_in_progress"));
    }
    if matches!(kind, "thread.goal.set" | "thread.goal.clear") {
        let provider = row
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let backend = state.backend(&core.store, &thread)?;
        let goals = state
            .registry
            .get(&provider, backend.as_deref())
            .map(|entry| {
                entry
                    .capabilities
                    .get("goals")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if !goals {
            return Ok(fail("unsupported_goal"));
        }
    }
    if kind == "thread.interrupt" {
        let agent = p.get("agentId").and_then(Value::as_str).map(str::to_owned);
        let snapshot = state.repo.require_state(&core.store, &thread)?;
        let (known, root, target, run, run_state, child_controls) = {
            let borrowed = snapshot.borrow();
            let root = borrowed.root_agent_id();
            let known = agent.as_deref().is_none_or(|agent| {
                borrowed
                    .state
                    .agents
                    .values()
                    .any(|record| record.agent.id == agent)
            });
            let target = match agent.as_deref() {
                None => root.clone(),
                Some(agent) => borrowed.state.indexes.agent_keys_by_id.get(agent).cloned(),
            };
            let active = target
                .as_ref()
                .and_then(|key| borrowed.state.agents.get(key))
                .and_then(|record| record.active_run.clone());
            let run_state = borrowed
                .state
                .runs
                .get(p.get("runId").and_then(Value::as_str).unwrap_or_default())
                .map(|run| run.state.clone());
            (known, root, target, active, run_state, false)
        };
        let _ = (root, child_controls);
        if !known {
            return Ok(fail("agent_not_found"));
        }
        if let Some(before) = p.get("beforeSeq").and_then(Value::as_i64) {
            let target = agent.as_deref().or(target.as_deref()).unwrap_or_default();
            let sql = "SELECT 1 FROM events WHERE thread_id=? AND seq>? AND (
              (type='run.started' AND json_extract(payload,'$.run.agentId')=?) OR
              (type='item.created' AND json_extract(payload,'$.item.agentId')=? AND json_extract(payload,'$.item.role')='user' AND COALESCE(json_extract(payload,'$.item.synthetic'),0)=0)
            ) LIMIT 1";
            let row = ace_store::stmt_cache::get_row(
                core.store.conn(),
                sql,
                vec![
                    ace_store::Value::Text(thread.clone()),
                    ace_store::Value::Integer(before),
                    ace_store::Value::Text(target.to_owned()),
                    ace_store::Value::Text(target.to_owned()),
                ],
            )?;
            if row.is_none() {
                return Ok(fail("stale_interrupt"));
            }
        }
        if let Some(run_id) = p.get("runId").and_then(Value::as_str)
            && (target.is_none()
                || run.as_deref() != Some(run_id)
                || run_state.as_deref() != Some("active"))
        {
            return Ok(fail("stale_interrupt"));
        }
    }
    tail(core, state, command, &thread, &id, kind)
}

/// The admission tail (`handler.ts:480`-`:553`), in its order.
fn tail(
    core: &Core,
    state: &mut State,
    command: &Value,
    thread: &str,
    id: &str,
    kind: &str,
) -> Result<Value, EngineError> {
    let p = payload(command);
    let fail = |code: &str| error(id, code);
    let now = core.ports.now();
    if kind == "thread.send" {
        let backend = state.backend(&core.store, thread)?;
        if backend.as_deref() == Some("cursor-sdk") {
            let limit = state.limits.max_input_bytes as usize;
            if ace_json::bounded::bounded_json(p.get("input").unwrap_or(&Value::Null), limit)
                .is_err()
            {
                return Ok(fail("provider_input_budget_exceeded"));
            }
            let pending = state.limits.max_pending_inputs as i64;
            if !state.input_capacity(&core.store, thread, pending)? {
                return Ok(fail("provider_input_queue_full"));
            }
        }
    }
    let Some(admitted_send) = crate::queue::admission::admit(core, state, command, thread)? else {
        return Ok(fail("queue_capacity_exceeded"));
    };
    let resolved = fence_steer(core, state, &admitted_send, thread)?;
    let steer = admit_steer(core, state, &resolved, thread)?;
    let admitted = steer.send.clone();
    if kind == "thread.send" {
        let backend = state.backend(&core.store, thread)?.unwrap_or_default();
        let staged =
            crate::queue::stale::retire_uncertain_inputs(&core.store, thread, &backend, now)?;
        for event in staged {
            crate::queue::write::finish(&core.store, &event)?;
        }
        release_interrupted_hold(core, thread, &backend, now)?;
        crate::queue::holds::release_limit_hold(core, state, thread, now)?;
    }
    let held_send = kind == "thread.send" && crate::queue::store::get(&core.store, thread)?.paused;
    if !held_send && !state.repo.reserve(&core.store, thread)? {
        let freed =
            crate::release::reclaim::reclaim_idle_slot(core, state, &|_| false, &|_| false)?;
        let Some(freed) = freed else {
            return Ok(fail("engine_capacity_exceeded"));
        };
        state.repo.retiring.insert(freed);
        if !state.repo.reserve(&core.store, thread)? {
            return Ok(fail("engine_capacity_exceeded"));
        }
    }
    let agent = p.get("agentId").and_then(Value::as_str);
    let thread_stop = kind == "thread.interrupt" && !stops_one_agent(state, core, thread, agent)?;
    let released = if thread_stop {
        crate::liveness::stop_intents::cancel_pending(core, state, thread, now)?
    } else {
        Vec::new()
    };
    if thread_stop {
        let queue = crate::queue::store::get(&core.store, thread)?;
        let patch = format!(
            r#"{{"paused":true,"reason":"stopped","limited":false,"resetAt":null,"resumeAt":null,"timerAction":null,"holdToken":{}}}"#,
            queue.hold_token + 1
        );
        crate::queue::write::set(&core.store, thread, &patch, now)?;
        let facts = cleared_limits(state, core, thread)?;
        if !facts.is_empty() {
            state.apply(
                &core.store,
                thread,
                &ace_json::to_string(&Value::Array(facts.into())),
                now,
                None,
            )?;
        }
    }
    crate::intents::lifecycle::add(&core.store, &admitted, thread, None, None)?;
    state.accept_input(&core.store, &admitted, thread, now)?;
    queue_steer_selection(core, state, thread, steer, now)?;
    if matches!(kind, "thread.create" | "thread.send") {
        state.notify_naming_prompt(&core.store, &admitted, thread)?;
        crate::queue::write::set(&core.store, thread, "{}", now)?;
        crate::queue::holds::sync(core, state, thread, now)?;
    }
    for released_thread in released {
        crate::queue::holds::wake(core, &released_thread);
    }
    crate::queue::holds::wake(core, thread);
    Ok(ok(id, Some(thread)))
}

#[cfg(test)]
mod tests;
