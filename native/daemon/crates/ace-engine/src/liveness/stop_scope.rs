// SPDX-License-Identifier: Apache-2.0
//! Ported by E5.4d as a synchronous receipt dependency; owned by E5.10.
//!
//! `stop-scope.ts:10` (`targetsRoot`): whether a Stop is about the thread's root agent. Naming
//! the root agent's own id is the same as naming no agent.

/// The Stop is about the thread's root agent: no agent named, or the root's own id.
pub fn targets_root(agent_id: Option<&str>, root_agent_id: Option<&str>) -> bool {
    match agent_id {
        None => true,
        Some(agent) => Some(agent) == root_agent_id,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_targets_the_root_when_it_names_none_or_the_roots_own_id() {
        assert!(targets_root(None, Some("root")));
        assert!(targets_root(None, None));
        assert!(targets_root(Some("root"), Some("root")));
        assert!(!targets_root(Some("child"), Some("root")));
        assert!(!targets_root(Some("child"), None));
    }
}
