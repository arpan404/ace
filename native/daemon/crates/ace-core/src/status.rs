// SPDX-License-Identifier: Apache-2.0
//! Recompute derived agent and thread statuses and emit their changes.

use crate::json_io::json_equal;

pub use crate::agent_status_model::{
    AgentError, AgentStatus, ProviderErrorDetails, valid_activity, valid_blocked_on,
};
pub use crate::thread_status::{MovedTo, ThreadStatus};

/// Whether an agent status counts as finished for thread `done`.
pub fn is_settled(status: &AgentStatus) -> bool {
    matches!(
        status,
        AgentStatus::Idle | AgentStatus::Interrupted | AgentStatus::Failed { .. }
    )
}

/// JSON equality independent of object property order, like `equal`.
pub fn status_equal(left: &AgentStatus, right: &AgentStatus) -> bool {
    let left_value = crate::json_io::to_value(left);
    let right_value = crate::json_io::to_value(right);
    json_equal(&left_value, &right_value)
}

/// JSON equality for thread statuses.
pub fn thread_status_equal(left: &ThreadStatus, right: &ThreadStatus) -> bool {
    let left_value = crate::json_io::to_value(left);
    let right_value = crate::json_io::to_value(right);
    json_equal(&left_value, &right_value)
}

use crate::emit::{Event, emit, get};
use crate::indexes::{pending_interaction_keys, running_task_keys};
use crate::state::{AgentRecord, ThreadState};
use crate::status_inputs::{status_inputs, task_holds_thread};

/// Derive one agent's status for the current fact, descendants first.
pub fn derive_agent_status(state: &ThreadState, key: &str, now: i64) -> AgentStatus {
    crate::status_resolve::StatusResolver::new(state, now).resolve(key)
}

/// Read completion evidence from an already-derived, persisted agent tree.
pub fn completion_relevance_reader(state: &ThreadState) -> impl Fn(&str) -> bool + '_ {
    let mut resolver = crate::status_resolve::StatusResolver::persisted(state, 0);
    let mut relevant: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
    let keys: Vec<String> = state.agents.keys().cloned().collect();
    for key in &keys {
        relevant.insert(key.clone(), resolver.holds_completion(key, 0));
    }
    move |key: &str| relevant.get(key).copied().unwrap_or(false)
}

/// Deadline eligibility from current completion relevance, memoized
/// bottom-up. A descendant's wake/silence transition is scheduled before an
/// ancestor can become newly eligible.
pub fn silence_deadline_reader(
    state: &ThreadState,
) -> impl FnMut(&str, &AgentRecord) -> Option<i64> + '_ {
    let mut resolver = crate::status_resolve::StatusResolver::persisted(state, 0);
    let mut subtree = crate::liveness::SubtreeSignalReader::new(state);
    let waiting = resolver_waiting(state);
    let has_run = state.has_run;
    let root_key = state.root_key.clone();
    let silence_ms = state.config.silence_ms;
    move |key: &str, record: &AgentRecord| {
        let phase = record.agent.status.state();
        if phase != "working" && phase != "starting" {
            return None;
        }
        if record.active_run.is_none()
            && (phase == "working"
                || (Some(key) == root_key.as_deref()
                    && !has_run
                    && record.agent.fidelity != "placeholder"))
        {
            return None;
        }
        if record.active_run.is_some() {
            let live_children = live_relevant_children(&mut resolver, &record.agent.id);
            if crate::status_inputs::suppresses_active_silence(
                &waiting,
                &record.agent.id,
                live_children,
            ) {
                return None;
            }
        }
        Some((subtree.read(key) as f64 + silence_ms).floor() as i64 + 1)
    }
}

fn resolver_waiting(state: &ThreadState) -> std::collections::HashSet<String> {
    status_inputs(state).waiting_owners
}

fn live_relevant_children(
    resolver: &mut crate::status_resolve::StatusResolver<'_>,
    agent_id: &str,
) -> usize {
    resolver.live_children_count(agent_id)
}

/// A thread whose work moved to another machine reads `moved` once nothing
/// runs here; work that still runs here always shows as it is.
pub fn derive_thread_status(state: &ThreadState) -> ThreadStatus {
    let status = live_thread_status(state);
    // Messages queued here stay held: nothing will send them on this machine.
    let held = matches!(&status, ThreadStatus::Waiting { on, .. } if on == "queue");
    if state.moved_to.is_some()
        && (held
            || matches!(
                status,
                ThreadStatus::Done | ThreadStatus::New | ThreadStatus::Failed
            ))
        && let Some(to) = state.moved_to.clone()
    {
        // packages/core/src/status.ts:329 wraps the destination in a fresh moved status.
        return ThreadStatus::moved(to);
    }
    status
}

fn live_thread_status(state: &ThreadState) -> ThreadStatus {
    let records: Vec<&AgentRecord> = state.agents.values().collect();
    let by_id: std::collections::HashMap<&str, &AgentStatus> = records
        .iter()
        .map(|record| (record.agent.id.as_str(), &record.agent.status))
        .collect();
    let pending: Vec<&crate::entity_model::Interaction> = pending_interaction_keys(state, None)
        .iter()
        .filter_map(|key| get(&state.interactions, key))
        .collect();
    let actionable = pending
        .iter()
        .filter(|interaction| {
            crate::human::is_actionable_interaction(
                &interaction.state,
                interaction.blocking,
                by_id
                    .get(interaction.agent_id.as_str())
                    .map(|status| status.state()),
            )
        })
        .count();
    let external_human: usize = records
        .iter()
        .filter_map(|record| record.external_status.as_ref())
        .filter_map(|status| match status {
            ThreadStatus::NeedsYou { interactions, .. } => Some(*interactions as usize),
            _ => None,
        })
        .sum();
    let waiting_on = state.person_tasks.as_ref();
    let held_human = waiting_on
        .map(|waiting| {
            running_task_keys(state, None)
                .iter()
                .filter(|key| waiting.contains_key(*key))
                .count()
        })
        .unwrap_or(0);
    let human = actionable + external_human + held_human;
    if human > 0 {
        return ThreadStatus::needs_you(human as i64);
    }
    let root_id = state
        .root_key
        .as_ref()
        .and_then(|key| get(&state.agents, key))
        .map(|record| record.agent.id.clone());
    let working = records
        .iter()
        .filter(|record| {
            let status = &record.agent.status;
            (status.state() == "starting"
                && (state.has_run
                    || Some(&record.agent.id) != root_id.as_ref()))
                || status.state() == "working"
                || matches!(status, AgentStatus::Blocked { on, refs, .. } if on == "subagents" && refs.is_empty())
        })
        .count();
    if working > 0 {
        return ThreadStatus::working(working as i64);
    }
    for reason in ["rate_limit", "network", "upstream"] {
        if records.iter().any(|record| {
            matches!(&record.agent.status, AgentStatus::Blocked { on, .. } if on == reason)
        }) {
            if reason == "rate_limit" {
                let limits: Vec<Option<i64>> = records
                    .iter()
                    .filter_map(|record| match &record.agent.status {
                        AgentStatus::Blocked { on, until, .. } if on == "rate_limit" => Some(*until),
                        _ => None,
                    })
                    .collect();
                if limits.iter().all(|limit| limit.is_some()) {
                    let until = limits
                        .iter()
                        .filter_map(|limit| *limit)
                        .max();
                    return ThreadStatus::limited(until);
                }
                return ThreadStatus::limited(None );
            }
            return ThreadStatus::waiting(reason);
        }
    }
    if running_task_keys(state, None)
        .iter()
        .any(|key| get(&state.tasks, key).is_some_and(|task| task_holds_thread(state, task)))
    {
        return ThreadStatus::waiting("background_task");
    }
    if records.iter().any(|record| {
        (record.disconnected_at.is_some()
            || matches!(&record.external_status, Some(ThreadStatus::Unresponsive)))
            && record.agent.status.state() == "unresponsive"
    }) {
        return ThreadStatus::Unresponsive;
    }
    if records.iter().any(|record| {
        matches!(&record.agent.status, AgentStatus::Blocked { on, .. } if on == "background_task" || on == "subagents")
    }) {
        return ThreadStatus::waiting("background_task");
    }
    // A send or session start that failed keeps its input, held, for the
    // person's Try again, Edit or Remove: the thread reads as failed.
    if state.queue_held == Some(true) && state.queue_sources.provider == 0 {
        return ThreadStatus::Failed;
    }
    // Input a Stop kept for the person's Resume sends nothing by itself.
    let resting_queue = state.queue_stopped == Some(true) && state.queue_sources.provider == 0;
    if (state.queue_count > 0 && !resting_queue)
        || records.iter().any(|record| {
            matches!(&record.external_status, Some(ThreadStatus::Waiting { on, .. }) if on == "queue")
        })
    {
        return ThreadStatus::waiting("queue");
    }
    let reader = completion_relevance_reader(state);
    if state.agents.keys().any(|key| {
        get(&state.agents, key)
            .is_some_and(|record| record.agent.status.state() == "unresponsive" && reader(key))
    }) {
        return ThreadStatus::Unresponsive;
    }
    let root = state
        .root_key
        .as_ref()
        .and_then(|key| get(&state.agents, key));
    let success_order = root
        .and_then(|record| record.last_successful_outcome_order)
        .unwrap_or(0);
    if root.is_some_and(|record| record.agent.status.state() == "failed")
        || records.iter().any(|record| {
            record.agent.status.state() == "failed"
                && record.last_outcome_order.unwrap_or(0) > success_order
        })
    {
        return ThreadStatus::Failed;
    }
    if !state.has_run {
        return match &state.process_exit {
            None => ThreadStatus::New,
            Some(exit) if exit.deliberate => ThreadStatus::Done,
            Some(_) => ThreadStatus::Failed,
        };
    }
    ThreadStatus::Done
}

/// Recompute every agent status and the thread status, emitting changes.
pub fn recompute_statuses(state: &mut ThreadState, now: i64, events: &mut Vec<Event>) {
    state.status_observed_at = Some(now);
    state.appended("statusObservedAt");
    let mut resolver = crate::status_resolve::StatusResolver::new(state, now);
    let keys: Vec<String> = state.agents.keys().cloned().collect();
    let mut derived: Vec<(String, AgentStatus, bool)> = Vec::new();
    for key in &keys {
        let status = resolver.resolve(key);
        let relevant = resolver.holds_completion(key, 0);
        derived.push((key.clone(), status, relevant));
    }
    drop(resolver);
    for (key, status, relevant) in derived {
        let changed = get(&state.agents, &key).is_some_and(|record| {
            !status_equal(&record.agent.status, &status)
                || record.completion_relevant != Some(relevant)
        });
        if !changed {
            continue;
        }
        let settled_before = get(&state.agents, &key)
            .map(|record| is_settled(&record.agent.status))
            .unwrap_or(true);
        let settled_after = is_settled(&status);
        if settled_before && !settled_after {
            crate::tree::announce_agent_branch(state, &key, events);
        }
        if let Some(record) = state.agents.get_mut(&key) {
            // packages/core/src/status.ts:455 assigns the full derived status.
            record.agent.status = status.clone();
            if record.completion_relevant.is_none() {
                record.appended("completionRelevant");
            }
            record.completion_relevant = Some(relevant);
        }
        if let Some(record) = get(&state.agents, &key) {
            let id = record.agent.id.clone();
            emit(
                events,
                Event::AgentStatus {
                    agent_id: id,
                    status,
                    completion_relevant: relevant,
                },
            );
        }
    }
    // packages/core/src/status.ts:459-461 replaces the old status with a fresh derivation.
    let status = derive_thread_status(state);
    if !thread_status_equal(&state.status, &status) {
        state.status = status.clone();
        emit(events, Event::ThreadUpdated { status });
    }
}

#[cfg(test)]
mod tests;
