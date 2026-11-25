// SPDX-License-Identifier: Apache-2.0
//! The actor's input leases (`actor.ts:154`-`:190`). A redelivered intent replaces its earlier
//! lease; a provider process that exited reads nothing more, so its inputs end too.

use crate::actor::state::Lease;
use crate::{Core, ThreadId};
use ace_json::Value;

fn text<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    match value {
        Value::Object(map) => match map.get(name) {
            Some(Value::String(text)) => Some(text.as_str()),
            _ => None,
        },
        _ => None,
    }
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(map) => map.get(name),
        _ => None,
    }
}

/// `retainInput(id, release, runId)`.
pub fn retain_input(core: &Core, thread: &ThreadId, token: u64, run_id: Option<String>) {
    // A redelivered intent replaces its earlier lease; the earlier one is released, never lost.
    release_input(core, thread, token);
    core.with_state(|state| {
        if let Some(mut actor) = state.actors.get_mut(thread) {
            actor.leases.insert(token, Lease { token, run_id });
        }
    })
    .ok();
}

/// `releaseInput(id)`.
pub fn release_input(core: &Core, thread: &ThreadId, token: u64) {
    let released = core
        .with_state(|state| {
            state
                .actors
                .get_mut(thread)
                .and_then(|mut actor| actor.leases.shift_remove(&token))
        })
        .ok()
        .flatten();
    if let Some(lease) = released {
        let deps = core.actor_deps.borrow().clone();
        deps.links.release_leases(core, &[lease.token]);
    }
}

/// `releaseInputs()`.
pub fn release_inputs(core: &Core, thread: &ThreadId) {
    let tokens: Vec<u64> = core
        .with_state(|state| {
            let Some(mut actor) = state.actors.get_mut(thread) else {
                return Vec::new();
            };
            let tokens: Vec<u64> = actor.leases.keys().copied().collect();
            actor.leases.clear();
            tokens
        })
        .unwrap_or_default();
    if tokens.is_empty() {
        return;
    }
    let deps = core.actor_deps.borrow().clone();
    deps.links.release_leases(core, &tokens);
}

/// `observeInputs(facts, events)` (`actor.ts:171`): every fold reaches here, including ones applied
/// around the actor.
pub fn observe_inputs(
    core: &Core,
    thread: &ThreadId,
    facts: &[Value],
    events: &[Value],
    root_agent: Option<&str>,
) {
    let leased = core
        .with_state(|state| {
            state
                .actors
                .get(thread)
                .is_some_and(|actor| !actor.leases.is_empty())
        })
        .unwrap_or(false);
    if leased
        && facts
            .iter()
            .any(|fact| text(fact, "type") == Some("process.exited"))
    {
        release_inputs(core, thread);
        return;
    }
    if !leased {
        return;
    }
    for event in events {
        match text(event, "type") {
            Some("run.started") => {
                let run = field(event, "run");
                let agent = run.and_then(|run| text(run, "agentId"));
                if agent.is_some() && agent == root_agent {
                    let run_id = run.and_then(|run| text(run, "id")).map(str::to_string);
                    core.with_state(|state| {
                        if let Some(mut actor) = state.actors.get_mut(thread) {
                            for lease in actor.leases.values_mut() {
                                if lease.run_id.is_none() {
                                    lease.run_id.clone_from(&run_id);
                                }
                            }
                        }
                    })
                    .ok();
                }
            }
            Some("run.ended") => {
                let ended = text(event, "runId").map(str::to_string);
                let released: Vec<u64> = core
                    .with_state(|state| {
                        let Some(mut actor) = state.actors.get_mut(thread) else {
                            return Vec::new();
                        };
                        let tokens: Vec<u64> = actor
                            .leases
                            .values()
                            .filter(|lease| lease.run_id == ended)
                            .map(|lease| lease.token)
                            .collect();
                        for token in &tokens {
                            actor.leases.shift_remove(token);
                        }
                        tokens
                    })
                    .unwrap_or_default();
                if !released.is_empty() {
                    let deps = core.actor_deps.borrow().clone();
                    deps.links.release_leases(core, &released);
                }
            }
            _ => {}
        }
    }
}
