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
use crate::steering::selection::{
    admit_steer, aim_steer_at_run, fence_steer, queue_steer_selection, record_steer_aim,
};
use crate::{Core, EngineError, State};

mod interrupt;

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
const INERT_THREAD_FIELDS: [&str; 10] = [
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
];

/// `thread.client.updated` fields: organization, read state and the list's projections.
const INERT_CLIENT_FIELDS: [&str; 25] = [
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
    "host",
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

/// `workChangedSince` (`thread-fence.ts:102`): whether any thread of `tree` may have work the
/// person didn't see after event `seq`. One cached statement per thread, merged in sequence
/// order, which is the one ordered read the TypeScript makes with the same limit.
pub fn work_changed_since(core: &Core, threads: &[String], seq: i64) -> Result<bool, EngineError> {
    const READ: &str =
        "SELECT seq,type,payload FROM events WHERE thread_id=? AND seq>? ORDER BY seq LIMIT 1001";
    let mut rows: Vec<(i64, String, String)> = Vec::new();
    for thread in threads {
        for row in ace_store::stmt_cache::all_rows(
            core.store.conn(),
            READ,
            vec![
                ace_store::Value::Text(thread.clone()),
                ace_store::Value::Integer(seq),
            ],
        )? {
            let at = row
                .get("seq")
                .and_then(crate::repository::residency::cell_int)
                .unwrap_or(0);
            let kind = row
                .get("type")
                .and_then(crate::repository::residency::cell_text)
                .unwrap_or_default()
                .to_owned();
            let payload = row
                .get("payload")
                .and_then(crate::repository::residency::cell_text)
                .unwrap_or_default()
                .to_owned();
            rows.push((at, kind, payload));
        }
    }
    rows.sort_by_key(|row| row.0);
    if rows.len() > 1_000 {
        return Ok(true);
    }
    Ok(rows.iter().any(|(_, kind, payload)| {
        let payload = ace_json::parse(payload).unwrap_or(Value::Null);
        changes_work(kind, &payload)
    }))
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

/// The `background_task.stop` target: the thread that owns a task, or why it cannot stop.
enum TaskTarget {
    Owner(String),
    NotFound,
    NotStoppable,
}

/// The thread a `background_task.stop` names, resolved from its `taskId` (`handler.ts:452`).
fn task_target(core: &Core, state: &mut State, task_id: &str) -> Result<TaskTarget, EngineError> {
    let Some(owner) = state.entity_thread(&core.store, "backgroundTasks", task_id)? else {
        return Ok(TaskTarget::NotFound);
    };
    let Some(snapshot) = state.repo.state(&core.store, &owner)? else {
        return Ok(TaskTarget::NotFound);
    };
    let key = state.native_entity(&core.store, &owner, "tasks", task_id)?;
    let mut borrowed = snapshot
        .try_borrow_mut()
        .map_err(|_| EngineError::Reentrant)?;
    let Some(task) = (match key {
        Some(key) => borrowed.task(&key)?,
        None => None,
    }) else {
        return Ok(TaskTarget::NotFound);
    };
    if task.status != "running" || !task.stoppable {
        return Ok(TaskTarget::NotStoppable);
    }
    Ok(TaskTarget::Owner(owner))
}

/// `handler.ts:376`-`:556`: a thread command's receipt.
pub fn handle(core: &Core, state: &mut State, command: &Value) -> Result<Value, EngineError> {
    let id = command_id(command).to_owned();
    let kind = payload_type(command);
    let p = payload(command);
    let fail = |code: &str| error(&id, code);
    if kind == "thread.create" || kind == "thread.prepare" {
        return match crate::commands::create::create(core, state, command, &Context::default())? {
            crate::commands::create::Outcome::Refused(result) => Ok(result),
            crate::commands::create::Outcome::Prepared { result, .. } => Ok(result),
            crate::commands::create::Outcome::Created { thread, reclaimed } => {
                // Only a prepare returns here: a create's prompt is its first input, so it takes
                // the admission tail (`handler.ts:374`-`:380`, `:489`-`:553`).
                tail(core, state, command, &thread, &id, kind, reclaimed)
            }
        };
    }
    if kind == "interaction.resolve" {
        return Err(EngineError::not_ported("an interaction answer", "E5.7"));
    }
    // `background_task.stop` names a task, not a thread: its owner is resolved first
    // (`handler.ts:452`), before any `threadId` requirement.
    if kind == "background_task.stop" {
        let task_id = p.get("taskId").and_then(Value::as_str).unwrap_or_default();
        return match task_target(core, state, task_id)? {
            TaskTarget::NotFound => Ok(fail("task_not_found")),
            TaskTarget::NotStoppable => Ok(fail("task_not_stoppable")),
            TaskTarget::Owner(owner) => tail(core, state, command, &owner, &id, kind, None),
        };
    }
    let Some(thread) = p.get("threadId").and_then(Value::as_str).map(str::to_owned) else {
        return Ok(fail("not_implemented"));
    };
    if kind == "thread.archive" {
        let Some(row) = crate::commands::prelude::thread_row(core, &thread)? else {
            return Ok(fail("thread_not_found"));
        };
        let _ = row;
        if let Some(before) = p.get("beforeSeq").and_then(Value::as_i64) {
            // The person decided at `before`: refuse once anything that could be work they
            // didn't see happened in the thread or any thread it would stop.
            let tree = crate::liveness::thread_tree(core, state, &thread)?;
            if work_changed_since(core, &tree, before)? {
                return Ok(fail("thread_changed"));
            }
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
    if kind == "thread.interrupt"
        && let Some(refused) = interrupt::check(core, state, p, &thread, &id)?
    {
        return Ok(refused);
    }
    tail(core, state, command, &thread, &id, kind, None)
}

/// The admission tail (`handler.ts:480`-`:553`), in its order.
fn tail(
    core: &Core,
    state: &mut State,
    command: &Value,
    thread: &str,
    id: &str,
    kind: &str,
    reclaimed: Option<String>,
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
    // `aimSteerAtRun` (`handler.ts:498`): a fresh steer is aimed at the turn it means. The
    // session fact `steersByCancel` arrives with E5.6's session; until then nothing is aimed and
    // the functions' own tests pin the rule.
    let aimed = aim_steer_at_run(&core.store, state, &admitted_send, thread, false)?;
    let resolved = fence_steer(core, state, &aimed, thread)?;
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
    let mut reclaimed = reclaimed;
    if !held_send && !state.repo.reserve_without_reclaim(&core.store, thread)? {
        let freed = crate::release::reclaim::reclaim_idle_slot(core, state)?;
        let Some(freed) = freed else {
            return Ok(fail("engine_capacity_exceeded"));
        };
        if !state.repo.reserve_after_reclaim(
            &core.store,
            thread,
            core.after.pending_retirements().len(),
        )? {
            return Ok(fail("engine_capacity_exceeded"));
        }
        reclaimed = Some(freed);
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
    let intent = crate::intents::lifecycle::add(&core.store, &admitted, thread, None, None)?;
    record_steer_aim(&core.store, state, intent, thread, &admitted)?;
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
    if kind == "background_task.stop" {
        core.defer(crate::executor::Deferred::Wake(
            thread.to_owned(),
            crate::executor::Lane::Control,
        ));
    } else {
        crate::queue::holds::wake(core, thread);
    }
    // The reclaim's in-memory marks are applied last, once nothing below can throw: a refusal or
    // a failed write rolls the SQL back and must leave no `idleDue` actor or `retiring` entry.
    if let Some(freed) = reclaimed {
        crate::release::reclaim::mark(core, state, &freed);
    }
    Ok(ok(id, Some(thread)))
}

#[cfg(test)]
mod tests;
