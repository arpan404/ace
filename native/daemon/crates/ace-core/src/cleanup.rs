// SPDX-License-Identifier: Apache-2.0
//! Settling open work of `cleanup.ts`: cancelling live tools, closing open
//! text and pending interactions when a turn or process ends.

use std::collections::HashSet;

use crate::emit::{Event, emit, get};
use crate::entity_model::Interaction;
use crate::indexes::{live_tool_keys, open_text_keys, pending_interaction_keys, running_task_keys};
use crate::items::Item;
use crate::state::ThreadState;
use crate::status::is_settled;

/// Cancel one live tool with "turn ended without completion".
fn cancel_tool(state: &mut ThreadState, key: &str, now: i64, events: &mut Vec<Event>) {
    let changed = match state.items.get_mut(key) {
        Some(Item::ToolCall { call, base, .. }) => {
            call.status = "cancelled".to_owned();
            if call.error.is_none() {
                call.appended("error");
            }
            call.error = Some("turn ended without completion".to_owned());
            if call.ended_at.is_none() {
                call.appended("endedAt");
            }
            call.ended_at = Some(now);
            base.complete = true;
            true
        }
        _ => false,
    };
    if changed {
        crate::indexes::refresh_item_index(state, key);
        if let Some(item) = get(&state.items, key) {
            emit(events, Event::ItemUpdated { item: item.clone() });
        }
    }
}

/// Close one open text: what arrived is final.
fn close_text(state: &mut ThreadState, key: &str, events: &mut Vec<Event>) {
    let Some(item) = state.items.get_mut(key) else {
        crate::indexes::refresh_item_index(state, key);
        return;
    };
    if item.complete() {
        crate::indexes::refresh_item_index(state, key);
        return;
    }
    set_complete(item);
    crate::indexes::refresh_item_index(state, key);
    if let Some(item) = get(&state.items, key) {
        emit(events, Event::ItemUpdated { item: item.clone() });
    }
}

fn set_complete(item: &mut Item) {
    match item {
        Item::Html { base, .. } => base.complete = true,
        Item::Image { base, .. } => base.complete = true,
        Item::Message { base, .. } => base.complete = true,
        Item::DelegationStarted { base, .. } => base.complete = true,
        Item::DelegationSettled { base, .. } => base.complete = true,
        Item::Reasoning { base, .. } => base.complete = true,
        Item::ToolCall { base, .. } => base.complete = true,
        Item::Notice { base, .. } => base.complete = true,
        Item::Compaction { base, .. } => base.complete = true,
        Item::Unknown { base, .. } => base.complete = true,
        Item::Artifact { base, .. } => base.complete = true,
    }
}

/// The requests a turn that ended on its own leaves open.
pub fn outliving_turn(state: &ThreadState, resolving: &HashSet<String>) -> HashSet<String> {
    let mut kept: HashSet<String> = resolving.clone();
    for key in pending_interaction_keys(state, None) {
        if let Some(interaction) = get(&state.interactions, &key)
            && interaction.state == "pending"
            && is_browser_help(interaction)
        {
            kept.insert(interaction.id.clone());
        }
    }
    kept
}

fn is_browser_help(interaction: &Interaction) -> bool {
    matches!(
        &interaction.request,
        crate::entity_model::InteractionRequest::BrowserHelp { .. }
    )
}

/// Settle an agent's open tools, texts and questions.
pub fn cancel_open_work(
    state: &mut ThreadState,
    agent_id: &str,
    now: i64,
    events: &mut Vec<Event>,
    resolving_interactions: Option<HashSet<String>>,
) {
    let background_items: HashSet<String> = running_task_keys(state, None)
        .iter()
        .filter_map(|key| get(&state.tasks, key))
        .filter_map(|task| task.tool_call_id.clone())
        .collect();
    for key in live_tool_keys(state, Some(agent_id)) {
        let cancel = match get(&state.items, &key) {
            Some(Item::ToolCall { call, .. }) => {
                call.agent_id == agent_id
                    && ["pending", "running", "awaiting_approval"].contains(&call.status.as_str())
                    && !background_items.contains(&call.id)
            }
            _ => false,
        };
        if cancel {
            cancel_tool(state, &key, now, events);
        }
    }
    for key in open_text_keys(state, Some(agent_id)) {
        close_text(state, &key, events);
    }
    for key in pending_interaction_keys(state, Some(agent_id)) {
        let cancel = match get(&state.interactions, &key) {
            Some(interaction) => {
                interaction.agent_id == agent_id
                    && interaction.blocking
                    && interaction.state == "pending"
                    && !resolving_interactions
                        .as_ref()
                        .is_some_and(|resolving| resolving.contains(&interaction.id))
            }
            None => false,
        };
        if cancel {
            if let Some(interaction) = state.interactions.get_mut(&key) {
                interaction.state = "cancelled".to_owned();
                interaction.closed_at = Some(now);
            }
            crate::indexes::refresh_interaction_index(state, &key);
            if let Some(interaction) = get(&state.interactions, &key) {
                let id = interaction.id.clone();
                emit(
                    events,
                    Event::InteractionClosed {
                        interaction_id: id,
                        state: "cancelled".to_owned(),
                        closed_at: now,
                        resolution: None,
                        resolved_by: None,
                        auto_reviewed: None,
                    },
                );
            }
        }
    }
}

/// Fold a provider process exit: expire questions, strand tasks, settle runs.
pub fn exit_process(
    state: &mut ThreadState,
    deliberate: bool,
    message: Option<String>,
    unconfirmed: bool,
    now: i64,
    events: &mut Vec<Event>,
) -> Option<()> {
    if state.process_exit.is_some() {
        // Already ended; a close that went unconfirmed still says its process may run.
        if unconfirmed && let Some(exit) = state.process_exit.as_mut() {
            exit.unconfirmed = Some(true);
        }
        return Some(());
    }
    let unsettled: Vec<String> = state
        .agents
        .iter()
        .filter(|(_, record)| record.external_status.is_none() && !is_settled(&record.agent.status))
        .map(|(key, _)| key.clone())
        .collect();
    state.appended("processExit");
    state.process_exit = Some(crate::state::ProcessExit {
        deliberate,
        message: message.clone(),
        unsettled,
        unconfirmed: unconfirmed.then_some(true),
    });
    for key in pending_interaction_keys(state, None) {
        if let Some(interaction) = state.interactions.get_mut(&key) {
            if interaction.state != "pending" {
                continue;
            }
            interaction.state = "expired".to_owned();
            interaction.closed_at = Some(now);
        }
        crate::indexes::refresh_interaction_index(state, &key);
        if let Some(interaction) = get(&state.interactions, &key) {
            let id = interaction.id.clone();
            emit(
                events,
                Event::InteractionClosed {
                    interaction_id: id,
                    state: "expired".to_owned(),
                    closed_at: now,
                    resolution: None,
                    resolved_by: None,
                    auto_reviewed: None,
                },
            );
        }
    }
    for key in running_task_keys(state, None) {
        let strand = match get(&state.tasks, &key) {
            Some(task) => task.status == "running" && task.owner.as_deref() != Some("ace"),
            None => false,
        };
        if strand {
            if let Some(task) = state.tasks.get_mut(&key) {
                task.status = "unknown".to_owned();
                task.ended_at = Some(now);
            }
            crate::indexes::refresh_task_index(state, &key);
            if let Some(task) = get(&state.tasks, &key) {
                let id = task.id.clone();
                emit(
                    events,
                    Event::BackgroundTaskUpdated {
                        task_id: id,
                        status: "unknown".to_owned(),
                        ended_at: Some(now),
                    },
                );
            }
        }
    }
    // All live tools belong to this process, even after their owner ended.
    for key in live_tool_keys(state, None) {
        cancel_tool(state, &key, now, events);
    }
    for key in open_text_keys(state, None) {
        close_text(state, &key, events);
    }
    let agent_keys: Vec<String> = state.agents.keys().cloned().collect();
    for key in agent_keys {
        let external = get(&state.agents, &key).and_then(|record| record.external_status.clone());
        if external.is_some() {
            continue;
        }
        if let Some(record) = state.agents.get_mut(&key) {
            record.disconnected_at = None;
            record.retry = None;
            record.wake_until = None;
        }
        let active_run = get(&state.agents, &key).and_then(|record| record.active_run.clone());
        if active_run.is_none() {
            let settled = get(&state.agents, &key)
                .map(|record| is_settled(&record.agent.status))
                .unwrap_or(true);
            if !settled {
                // packages/core/src/cleanup.ts:156-161 constructs a fresh terminal status.
                let failed = if deliberate {
                    crate::status::AgentStatus::Interrupted
                } else {
                    crate::status::AgentStatus::failed(crate::status::AgentError {
                        kind: "process_exit".to_owned(),
                        message: message
                            .clone()
                            .unwrap_or_else(|| "Provider process exited".to_owned()),
                        code: None,
                        title: None,
                        detail: None,
                        details: None,
                    })
                };
                if let Some(record) = state.agents.get_mut(&key) {
                    record.process_settled_status = Some(failed);
                    record.last_outcome_order = Some(state.outcome_order + 1);
                }
                state.outcome_order += 1;
            }
            continue;
        }
        let run_id = active_run.unwrap_or_default();
        let new_status = if deliberate { "interrupted" } else { "failed" };
        if let Some(run) = state.runs.get_mut(&run_id) {
            run.state = new_status.to_owned();
            run.ended_at = Some(now);
        }
        let agent_id = get(&state.agents, &key)
            .map(|record| record.agent.id.clone())
            .unwrap_or_default();
        if let Some(record) = state.agents.get_mut(&key) {
            record.last_run = Some(run_id.clone());
            record.last_outcome_order = Some(state.outcome_order + 1);
            if !deliberate {
                record.last_error = Some(crate::status::AgentError {
                    kind: "process_exit".to_owned(),
                    message: message
                        .clone()
                        .unwrap_or_else(|| "provider process exited".to_owned()),
                    code: None,
                    title: None,
                    detail: None,
                    details: None,
                });
            }
        }
        state.outcome_order += 1;
        emit(
            events,
            Event::RunEnded {
                run_id,
                state: new_status.to_owned(),
                ended_by: None,
                ended_at: now,
                trigger: None,
            },
        );
        if let Some(record) = state.agents.get_mut(&key) {
            record.active_run = None;
        }
        let _ = agent_id;
    }
    Some(())
}
