// SPDX-License-Identifier: Apache-2.0
//! What the `sim_*` tools and `ace sim` remember per agent
//! (`packages/devices/src/sim-state.ts`), shared so both see the same refs.

use indexmap::IndexSet;

use super::sim_refs::SimRefs;

/// How many agents' first starts are remembered.
pub const MAX_GUIDED: usize = 1024;

/// `SimAgentState`: the refs, and which agent has already had the how-to.
#[derive(Debug, Default)]
pub struct SimAgentState {
    pub refs: SimRefs,
    guided: IndexSet<String>,
}

impl SimAgentState {
    pub fn new() -> Self {
        Self::default()
    }

    /// `firstStart`: true the first time this agent starts this device, the
    /// moment it needs the how-to. The oldest are forgotten past the cap.
    pub fn first_start(&mut self, owner: &str, device: &str) -> bool {
        let key = ace_json::to_string(&ace_json::json!([owner, device]));
        if self.guided.contains(&key) {
            return false;
        }
        self.guided.insert(key);
        while self.guided.len() > MAX_GUIDED {
            let Some(oldest) = self.guided.get_index(0).cloned() else {
                break;
            };
            self.guided.shift_remove(&oldest);
        }
        true
    }

    /// How many agents are remembered, for tests and diagnostics.
    pub fn guided(&self) -> usize {
        self.guided.len()
    }
}

#[cfg(test)]
mod tests;
