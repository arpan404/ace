// SPDX-License-Identifier: Apache-2.0
//! `remote-child-status.ts` and `delegation-facts.ts` (E5.10): the summary agent a delegated
//! child has in its parent's tree, the status a child on another machine gives it, and the rows
//! a parent shows for the children it delegated here or there.

use ace_json::{Map, Value};

use crate::{Core, EngineError, State};

/// The summary agent a delegated child has in its parent's tree, here or on another machine.
pub fn child_agent_key(thread_id: &str) -> String {
    format!("ace-child:{thread_id}")
}

/// `outcomeState`: a settled child's state, from the outcome it settled with.
pub fn outcome_state(outcome: Option<&Value>) -> &'static str {
    match outcome
        .and_then(|outcome| outcome.get("outcome"))
        .and_then(Value::as_str)
    {
        Some("completed") => "done",
        Some("cancelled") => "cancelled",
        _ => "failed",
    }
}

/// `remoteChildStatus`: the status a child on another machine gives its summary agent in the
/// parent, from what that machine last reported. `asks_here`: its requests are already open in
/// the parent, on this agent, so the agent itself does not count them again.
pub fn remote_child_status(state: &str, status: &Value, asks_here: bool) -> Value {
    let mut out = Map::new();
    match state {
        "done" | "cancelled" => {
            out.insert("state", Value::from("done"));
        }
        "failed" => {
            out.insert("state", Value::from("failed"));
        }
        "needs_you" => {
            if asks_here {
                out.insert("state", Value::from("working"));
                out.insert("agents", Value::from(1));
            } else {
                out.insert("state", Value::from("needs_you"));
                out.insert("interactions", Value::from(1));
            }
        }
        "queued" => {
            if status.get("state").and_then(Value::as_str) == Some("waiting") {
                return status.clone();
            }
            out.insert("state", Value::from("waiting"));
            out.insert("on", Value::from("queue"));
        }
        _ => {
            let kept = matches!(
                status.get("state").and_then(Value::as_str),
                Some("working") | Some("waiting") | Some("limited") | Some("unresponsive")
            );
            if kept {
                return status.clone();
            }
            out.insert("state", Value::from("working"));
            out.insert("agents", Value::from(1));
        }
    }
    Value::Object(out)
}

/// `attachChild`: the summary agent and its external status for a child on this machine.
pub struct Child<'a> {
    pub thread: &'a Value,
    pub role: &'a str,
    pub background: bool,
}

pub fn attach_child(
    core: &Core,
    state: &mut State,
    at: f64,
    parent_id: &str,
    parent_agent_id: &str,
    child: &Child<'_>,
) -> Result<(), EngineError> {
    let role = child.role;
    let background = child.background;
    let child = child.thread;
    let Some(child_id) = child.get("id").and_then(Value::as_str) else {
        return Err(EngineError::Records("a child thread has no id".into()));
    };
    let summary = child_agent_key(child_id);
    let parent = parent_key(state, core, parent_id, parent_agent_id)?;
    let provider = child
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mut seen = Map::new();
    seen.insert("type", Value::from("agent.seen"));
    seen.insert("agent", Value::from(summary.as_str()));
    seen.insert("parent", Value::from(parent.as_str()));
    seen.insert("origin", Value::from("ace"));
    seen.insert("fidelity", Value::from("summary"));
    let mut native = Map::new();
    native.insert("provider", Value::from(provider));
    seen.insert("native", Value::Object(native));
    seen.insert("cwd", Value::from(""));
    seen.insert("role", Value::from(role));
    seen.insert("background", Value::Bool(background));
    let status = child.get("status").cloned().unwrap_or(Value::Null);
    let external = external_fact(&summary, child_id, status);
    state.apply(
        &core.store,
        parent_id,
        &ace_json::to_string(&Value::Array(vec![Value::Object(seen), external].into())),
        at,
        None,
    )
}

/// `updateChild`: the child's status, as its summary agent in the parent shows it.
pub fn update_child(
    core: &Core,
    state: &mut State,
    at: f64,
    parent_id: &str,
    child: &Value,
) -> Result<(), EngineError> {
    let Some(child_id) = child.get("id").and_then(Value::as_str) else {
        return Err(EngineError::Records("a child thread has no id".into()));
    };
    let status = child.get("status").cloned().unwrap_or(Value::Null);
    state.apply(
        &core.store,
        parent_id,
        &ace_json::to_string(&Value::Array(
            vec![external_fact(&child_agent_key(child_id), child_id, status)].into(),
        )),
        at,
        None,
    )
}

fn external_fact(summary: &str, child_id: &str, status: Value) -> Value {
    let mut external = Map::new();
    external.insert("type", Value::from("agent.external"));
    external.insert("agent", Value::from(summary));
    external.insert("threadId", Value::from(child_id));
    external.insert("status", status);
    Value::Object(external)
}

fn parent_key(
    state: &mut State,
    core: &Core,
    parent_id: &str,
    parent_agent_id: &str,
) -> Result<String, EngineError> {
    let snapshot = state.repo.require_state(&core.store, parent_id)?;
    let key = snapshot
        .borrow()
        .state
        .indexes
        .agent_keys_by_id
        .get(parent_agent_id)
        .cloned();
    key.ok_or_else(|| EngineError::Records("Unknown parent agent".into()))
}

/// Which way a machine child's hold moves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Hold {
    Start,
    End,
}

/// One child on another paired machine (ADR 0078): its launch row names the machine, and a
/// background hold keeps the parent from reading done while the child works there.
pub struct MachineChild<'a> {
    pub id: &'a str,
    pub parent_id: &'a str,
    pub parent_agent_id: &'a str,
    pub machine: &'a str,
    pub name: &'a str,
    pub host_id: Option<&'a str>,
    pub provider: &'a str,
    pub model: Option<&'a str>,
    pub role: &'a str,
    pub title: &'a str,
    pub status: Value,
    /// The child as its machine reads it, the same state `agents_status` reports.
    pub state: &'a str,
    pub outcome: Option<Value>,
    /// This machine can't vouch for it: lost contact, or stopped without confirmation.
    pub contact: Option<&'a str>,
}

/// `machineChild`: the summary agent, its external status, the delegation row, and the hold that
/// keeps the parent from reading done while the child works on its machine.
pub fn machine_child(
    core: &Core,
    state: &mut State,
    at: f64,
    child: &MachineChild<'_>,
    hold: Option<Hold>,
) -> Result<(), EngineError> {
    let summary = child_agent_key(child.id);
    let agent = parent_key(state, core, child.parent_id, child.parent_agent_id)?;
    let task = format!("ace-machine:{}", child.id);
    let settled = child.outcome.is_some();
    let (summary_id, asks_here, held, relink) = {
        let snapshot = state.repo.require_state(&core.store, child.parent_id)?;
        let borrowed = snapshot.borrow();
        let summary_id = borrowed
            .state
            .agents
            .get(&summary)
            .map(|record| record.agent.id.clone());
        let asks_here = summary_id.as_ref().is_some_and(|id| {
            borrowed
                .state
                .indexes
                .pending_interactions
                .keys()
                .any(|key| {
                    borrowed
                        .state
                        .interactions
                        .get(key)
                        .is_some_and(|interaction| interaction.agent_id == *id)
                })
        });
        let held = borrowed.state.tasks.get(&task).cloned();
        let relink = hold.is_none()
            && held
                .as_ref()
                .is_some_and(|task| task.status == "running" && task.child_agent_id.is_none());
        (summary_id, asks_here, held, relink)
    };
    let _ = summary_id;
    let external = if child.contact == Some("lost") && !settled {
        remote_child_status("needs_you", &child.status, asks_here)
    } else if settled {
        remote_child_status(outcome_state(child.outcome.as_ref()), &child.status, false)
    } else {
        remote_child_status(child.state, &child.status, asks_here)
    };
    let mut machine = Map::new();
    machine.insert("machine", Value::from(child.machine));
    machine.insert("name", Value::from(child.name));
    if let Some(host_id) = child.host_id {
        machine.insert("hostId", Value::from(host_id));
    }
    if let Some(contact) = child.contact {
        machine.insert("contact", Value::from(contact));
    }
    let mut seen = Map::new();
    seen.insert("type", Value::from("agent.seen"));
    seen.insert("agent", Value::from(summary.as_str()));
    seen.insert("parent", Value::from(agent.as_str()));
    seen.insert("origin", Value::from("ace"));
    seen.insert("fidelity", Value::from("summary"));
    let mut native = Map::new();
    native.insert("provider", Value::from(child.provider));
    seen.insert("native", Value::Object(native));
    seen.insert("cwd", Value::from(""));
    seen.insert("role", Value::from(child.role));
    if let Some(model) = child.model {
        seen.insert("model", Value::from(model));
    }
    seen.insert("machine", Value::Object(machine.clone()));
    let mut draft = Map::new();
    draft.insert("type", Value::from("delegation.started"));
    draft.insert("origin", Value::from("ace"));
    draft.insert("childThreadId", Value::from(child.id));
    draft.insert("provider", Value::from(child.provider));
    if let Some(model) = child.model {
        draft.insert("model", Value::from(model));
    }
    draft.insert("title", Value::from(child.title));
    draft.insert("role", Value::from(child.role));
    draft.insert(
        "phase",
        Value::from(if settled { "settled" } else { "running" }),
    );
    draft.insert("status", child.status.clone());
    draft.insert("updatedAt", Value::from(at));
    draft.insert("generation", Value::from(0));
    draft.insert("complete", Value::Bool(settled));
    draft.insert("outcome", child.outcome.clone().unwrap_or(Value::Null));
    draft.insert("machine", Value::Object(machine));
    let mut row = Map::new();
    row.insert("type", Value::from("item.upsert"));
    row.insert("agent", Value::from(agent.as_str()));
    row.insert(
        "item",
        Value::from(format!("ace-delegation:{}", child.id).as_str()),
    );
    row.insert("draft", Value::Object(draft));
    let mut facts = vec![Value::Object(seen), external, Value::Object(row)];
    if hold == Some(Hold::Start) || relink {
        let mut started = Map::new();
        started.insert("type", Value::from("background.started"));
        started.insert("owner", Value::from("ace"));
        started.insert("agent", Value::from(agent.as_str()));
        started.insert("task", Value::from(task.as_str()));
        started.insert("kind", Value::from("subagent"));
        started.insert(
            "title",
            Value::from(format!("{} · {}", child.role, child.name).as_str()),
        );
        started.insert("childAgent", Value::from(summary.as_str()));
        started.insert("stoppable", Value::Bool(true));
        facts.push(Value::Object(started));
    } else if hold == Some(Hold::End) {
        let mut ended = Map::new();
        ended.insert("type", Value::from("background.ended"));
        ended.insert("task", Value::from(task.as_str()));
        let status = match child
            .outcome
            .as_ref()
            .and_then(|outcome| outcome.get("outcome"))
            .and_then(Value::as_str)
        {
            Some("completed") => "completed",
            Some("cancelled") => "stopped",
            _ => "failed",
        };
        ended.insert("status", Value::from(status));
        facts.push(Value::Object(ended));
    }
    let _ = held;
    state.apply(
        &core.store,
        child.parent_id,
        &ace_json::to_string(&Value::Array(facts.into())),
        at,
        None,
    )?;
    if hold == Some(Hold::End) {
        crate::queue::holds::wake(core, child.parent_id);
    }
    Ok(())
}

/// The delegation row a parent shows for one child thread.
pub struct DelegationRow<'a> {
    pub parent_id: &'a str,
    pub parent_agent_id: &'a str,
    pub child_id: &'a str,
    pub provider: &'a str,
    pub model: Option<&'a str>,
    pub instance_id: Option<&'a str>,
    pub title: &'a str,
    pub role: &'a str,
    pub phase: &'a str,
    pub generation: i64,
    pub status: Value,
    pub outcome: Option<Value>,
}

/// `delegationStarted`: one stable parent item follows each independently owned child thread.
pub fn delegation_started(
    core: &Core,
    state: &mut State,
    at: f64,
    row: &DelegationRow<'_>,
) -> Result<(), EngineError> {
    let agent = parent_key(state, core, row.parent_id, row.parent_agent_id)?;
    let mut draft = Map::new();
    draft.insert("type", Value::from("delegation.started"));
    draft.insert("origin", Value::from("ace"));
    draft.insert("childThreadId", Value::from(row.child_id));
    draft.insert("provider", Value::from(row.provider));
    if let Some(model) = row.model {
        draft.insert("model", Value::from(model));
    }
    if let Some(instance) = row.instance_id {
        draft.insert("accountId", Value::from(instance));
    }
    draft.insert("title", Value::from(row.title));
    draft.insert("role", Value::from(row.role));
    draft.insert("phase", Value::from(row.phase));
    draft.insert("status", row.status.clone());
    draft.insert("updatedAt", Value::from(at));
    draft.insert("generation", Value::from(row.generation));
    draft.insert("complete", Value::Bool(row.phase == "settled"));
    draft.insert("outcome", row.outcome.clone().unwrap_or(Value::Null));
    let mut fact = Map::new();
    fact.insert("type", Value::from("item.upsert"));
    fact.insert("agent", Value::from(agent.as_str()));
    fact.insert(
        "item",
        Value::from(format!("ace-delegation:{}", row.child_id).as_str()),
    );
    fact.insert("draft", Value::Object(draft));
    state.apply(
        &core.store,
        row.parent_id,
        &ace_json::to_string(&Value::Array(vec![Value::Object(fact)].into())),
        at,
        None,
    )
}

/// The host-only result of one delegation call: its summaries, the input it carried, and the
/// item the parent shows.
pub struct DelegationSettled<'a> {
    pub parent_id: &'a str,
    pub parent_agent_id: &'a str,
    pub command_id: &'a str,
    pub results: &'a [Value],
    pub delivery: &'a str,
    pub text: Option<&'a str>,
}

/// The most characters of one result the parent keeps.
const RESULT_PREVIEW: usize = 128;

/// `delegationSettled`: host-only result attribution; ordinary wire sends cannot impersonate ace.
pub fn delegation_settled(
    core: &Core,
    state: &mut State,
    at: f64,
    settled: &DelegationSettled<'_>,
) -> Result<(), EngineError> {
    let agent = parent_key(state, core, settled.parent_id, settled.parent_agent_id)?;
    let item = format!("ace-results:{}", settled.command_id);
    let summaries: Vec<Value> = settled
        .results
        .iter()
        .map(|result| {
            let text = result
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let truncated = result.get("truncated") == Some(&Value::Bool(true))
                || text.encode_utf16().count() > RESULT_PREVIEW;
            let preview: String = text.chars().take(RESULT_PREVIEW).collect();
            let mut summary = result.as_object().cloned().unwrap_or_default();
            summary.insert("result", Value::from(preview.as_str()));
            summary.insert("truncated", Value::Bool(truncated));
            Value::Object(summary)
        })
        .collect();
    core.store.atomic(|_| {
        if let Some(text) = settled.text.filter(|text| !text.is_empty()) {
            let mut origin = Map::new();
            origin.insert("kind", Value::from("subagent_result"));
            origin.insert("commandId", Value::from(settled.command_id));
            origin.insert(
                "threadIds",
                Value::Array(
                    settled
                        .results
                        .iter()
                        .filter_map(|result| result.get("threadId").cloned())
                        .collect(),
                ),
            );
            let parts = vec![{
                let mut part = Map::new();
                part.insert("type", Value::from("text"));
                part.insert("text", Value::from(text));
                Value::Object(part)
            }];
            crate::inputs::journal::register(
                core.store.conn(),
                settled.parent_id,
                &format!("input:{}", settled.command_id),
                &parts,
                &Value::Object(origin),
            )?;
            crate::inputs::ace::record(
                core.store.conn(),
                settled.parent_id,
                settled.command_id,
                &crate::inputs::ace::AceInput {
                    agent: agent.clone(),
                    item: item.clone(),
                    results: Value::Array(summaries.clone().into()),
                },
            )?;
        }
        let mut draft = Map::new();
        draft.insert("type", Value::from("delegation.settled"));
        draft.insert("origin", Value::from("ace"));
        draft.insert("delivery", Value::from(settled.delivery));
        draft.insert("results", Value::Array(summaries.into()));
        draft.insert("complete", Value::Bool(true));
        let mut fact = Map::new();
        fact.insert("type", Value::from("item.upsert"));
        fact.insert("agent", Value::from(agent.as_str()));
        fact.insert("item", Value::from(item.as_str()));
        fact.insert("draft", Value::Object(draft));
        state.apply(
            &core.store,
            settled.parent_id,
            &ace_json::to_string(&Value::Array(vec![Value::Object(fact)].into())),
            at,
            None,
        )
    })
}

#[cfg(test)]
mod tests;
