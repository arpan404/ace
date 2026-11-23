// SPDX-License-Identifier: Apache-2.0
//! The turn history of `runs.ts`: starting and ending runs, with replayed
//! native boundaries never creating runs or reopening completed ones.

use serde::{Deserialize, Serialize};

use crate::emit::{Event, emit, get, put};
use crate::json_io::{Maybe, de_i64};
use crate::state::{ApplyContext, ThreadState};

/// One turn of one agent, from its first output to the provider's turn end.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Run {
    /// Native selection acknowledged for this turn.
    #[serde(
        rename = "permissionMode",
        default,
        deserialize_with = "Maybe::<String>::deserialize",
        serialize_with = "Maybe::<String>::serialize",
        skip_serializing_if = "Maybe::<String>::is_missing"
    )]
    pub permission_mode: Maybe<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    pub id: String,
    #[serde(rename = "threadId")]
    pub thread_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    /// Some providers only reveal why a run started when it ends.
    pub trigger: String,
    /// Provider's turn id, when it has one.
    #[serde(rename = "nativeId", skip_serializing_if = "Option::is_none")]
    pub native_id: Option<String>,
    /// Stable root-run number (runs list, checkpoints).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ordinal: Option<i64>,
    /// Stable turn number of a root run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<i64>,
    /// The order it started in among every run of its thread.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoints: Option<serde_json::Value>,
    #[serde(rename = "executionSource", skip_serializing_if = "Option::is_none")]
    pub execution_source: Option<serde_json::Value>,
    pub state: String,
    /// ace interrupted this run so the person's steer reached the model now.
    #[serde(rename = "endedBy", skip_serializing_if = "Option::is_none")]
    pub ended_by: Option<String>,
    #[serde(rename = "startedAt", deserialize_with = "de_i64")]
    pub started_at: i64,
    #[serde(rename = "endedAt", skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<crate::status::AgentError>,
}

/// The next run's place among the thread's runs (`Run.seq`).
fn next_run_seq(state: &mut ThreadState) -> i64 {
    let seq = state.run_seq.unwrap_or(0) + 1;
    state.run_seq = Some(seq);
    seq
}

/// Start a turn, closing the active run as interrupted when one runs.
#[allow(clippy::too_many_arguments)]
pub fn start_turn(
    state: &mut ThreadState,
    agent_key: &str,
    native_turn_id: Option<&str>,
    trigger: String,
    permission_mode: crate::json_io::Maybe<String>,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let now = ctx.now;
    let agent_id = {
        let record = crate::tree::ensure_agent(state, agent_key, ctx, events)?;
        record.agent.id.clone()
    };
    let active = get(&state.agents, agent_key)
        .and_then(|record| record.active_run.clone())
        .and_then(|id| state.runs.get(&id))
        .map(|run| (run.id.clone(), run.state.clone(), run.native_id.clone()));
    // Replayed native boundaries must not create runs or reopen completed ones.
    if let Some(native_id) = native_turn_id {
        let known = get(&state.agents, agent_key)
            .and_then(|record| record.native_runs.as_ref())
            .and_then(|runs| runs.get(native_id))
            .is_some_and(|id| state.runs.contains_key(id));
        if known {
            return Some(());
        }
    }
    if active.is_some() && native_turn_id.is_none() {
        return Some(());
    }
    let had_run = get(&state.agents, agent_key).is_some_and(|record| record.last_run.is_some());
    if active.is_none() && had_run {
        crate::tree::announce_agent_branch(state, agent_key, events);
    }
    if let Some((_, _, ref active_native)) = active {
        end_turn_inner(
            state,
            agent_key,
            active_native.as_deref(),
            "interrupted".to_owned(),
            None,
            None,
            None,
            false,
            ctx,
            events,
        );
    }
    let run_id = match ctx.ids.next("run") {
        Some(id) => id,
        None => return None,
    };
    let seq = next_run_seq(state);
    let run = Run {
        provider: match &permission_mode {
            crate::json_io::Maybe::Missing => None,
            _ => Some(state.config.provider.clone()),
        },
        permission_mode,
        id: run_id.clone(),
        thread_id: state.thread_id.clone(),
        agent_id,
        trigger,
        native_id: native_turn_id.map(str::to_owned),
        ordinal: None,
        turn: None,
        seq: Some(seq),
        checkpoints: None,
        execution_source: None,
        state: "active".to_owned(),
        ended_by: None,
        started_at: now,
        ended_at: None,
        error: None,
    };
    if let Some(native_id) = run.native_id.clone() {
        if let Some(record) = state.agents.get_mut(agent_key) {
            let native_runs = record.native_runs.get_or_insert_with(Default::default);
            put(native_runs, native_id, run.id.clone());
        }
    }
    put(&mut state.runs, run.id.clone(), run.clone());
    if let Some(record) = state.agents.get_mut(agent_key) {
        record.active_run = Some(run_id);
        record.process_settled_status = None;
        record.activity = "starting_turn".to_owned();
        record.detail = None;
        record.wake_until = None;
        record.retry = None;
    }
    state.has_run = true;
    emit(events, Event::RunStarted { run });
    Some(())
}

/// End a turn: record its outcome, settle open work, and emit `run.ended`.
#[allow(clippy::too_many_arguments)]
pub fn end_turn(
    state: &mut ThreadState,
    agent_key: &str,
    native_turn_id: Option<&str>,
    outcome: String,
    ended_by: Option<String>,
    trigger: Option<String>,
    error: Option<crate::status::AgentError>,
    historical: bool,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    end_turn_inner(
        state,
        agent_key,
        native_turn_id,
        outcome,
        ended_by,
        trigger,
        error,
        historical,
        ctx,
        events,
    )
}

#[allow(clippy::too_many_arguments)]
fn end_turn_inner(
    state: &mut ThreadState,
    agent_key: &str,
    native_turn_id: Option<&str>,
    outcome: String,
    ended_by: Option<String>,
    trigger: Option<String>,
    error: Option<crate::status::AgentError>,
    historical: bool,
    ctx: &mut ApplyContext<'_>,
    events: &mut Vec<Event>,
) -> Option<()> {
    let now = ctx.now;
    crate::tree::ensure_agent(state, agent_key, ctx, events)?;
    let agent_id = get(&state.agents, agent_key)
        .map(|record| record.agent.id.clone())
        .unwrap_or_default();
    let active_id = get(&state.agents, agent_key).and_then(|record| record.active_run.clone());
    let last_run_id = get(&state.agents, agent_key).and_then(|record| record.last_run.clone());
    let matched_id = native_turn_id
        .and_then(|native_id| {
            get(&state.agents, agent_key)
                .and_then(|record| record.native_runs.as_ref())
                .and_then(|runs| runs.get(native_id))
                .cloned()
        })
        .filter(|id| state.runs.contains_key(id));
    let run_id = if native_turn_id.is_some() {
        matched_id.clone()
    } else {
        active_id.clone()
    };
    let recovered_past = historical && run_id.is_none() && last_run_id.is_some();
    // A settled run only corrects its trigger; anything else returns.
    if let Some(id) = run_id.clone() {
        let settled = state
            .runs
            .get(&id)
            .map(|run| (run.state.clone(), run.trigger.clone()));
        if let Some((state_name, run_trigger)) = settled {
            if state_name != "active" {
                if let Some(next_trigger) = trigger.clone() {
                    if run_trigger != next_trigger {
                        if let Some(run) = state.runs.get_mut(&id) {
                            run.trigger.clone_from(&next_trigger);
                        }
                        emit(
                            events,
                            Event::RunEnded {
                                run_id: id,
                                state: state_name,
                                ended_by: None,
                                ended_at: now,
                                trigger: Some(next_trigger),
                            },
                        );
                    }
                }
                return Some(());
            }
        }
    }
    let mut run_id = run_id;
    if run_id.is_none() {
        if native_turn_id.is_none() && last_run_id.is_some() {
            return Some(());
        }
        // A partial stream can contain the end boundary without the start.
        let new_id = match ctx.ids.next("run") {
            Some(id) => id,
            None => return None,
        };
        let seq = next_run_seq(state);
        let run = Run {
            provider: None,
            permission_mode: crate::json_io::Maybe::Missing,
            id: new_id.clone(),
            thread_id: state.thread_id.clone(),
            agent_id: agent_id.clone(),
            trigger: trigger.clone().unwrap_or_else(|| "unknown".to_owned()),
            native_id: native_turn_id.map(str::to_owned),
            ordinal: None,
            turn: None,
            seq: Some(seq),
            checkpoints: None,
            execution_source: None,
            state: "active".to_owned(),
            ended_by: None,
            started_at: now,
            ended_at: None,
            error: None,
        };
        if let Some(native_id) = run.native_id.clone() {
            if let Some(record) = state.agents.get_mut(agent_key) {
                let native_runs = record.native_runs.get_or_insert_with(Default::default);
                put(native_runs, native_id, run.id.clone());
            }
        }
        let emitted = run.clone();
        put(&mut state.runs, run.id.clone(), run);
        state.has_run = true;
        emit(events, Event::RunStarted { run: emitted });
        run_id = Some(new_id);
    }
    let run_id = match run_id {
        Some(id) => id,
        None => return None,
    };
    if let Some(run) = state.runs.get_mut(&run_id) {
        run.state.clone_from(&outcome);
        run.ended_at = Some(now);
        if let Some(ended) = ended_by.clone() {
            run.ended_by = Some(ended);
        }
        if let Some(next_trigger) = trigger.clone() {
            run.trigger = next_trigger;
        }
    }
    emit(
        events,
        Event::RunEnded {
            run_id: run_id.clone(),
            state: outcome.clone(),
            ended_by,
            ended_at: now,
            trigger,
        },
    );
    // A delayed end for an older native turn cannot terminate the current turn.
    if recovered_past {
        return Some(());
    }
    if let Some(active) = active_id {
        if active != run_id {
            return Some(());
        }
    }
    if !historical {
        if let Some(err) = error.clone() {
            if err.kind == "quota" {
                if let Some(record) = state.agents.get_mut(agent_key) {
                    let until = record.limited.as_ref().and_then(|limited| limited.until);
                    record.limited = Some(crate::state::LimitedInfo {
                        until,
                        message: Some(err.message.clone()),
                    });
                }
            }
        } else if outcome == "completed" {
            // A turn the provider completed is proof the account could work.
            if let Some(record) = state.agents.get_mut(agent_key) {
                record.limited = None;
            }
        }
    }
    if let Some(record) = state.agents.get_mut(agent_key) {
        record.process_settled_status = None;
        record.active_run = None;
        record.retry = None;
        record.last_run = Some(run_id.clone());
        record.last_outcome_order = Some(state.outcome_order + 1);
    }
    state.outcome_order += 1;
    let order = state.outcome_order;
    if let Some(record) = state.agents.get_mut(agent_key) {
        if outcome == "completed" {
            record.last_successful_outcome_order = Some(order);
        }
        if outcome == "failed" {
            record.last_error = Some(error.unwrap_or(crate::status::AgentError {
                kind: "provider".to_owned(),
                message: "turn failed".to_owned(),
                code: None,
                title: None,
                detail: None,
                details: None,
            }));
        } else {
            record.last_error = None;
        }
    }
    let resolving = ctx.resolving_interactions.clone().unwrap_or_default();
    let outliving = if outcome == "interrupted" {
        None
    } else {
        Some(crate::cleanup::outliving_turn(state, &resolving))
    };
    crate::cleanup::cancel_open_work(state, &agent_id, now, events, outliving);
    Some(())
}
