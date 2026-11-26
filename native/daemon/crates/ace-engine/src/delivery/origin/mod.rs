// SPDX-License-Identifier: Apache-2.0
//! `turn-origin.ts` (E5.5): which turn a delegation call comes from, read for the delegation
//! fence a Stop sets (ADR 0191). Pure reads of a thread's state.

use ace_core::item_model::ToolDetail;
use ace_core::items::Item;
use ace_core::state::ThreadState;
use ace_json::Value;

/// One run and its place among the thread's runs (`Run.seq`; 0 for a run recorded before there
/// was one).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunAt {
    pub id: String,
    pub seq: i64,
}

/// `TurnOrigin`: the root's running run, its latest turn, the calling agent's own run, and the
/// thread's last run's `seq`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TurnOrigin {
    pub root: Option<RunAt>,
    pub root_turn: Option<RunAt>,
    pub origin: Option<RunAt>,
    pub latest: i64,
}

fn run_at(state: &ThreadState, run: Option<&String>) -> Option<RunAt> {
    let found = state.runs.get(run?)?;
    Some(RunAt {
        id: found.id.clone(),
        seq: found.seq.unwrap_or(0),
    })
}

/// `turnOrigin`: the runs a delegation fence compares against.
pub fn turn_origin(state: Option<&ThreadState>, agent_id: &str) -> TurnOrigin {
    let Some(state) = state else {
        return TurnOrigin::default();
    };
    let root_record = state
        .root_key
        .as_deref()
        .and_then(|root| state.agents.get(root));
    let key = state.indexes.agent_keys_by_id.get(agent_id);
    TurnOrigin {
        root: run_at(
            state,
            root_record.and_then(|record| record.active_run.as_ref()),
        ),
        root_turn: run_at(
            state,
            root_record.and_then(|record| record.active_run.as_ref().or(record.last_run.as_ref())),
        ),
        // Never the root's for a subagent: one still running from a stopped turn is never taken
        // for the new one.
        origin: key.and_then(|key| {
            state
                .agents
                .get(key)
                .and_then(|record| run_at(state, record.active_run.as_ref()))
        }),
        latest: state.run_seq.unwrap_or(0),
    }
}

/// `activeRun`: the run an agent's tool call belongs to now: its own running run, else the
/// root's. None once the turn ended.
pub fn active_run(state: Option<&ThreadState>, agent_id: &str) -> Option<String> {
    let origin = turn_origin(state, agent_id);
    origin.origin.or(origin.root).map(|run| run.id)
}

/// Request ids of the thread's calls to ace's `delegate` still in flight, at most 64.
pub fn delegations_in_flight(state: Option<&ThreadState>) -> Vec<String> {
    let Some(state) = state else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for key in state.indexes.live_tools.keys() {
        let Some(Item::ToolCall { call, .. }) = state.items.get(key) else {
            continue;
        };
        let ToolDetail::Mcp {
            server,
            tool,
            arguments,
            ..
        } = &call.detail
        else {
            continue;
        };
        if server != "ace" || tool != "delegate" {
            continue;
        }
        let Some(arguments) = arguments else {
            continue;
        };
        let Ok(parsed) = ace_json::parse(arguments.get()) else {
            continue;
        };
        let Some(tasks) = parsed.get("tasks").and_then(Value::as_array) else {
            continue;
        };
        if tasks.len() > 64 {
            continue;
        }
        for task in tasks.iter() {
            let Some(request) = task.get("requestId").and_then(Value::as_str) else {
                continue;
            };
            if request.is_empty() || request.chars().count() > 256 {
                continue;
            }
            if ids.len() < 64 {
                ids.push(request.to_owned());
            }
        }
    }
    ids
}

#[cfg(test)]
mod tests;
