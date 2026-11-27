// SPDX-License-Identifier: Apache-2.0
//! The deadline computation of `deadlines.ts`: the earliest injected instant
//! at which a tick can change an agent status. Candidate eligibility changes
//! at structural facts; ordinary deltas only move ancestor silence.

use crate::expiry_map::ExpiryMap;
use crate::liveness::transport_signal_at;
use crate::state::ThreadState;
use crate::status::is_settled;

/// The largest integer JavaScript represents exactly.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// One candidate deadline.
struct Candidate {
    key: String,
    at: i64,
    kind: CandidateKind,
}

#[derive(PartialEq)]
enum CandidateKind {
    Silence,
    Wake,
    Transport,
}

fn candidates(state: &ThreadState) -> Vec<Candidate> {
    if state.process_exit.is_some() {
        return Vec::new();
    }
    let mut result = Vec::new();
    let mut silence_reader = if state.config.liveness.as_deref() != Some("transport") {
        Some(crate::status::silence_deadline_reader(state))
    } else {
        None
    };
    let transport_deadline =
        (transport_signal_at(state) as f64 + state.config.silence_ms).floor() as i64 + 1;
    let mut admit = |key: &str, kind: CandidateKind, candidate: Option<i64>| {
        if let Some(at) = candidate {
            result.push(Candidate {
                key: key.to_owned(),
                at,
                kind,
            });
        }
    };
    for (key, record) in state.agents.iter() {
        if record.external_status.is_some() || record.limited.is_some() {
            continue;
        }
        if state.config.liveness.as_deref() != Some("transport")
            && Some(key) == state.root_key.as_ref()
            && !state.has_run
            && record.agent.fidelity != "placeholder"
            && record.active_run.is_none()
            && record.wake_until.is_none()
        {
            continue;
        }
        if record.active_run.is_none()
            && record.wake_until.is_some()
            && record.agent.status.state() == "working"
        {
            admit(
                key,
                CandidateKind::Wake,
                record
                    .wake_until
                    .filter(|until| until.unsigned_abs() <= MAX_SAFE_INTEGER as u64),
            );
        }
        if state.config.liveness.as_deref() == Some("transport") {
            if !is_settled(&record.agent.status) && record.agent.status.state() != "unresponsive" {
                admit(key, CandidateKind::Transport, Some(transport_deadline));
            }
        } else if record.agent.status.state() != "unresponsive"
            && (record.active_run.is_some() || record.last_run.is_none())
        {
            let deadline = match silence_reader.as_mut() {
                Some(reader) => reader(key, record),
                None => None,
            };
            admit(key, CandidateKind::Silence, deadline);
        }
    }
    result
}

fn earliest(values: &[i64], provider_deadline: Option<i64>) -> Option<i64> {
    let mut next = match provider_deadline {
        Some(deadline) if deadline >= 0 => Some(deadline),
        _ => None,
    };
    for at in values {
        next = Some(next.map_or(*at, |current: i64| current.min(*at)));
    }
    next
}

/// The earliest deadline across the thread, if any.
pub fn next_deadline(state: &ThreadState, provider_deadline: Option<i64>) -> Option<i64> {
    if state.process_exit.is_some() {
        return None;
    }
    earliest(
        &candidates(state)
            .iter()
            .map(|candidate| candidate.at)
            .collect::<Vec<_>>(),
        provider_deadline,
    )
}

/// Candidate eligibility changes at structural facts.
pub struct DeadlineIndex {
    silence: ExpiryMap<()>,
    wakes: ExpiryMap<()>,
    parents: std::collections::HashMap<String, Option<String>>,
    global_signal_at: i64,
    transport_at: Option<i64>,
    exited: bool,
}

impl DeadlineIndex {
    /// Build the index over one state.
    pub fn new(state: &ThreadState) -> Self {
        let mut index = Self {
            silence: ExpiryMap::new(),
            wakes: ExpiryMap::new(),
            parents: std::collections::HashMap::new(),
            global_signal_at: 0,
            transport_at: None,
            exited: false,
        };
        index.rebuild(state);
        index
    }

    /// Rebuild the index over one state.
    pub fn rebuild(&mut self, state: &ThreadState) {
        self.exited = state.process_exit.is_some();
        self.silence.clear();
        self.wakes.clear();
        self.global_signal_at = 0;
        self.transport_at = None;
        for entry in candidates(state) {
            match entry.kind {
                CandidateKind::Transport => self.transport_at = Some(entry.at),
                CandidateKind::Silence => {
                    self.silence.set(entry.key, (), entry.at);
                }
                CandidateKind::Wake => {
                    self.wakes.set(entry.key, (), entry.at);
                }
            }
        }
        self.parents.clear();
        for (key, record) in state.agents.iter() {
            self.parents.insert(
                key.clone(),
                record
                    .agent
                    .parent_id
                    .clone()
                    .and_then(|parent_id| state.indexes.agent_keys_by_id.get(&parent_id).cloned()),
            );
        }
    }

    /// Move eligibility after a signal at `agent`.
    pub fn signal(&mut self, agent: Option<&str>, at: i64, silence_ms: f64) {
        let deadline = (at as f64 + silence_ms).floor() as i64 + 1;
        if self.transport_at.is_some() {
            self.transport_at = self.transport_at.map(|current| current.max(deadline));
        }
        let Some(agent) = agent else {
            self.global_signal_at = self.global_signal_at.max(deadline);
            return;
        };
        let mut seen = std::collections::HashSet::new();
        let mut key: Option<String> = Some(agent.to_owned());
        while let Some(name) = key {
            if !seen.insert(name.clone()) {
                break;
            }
            if let Some(current) = self.silence.deadline(&name) {
                self.silence.set(name.clone(), (), current.max(deadline));
            }
            key = self.parents.get(&name).cloned().flatten();
        }
    }

    /// The earliest deadline, if any.
    pub fn next(&self, provider_deadline: Option<i64>) -> Option<i64> {
        if self.exited {
            return None;
        }
        let silence = self
            .silence
            .first()
            .map(|(_, _, at)| at.max(self.global_signal_at));
        let wake = self.wakes.first().map(|(_, _, at)| at);
        let mut values = Vec::new();
        if let Some(at) = silence {
            values.push(at);
        }
        if let Some(at) = wake {
            values.push(at);
        }
        if let Some(at) = self.transport_at {
            values.push(at);
        }
        earliest(&values, provider_deadline)
    }
}
