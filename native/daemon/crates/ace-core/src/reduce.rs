// SPDX-License-Identifier: Apache-2.0
//! The fold of `reduce.ts`: one adapter fact at a time, with statuses
//! recomputed after every fold. `FactBatch` folds a provider frame's facts
//! with one status derivation for consecutive batchable facts, while every
//! turn or control boundary still observes all preceding facts.

use crate::diagnostics::reject_fact;
use crate::emit::{Event, get};
use crate::facts::Fact;
use crate::items::Item;
use crate::json_io::Json;
use crate::state::{ApplyContext, ThreadState};
use crate::status::recompute_statuses;
use crate::validate::checked_fact;

/// The largest safe integer: `ctx.now` must be one, like the TypeScript.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Whether `ctx.now` is a non-negative safe integer, like the TypeScript.
fn valid_now(now: i64) -> bool {
    (0..=MAX_SAFE_INTEGER).contains(&now)
}

/// Fold one adapter fact and recompute statuses.
pub fn apply(
    state: &mut ThreadState,
    input: &Json,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    if !valid_now(ctx.now) {
        return None;
    }
    let now = ctx.now;
    match checked_fact(state, input, now) {
        Err(reason) => reject_fact(state, input, &reason, ctx, events),
        Ok(fact) => {
            let mut emitted = Vec::new();
            fold_inner(state, &fact, input, ctx, &mut emitted)?;
            // `item.delta` returns early in the TypeScript fold (conditional
            // recompute only, no `finish`): skip the unconditional derivation
            // here, or root deltas re-derive silent children.
            if !matches!(&fact, Fact::ItemDelta { .. }) {
                recompute_statuses(state, now, &mut emitted);
            }
            events.extend(emitted);
            Some(())
        }
    }
}

/// A provider frame commits atomically. Consecutive entity and transport
/// facts need one derived status, while turn/control boundaries still
/// observe all preceding facts.
pub struct FactBatch {
    pending_at: Option<i64>,
    signal_deadline: Option<i64>,
    preserve_signals: bool,
}

impl FactBatch {
    /// Start one batch over the current thread state.
    pub fn new(stable_signals_deadline: Option<Option<i64>>) -> Self {
        match stable_signals_deadline {
            Some(deadline) => Self {
                pending_at: None,
                signal_deadline: deadline,
                preserve_signals: true,
            },
            None => Self {
                pending_at: None,
                signal_deadline: None,
                preserve_signals: false,
            },
        }
    }

    /// Fold one fact of the batch.
    pub fn apply(
        &mut self,
        state: &mut ThreadState,
        input: &Json,
        ctx: &mut ApplyContext<'_>,
        events: &mut Vec<Event>,
    ) -> Option<()> {
        if !valid_now(ctx.now) {
            return None;
        }
        let now = ctx.now;
        let fact = match checked_fact(state, input, now) {
            Err(reason) => {
                let mut rejected = Vec::new();
                reject_fact(state, input, &reason, ctx, &mut rejected)?;
                events.extend(rejected);
                self.preserve_signals = false;
                return Some(());
            }
            Ok(fact) => fact,
        };
        let batchable = is_batchable(state, &fact);
        let mut preceding = Vec::new();
        if !batchable || self.pending_at != Some(now) {
            preceding = self.flush(state);
        }
        let stable_signal = self.preserve_signals
            && matches!(&fact, Fact::Signal { agent: Some(agent) } if get(&state.agents, agent).is_some())
            && state.process_exit.is_none()
            && state.status_observed_at.is_some()
            && now >= state.status_observed_at.unwrap_or(0)
            && now >= state.last_transport_signal_at.unwrap_or(now)
            && self.signal_deadline.is_none_or(|deadline| now < deadline)
            && !transport_silenced(state, now)
            && match &fact {
                Fact::Signal { agent: Some(agent) } => {
                    !crate::liveness::has_unresponsive_ancestor(state, agent)
                }
                _ => false,
            };
        let mut emitted = Vec::new();
        fold_inner(state, &fact, input, ctx, &mut emitted)?;
        // `item.delta` never takes the batch's deferred derivation in the
        // TypeScript fold (it returns before `finish`): the conditional
        // recompute inside `fold_inner` is the only one.
        let is_delta = matches!(&fact, Fact::ItemDelta { .. });
        if stable_signal && emitted.is_empty() {
            state.status_observed_at = Some(now);
            state.appended("statusObservedAt");
        } else if batchable {
            self.pending_at = Some(now);
        } else if !is_delta {
            recompute_statuses(state, now, &mut emitted);
        }
        // Any non-signal control fact invalidates the cached eligibility
        // window for this batch.
        if !matches!(&fact, Fact::Signal { .. } | Fact::ItemDelta { .. })
            || emitted
                .iter()
                .any(|event| !matches!(event, Event::ItemDelta { .. }))
        {
            self.preserve_signals = false;
        }
        events.extend(preceding);
        events.extend(emitted);
        Some(())
    }

    /// Reject a fact this batch cannot parse, with the same bookkeeping `apply` runs for a
    /// rejection: the pending derivation flushes first, and the rejection is the batch's own.
    pub fn reject(
        &mut self,
        state: &mut ThreadState,
        data: &Json,
        reason: &str,
        ctx: &mut ApplyContext<'_>,
        events: &mut Vec<Event>,
    ) -> Option<()> {
        let preceding = self.flush(state);
        let mut rejected = Vec::new();
        crate::diagnostics::reject_data(state, data, reason, ctx, &mut rejected)?;
        self.preserve_signals = false;
        events.extend(preceding);
        events.extend(rejected);
        Some(())
    }

    /// Derive the deferred status, if any.
    pub fn flush(&mut self, state: &mut ThreadState) -> Vec<Event> {
        let Some(at) = self.pending_at.take() else {
            return Vec::new();
        };
        let mut flushed = Vec::new();
        recompute_statuses(state, at, &mut flushed);
        flushed
    }
}

fn transport_silenced(state: &ThreadState, now: i64) -> bool {
    state.config.liveness.as_deref() == Some("transport")
        && (now - crate::liveness::transport_signal_at(state)) as f64 > state.config.silence_ms
}

/// Whether a fact joins the batch's single status derivation.
fn is_batchable(state: &ThreadState, fact: &Fact) -> bool {
    match fact {
        Fact::Signal { .. } => true,
        Fact::InteractionOpened { item, .. } => item.is_none(),
        Fact::ItemUpsert { item, draft, .. } => {
            let kind = draft.get("type").and_then(|kind| kind.as_str());
            let complete = draft
                .get("complete")
                .and_then(|complete| complete.as_bool());
            (kind == Some("message") || kind == Some("notice"))
                && complete == Some(true)
                && !matches!(
                    get(&state.items, item),
                    Some(crate::items::Item::ToolCall { .. })
                )
        }
        _ => false,
    }
}

/// Refresh an agent's activity from its updated item, like the fold does.
fn item_activity(state: &mut ThreadState, agent_key: &str, item: &Item) {
    let active_run = match get(&state.agents, agent_key) {
        Some(record) => match &record.active_run {
            Some(active) => active.clone(),
            None => return,
        },
        None => return,
    };
    if item.run_id() != Some(active_run.as_str()) {
        return;
    }
    // A finished compaction ends the compacting step even if no other frame
    // follows it.
    if matches!(item, Item::Compaction { .. })
        && get(&state.agents, agent_key).is_some_and(|record| record.activity == "compacting")
    {
        if let Some(record) = state.agents.get_mut(agent_key) {
            record.activity = "starting_turn".to_owned();
        }
        return;
    }
    let activity = match item {
        Item::ToolCall { call, .. } => {
            if ["running", "pending", "awaiting_approval"].contains(&call.status.as_str()) {
                "tool"
            } else {
                "starting_turn"
            }
        }
        Item::Reasoning { .. } if !item.complete() => "thinking",
        Item::Message { role, .. } if !item.complete() && role == "assistant" => "responding",
        Item::Compaction { .. } if !item.complete() => "compacting",
        _ => return,
    };
    if let Some(record) = state.agents.get_mut(agent_key) {
        record.activity = activity.to_owned();
    }
}

/// Refresh liveness on the fold's signal rules.
fn signal(
    state: &mut ThreadState,
    fact: &Fact,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    match fact {
        Fact::AgentExternal { agent, .. }
        | Fact::AgentSeen { agent, .. }
        | Fact::AgentLinked { agent, .. }
        | Fact::InputAdmitted { agent, .. }
        | Fact::InputConsumed { agent, .. }
        | Fact::TurnStarted { agent, .. }
        | Fact::TurnEnded { agent, .. }
        | Fact::SubagentsWaiting { agent, .. }
        | Fact::Activity { agent, .. }
        | Fact::ItemUpsert { agent, .. }
        | Fact::ItemReconciled { agent, .. }
        | Fact::ItemDelta { agent, .. }
        | Fact::InteractionOpened { agent, .. }
        | Fact::AgentDisconnected { agent }
        | Fact::AgentReconnected { agent }
        | Fact::Retry { agent, .. }
        | Fact::RetryCleared { agent }
        | Fact::LimitCleared { agent }
        | Fact::WakeExpected { agent, .. }
        | Fact::GoalUpdated { agent, .. }
        | Fact::Usage { agent, .. }
        | Fact::ContextSample { agent, .. } => {
            crate::tree::ensure_agent(state, agent, ctx, events)?.last_signal_at = ctx.now;
            Some(())
        }
        Fact::Signal { agent: None } => {
            // A transport heartbeat covers every agent.
            for record in state.agents.values_mut() {
                record.last_signal_at = ctx.now;
            }
            Some(())
        }
        Fact::Signal { agent: Some(agent) } => {
            crate::tree::ensure_agent(state, agent, ctx, events)?.last_signal_at = ctx.now;
            Some(())
        }
        Fact::BackgroundEnded { task, .. } => {
            let Some(task_record) = get(&state.tasks, task) else {
                return Some(());
            };
            let owner = task_record.agent_id.clone();
            let key = get(&state.indexes.agent_keys_by_id, &owner)?.clone();
            if let Some(record) = state.agents.get_mut(&key) {
                record.last_signal_at = ctx.now;
            }
            Some(())
        }
        Fact::InteractionClosed { interaction, .. } => {
            let Some(interaction_record) = get(&state.interactions, interaction) else {
                return Some(());
            };
            let owner = interaction_record.agent_id.clone();
            let key = get(&state.indexes.agent_keys_by_id, &owner)?.clone();
            if let Some(record) = state.agents.get_mut(&key) {
                record.last_signal_at = ctx.now;
            }
            Some(())
        }
        _ => Some(()),
    }
}

/// Fold one validated fact: the switch of `reduce.ts`, rule for rule.
fn fold_inner(
    state: &mut ThreadState,
    fact: &Fact,
    input: &Json,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let now = ctx.now;
    crate::tree::ensure_initial_root(state, ctx, events)?;
    let transport_recovered = state.config.liveness.as_deref() == Some("transport")
        && (now - crate::liveness::transport_signal_at(state)) as f64 > state.config.silence_ms;
    if !matches!(
        fact,
        Fact::Tick | Fact::QueueChanged { .. } | Fact::ProcessExited { .. }
    ) {
        state.last_transport_signal_at = Some(now);
        state.appended("lastTransportSignalAt");
    }
    signal(state, fact, ctx, events)?;
    if let Fact::ItemDelta {
        agent,
        item,
        field,
        append,
    } = fact
    {
        let changed = crate::items::append_item(state, agent, item, field, append, ctx, events)?;
        if changed
            || transport_recovered
            || crate::liveness::has_unresponsive_ancestor(state, agent)
        {
            crate::tree::reconcile_links(state, ctx, events)?;
            crate::status::recompute_statuses(state, now, events);
        }
        crate::diagnostics::flush_notices(state, ctx, events)?;
        return Some(());
    }
    match fact {
        Fact::AgentExternal {
            agent,
            thread_id,
            status,
        } => {
            let failed_before = matches!(
                get(&state.agents, agent).and_then(|record| record.external_status.as_ref()),
                Some(crate::status::ThreadStatus::Failed)
            );
            let is_failure = matches!(status.state(), "failed");
            if is_failure && !failed_before {
                state.outcome_order += 1;
            }
            let order = state.outcome_order;
            let record = crate::tree::ensure_agent(state, agent, ctx, events)?;
            if is_failure && !failed_before {
                record.last_outcome_order = Some(order);
            }
            record.external_status = Some(status.clone());
            let changed = get(&state.agents, agent)
                .and_then(|record| record.agent.child_thread_id.clone())
                != Some(thread_id.clone());
            if changed {
                let agent_id = get(&state.agents, agent)?.agent.id.clone();
                if let Some(record) = state.agents.get_mut(agent) {
                    record.agent.child_thread_id = Some(thread_id.clone());
                }
                crate::emit::emit(
                    events,
                    Event::AgentUpdated {
                        agent_id,
                        child_thread_id: Some(thread_id.clone()),
                        machine: None,
                        parent_id: None,
                        origin: None,
                        lineage: None,
                        fidelity: None,
                        native: None,
                        cwd: None,
                        name: None,
                        role: None,
                        model: None,
                        spawned_by: None,
                        background: None,
                    },
                );
            }
        }
        Fact::AgentDisconnected { agent } => {
            crate::tree::ensure_agent(state, agent, ctx, events)?.disconnected_at = Some(now);
        }
        Fact::AgentReconnected { agent } => {
            crate::tree::ensure_agent(state, agent, ctx, events)?.disconnected_at = None;
        }
        Fact::AgentSeen { .. } => {
            crate::tree::see_agent(state, fact, ctx, events)?;
        }
        Fact::AgentLinked { .. } => {
            crate::tree::link_agent(state, fact, ctx, events)?;
        }
        Fact::TurnStarted {
            agent,
            native_turn_id,
            trigger,
            permission_mode,
        } => {
            crate::runs::start_turn(
                state,
                agent,
                native_turn_id.as_deref(),
                trigger.clone(),
                permission_mode.clone(),
                ctx,
                events,
            )?;
        }
        Fact::TurnEnded {
            agent,
            native_turn_id,
            outcome,
            ended_by,
            trigger,
            error,
            historical,
        } => {
            crate::runs::end_turn(
                state,
                agent,
                native_turn_id.as_deref(),
                outcome.clone(),
                ended_by.clone(),
                trigger.clone(),
                error.clone(),
                historical.unwrap_or(false),
                ctx,
                events,
            )?;
        }
        Fact::InputAdmitted {
            agent,
            native_input_id,
            command_id,
        } => {
            let record = crate::tree::ensure_agent(state, agent, ctx, events)?;
            let agent_id = record.agent.id.clone();
            crate::emit::emit(
                events,
                Event::InputAdmitted {
                    agent_id,
                    native_input_id: native_input_id.clone(),
                    command_id: command_id.clone(),
                },
            );
        }
        Fact::InputConsumed { .. } => {
            // Run binding of transcript inputs belongs to the engine's input journal.
        }
        Fact::Activity {
            agent,
            activity,
            detail,
        } => {
            let record = crate::tree::ensure_agent(state, agent, ctx, events)?;
            record.activity = activity.clone();
            record.detail = detail.clone();
        }
        Fact::ItemUpsert { agent, item, draft } => {
            let stored = crate::items::upsert_item(state, agent, item, draft, ctx, events)?;
            item_activity(state, agent, &stored);
        }
        Fact::ItemReconciled { agent, item, draft } => {
            let stored =
                crate::reconciled_item::reconcile_item(state, agent, item, draft, ctx, events)?;
            item_activity(state, agent, &stored);
        }
        Fact::SubagentsWaiting { item, targets, .. } => {
            let mut links = get(&state.item_links, item).cloned().unwrap_or_default();
            links.waiting_for = Some(targets.clone());
            crate::emit::put(&mut state.item_links, item.clone(), links);
        }
        Fact::ItemDelta { .. } => {
            // Handled above, before the switch.
        }
        Fact::InteractionOpened {
            agent,
            interaction,
            blocking,
            request,
            item,
            raw,
        } => {
            crate::entities::open_interaction(
                state,
                agent,
                interaction,
                *blocking,
                request.clone(),
                item.as_deref(),
                raw.clone().unwrap_or_default(),
                ctx,
                events,
            )?;
        }
        Fact::InteractionClosed {
            interaction,
            state: close_state,
            resolution,
            resolved_by,
            auto_reviewed,
        } => {
            crate::entities::close_interaction(
                state,
                interaction,
                close_state.clone(),
                resolution.clone(),
                resolved_by.clone(),
                *auto_reviewed,
                now,
                events,
            )?;
        }
        Fact::BackgroundStarted {
            owner,
            agent,
            task,
            kind,
            title,
            item,
            child_agent,
            ambient,
            internal,
            stoppable,
            output_path,
            wakes_agent,
            blocks_prompts,
            ends_with_session,
            raw,
        } => {
            crate::entities::start_background(
                state,
                crate::entities::BackgroundStarted {
                    owner: owner.as_deref(),
                    agent,
                    task,
                    kind,
                    title,
                    item: item.as_deref(),
                    child_agent: child_agent.as_deref(),
                    ambient: ambient.clone(),
                    internal: *internal,
                    stoppable: *stoppable,
                    output_path: output_path.as_deref(),
                    wakes_agent: *wakes_agent,
                    blocks_prompts: *blocks_prompts,
                    ends_with_session: *ends_with_session,
                    raw: raw.clone().unwrap_or_default(),
                },
                ctx,
                events,
            )?;
        }
        Fact::BackgroundListening { task, ports } => {
            crate::entities::listen_background(state, task, ports.clone(), events)?;
        }
        Fact::BackgroundWaiting { task, waiting } => {
            crate::entities::wait_background(state, task, *waiting);
        }
        Fact::BackgroundEnded {
            task,
            status,
            uncertain,
        } => {
            crate::entities::end_background(
                state,
                task,
                status,
                uncertain.unwrap_or(false),
                now,
                events,
            )?;
        }
        Fact::Retry {
            agent,
            on,
            attempt,
            until,
            message,
        } => {
            let record = crate::tree::ensure_agent(state, agent, ctx, events)?;
            let active = record.active_run.is_some();
            // Only a running turn retries. A limit reported after its turn
            // ended holds the agent as limited, with no retry left.
            if on != "rate_limit" || active {
                record.retry = Some(crate::state::RetryInfo {
                    on: on.clone(),
                    attempt: *attempt,
                    until: *until,
                    message: message.clone(),
                });
            } else {
                record.retry = None;
            }
            if on == "rate_limit" {
                record.limited = Some(crate::state::LimitedInfo {
                    until: *until,
                    message: message.clone(),
                });
            }
        }
        Fact::RetryCleared { agent } => {
            let record = crate::tree::ensure_agent(state, agent, ctx, events)?;
            let rate_limited = record
                .retry
                .as_ref()
                .is_none_or(|retry| retry.on == "rate_limit");
            if rate_limited {
                if transport_recovered || crate::liveness::has_unresponsive_ancestor(state, agent) {
                    crate::tree::reconcile_links(state, ctx, events)?;
                    crate::status::recompute_statuses(state, now, events);
                }
                crate::diagnostics::flush_notices(state, ctx, events)?;
                return Some(());
            }
            if let Some(record) = state.agents.get_mut(agent) {
                record.retry = None;
            }
        }
        Fact::LimitCleared { agent } => {
            let record = crate::tree::ensure_agent(state, agent, ctx, events)?;
            if record
                .retry
                .as_ref()
                .is_some_and(|retry| retry.on == "rate_limit")
            {
                record.retry = None;
            }
            record.limited = None;
        }
        Fact::WakeExpected { agent, until } => {
            crate::tree::ensure_agent(state, agent, ctx, events)?.wake_until = Some(*until);
        }
        Fact::ContextSample { agent, .. } => {
            let record = crate::tree::ensure_agent(state, agent, ctx, events)?;
            let agent_id = record.agent.id.clone();
            crate::emit::emit(
                events,
                Event::ContextSampled {
                    agent_id,
                    body: crate::json_io::spread_members(input),
                },
            );
        }
        Fact::Usage { agent, .. } => {
            let record = crate::tree::ensure_agent(state, agent, ctx, events)?;
            let agent_id = record.agent.id.clone();
            crate::emit::emit(
                events,
                Event::UsageUpdated {
                    agent_id,
                    body: crate::json_io::spread_members(input),
                },
            );
        }
        Fact::ProcessExited {
            deliberate,
            message,
            unconfirmed,
        } => {
            crate::cleanup::exit_process(
                state,
                *deliberate,
                message.clone(),
                unconfirmed.unwrap_or(false),
                now,
                events,
            )?;
        }
        Fact::ThreadMoved { to } => {
            if let Some(to) = to {
                state.appended("movedTo");
                state.moved_to = Some(to.clone());
            } else {
                state.moved_to = None;
            }
        }
        Fact::ProcessStarted => {
            state.queue_sources.provider = 0;
            state.queue_count = state.queue_sources.engine;
            state.process_exit = None;
        }
        Fact::QueueChanged {
            count,
            source,
            held,
            stopped,
        } => {
            let source = source.as_deref().unwrap_or("engine");
            if source == "engine" {
                state.queue_sources.engine = *count;
            } else {
                state.queue_sources.provider = *count;
            }
            state.queue_count = state.queue_sources.engine + state.queue_sources.provider;
            if source != "provider" {
                if held == &Some(true) && *count > 0 {
                    state.appended("queueHeld");
                    state.queue_held = Some(true);
                } else {
                    state.queue_held = None;
                }
                if stopped == &Some(true) && *count > 0 {
                    state.appended("queueStopped");
                    state.queue_stopped = Some(true);
                } else {
                    state.queue_stopped = None;
                }
            }
        }
        // The engine lifts a root agent's goal onto the thread before facts
        // reach the reducer.
        Fact::GoalUpdated { .. } | Fact::Signal { .. } | Fact::Tick => {}
    }
    crate::diagnostics::flush_notices(state, ctx, events)?;
    crate::tree::reconcile_links(state, ctx, events)?;
    Some(())
}
