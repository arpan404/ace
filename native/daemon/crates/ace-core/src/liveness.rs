// SPDX-License-Identifier: Apache-2.0
//! Liveness signals of `liveness.ts`: the transport watermark and the
//! ancestor walk a delta uses to revive its branch.

use std::collections::HashSet;

use crate::emit::get;
use crate::state::ThreadState;

/// The transport watermark: the last explicit transport signal, or the
/// latest agent signal when no fact has moved it.
pub fn transport_signal_at(state: &ThreadState) -> i64 {
    state.last_transport_signal_at.unwrap_or_else(|| {
        state
            .agents
            .values()
            .map(|record| record.last_signal_at)
            .max()
            .unwrap_or(0)
    })
}

/// A known delta can revive an ancestor even when its own owner is idle.
pub fn has_unresponsive_ancestor(state: &ThreadState, key: &str) -> bool {
    let mut visited = HashSet::new();
    let mut current: Option<String> = Some(key.to_owned());
    while let Some(name) = current {
        if !visited.insert(name.clone()) {
            break;
        }
        let record = match get(&state.agents, &name) {
            Some(record) => record,
            None => return false,
        };
        if record.agent.status.state() == "unresponsive" {
            return true;
        }
        current = match &record.agent.parent_id {
            None => None,
            Some(parent_id) => get(&state.indexes.agent_keys_by_id, parent_id).cloned(),
        };
    }
    false
}

/// Ephemeral memoization sharing one subtree walk across a status or
/// deadline derivation.
pub struct SubtreeSignalReader<'a> {
    state: &'a ThreadState,
    cached: std::collections::HashMap<String, i64>,
    visiting: HashSet<String>,
    depth: usize,
}

/// Depth bound for subtree walks over restored agent links.
const SUBTREE_DEPTH_LIMIT: usize = 4096;

impl<'a> SubtreeSignalReader<'a> {
    /// Read over `state`, memoizing per key.
    pub fn new(state: &'a ThreadState) -> Self {
        Self {
            state,
            cached: std::collections::HashMap::new(),
            visiting: HashSet::new(),
            depth: 0,
        }
    }

    /// The latest signal at or below `key`, guarding malformed cycles.
    pub fn read(&mut self, key: &str) -> i64 {
        self.read_inner(key)
    }

    fn read_inner(&mut self, key: &str) -> i64 {
        if let Some(signal) = self.cached.get(key) {
            return *signal;
        }
        if self.depth > SUBTREE_DEPTH_LIMIT {
            return get(&self.state.agents, key).map_or(0, |record| record.last_signal_at);
        }
        let record = match get(&self.state.agents, key) {
            Some(record) => record,
            None => return 0,
        };
        if !self.visiting.insert(key.to_owned()) {
            return record.last_signal_at;
        }
        self.depth += 1;
        let mut latest = record.last_signal_at;
        let agent_id = record.agent.id.clone();
        let children: Vec<String> = get(&self.state.indexes.children_by_parent, &agent_id)
            .map(|children| children.keys().cloned().collect())
            .unwrap_or_default();
        for child in children {
            latest = latest.max(self.read_inner(&child));
        }
        self.depth -= 1;
        self.visiting.remove(key);
        self.cached.insert(key.to_owned(), latest);
        latest
    }
}
