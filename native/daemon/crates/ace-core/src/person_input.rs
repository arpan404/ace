// SPDX-License-Identifier: Apache-2.0
//! The person's next message and the thread's readiness (`person-input.ts`,
//! `transition-history.ts:8`-`:30`, E5.4c): whether the provider can take the person's words as
//! its next turn now, what Continue sends, and whether the tree is between turns at all. Pure
//! over the state; cost is proportional to live work, never to history.

use crate::emit::get;
use crate::indexes::pending_interaction_keys;
use crate::state::ThreadState;

/// What Continue sends after a Stop, a restart or a usage limit. The person's go-ahead, written
/// as their own words.
pub const CONTINUE_MESSAGE: &str = "Continue where you left off.";

/// Provider background work still running, or lost track of: work reopening or switching the
/// session would end (ADR 0116). ace's own bookkeeping is not provider work.
pub fn runs_provider_work(state: &ThreadState) -> bool {
    state
        .indexes
        .running_tasks
        .keys()
        .any(|key| get(&state.tasks, key).and_then(|task| task.owner.as_deref()) != Some("ace"))
        || !state.uncertain_tasks.is_empty()
}

/// Whether the provider can take a person's message as its next turn now. The person talks to
/// the root agent, so only the root's own turn matters; a provider-side queue drains first.
pub fn accepts_person_input(state: &ThreadState, now: i64) -> bool {
    if state.queue_sources.provider != 0 {
        return false;
    }
    let Some(root) = state
        .root_key
        .as_deref()
        .and_then(|key| get(&state.agents, key))
    else {
        return true;
    };
    if root.active_run.is_some()
        || root.retry.is_some()
        || root.limited.is_some()
        || root.disconnected_at.is_some()
    {
        return false;
    }
    if root.wake_until.is_some_and(|until| until > now) {
        return false;
    }
    pending_interaction_keys(state, Some(root.agent.id.as_str())).is_empty()
}

/// Whether the tree holds no live work and every agent is ready (`transition-history.ts:8`).
/// `agents_ready` is the readiness row's answer, which its owner reads.
pub fn quiescent(state: &ThreadState, agents_ready: bool) -> bool {
    // Exit.unsettled records agents that were live before exit, not work still running.
    if state.queue_sources.provider != 0 {
        return false;
    }
    if !state.indexes.live_tools.is_empty()
        || !state.indexes.pending_interactions.is_empty()
        || runs_provider_work(state)
    {
        return false;
    }
    agents_ready
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::ThreadState;

    /// A state with nothing folded into it yet: no root agent, no live work.
    fn empty() -> ThreadState {
        let value = ace_json::parse(
            r#"{"threadId":"t","config":{"provider":"codex","silenceMs":1000},"initialRoot":{"agent":"root","fidelity":"full","native":{"provider":"codex","nativeId":"n"},"cwd":"/tmp"},"agents":{},"runs":{},"items":{},"interactions":{},"tasks":{},"interactionHistory":{},"taskHistory":{},"indexes":{"liveTools":{},"pendingInteractions":{},"runningTasks":{},"agentKeysById":{},"childrenByParent":{},"pendingSpawnLinks":{},"pendingItemLinks":{}},"outcomeOrder":0,"pendingNotices":[],"itemLinks":{},"queueCount":0,"queueSources":{"engine":0,"provider":0},"hasRun":false,"status":{"state":"new"}}"#,
        )
        .expect("json");
        ace_json::from_value(&value).expect("a stored state")
    }

    #[test]
    fn a_thread_with_no_root_yet_takes_the_persons_message_unless_a_provider_queue_holds_it() {
        let mut state = empty();
        assert!(accepts_person_input(&state, 10));
        state.queue_sources.provider = 1;
        assert!(
            !accepts_person_input(&state, 10),
            "a provider-side queue drains first"
        );
    }

    #[test]
    fn live_tools_and_lost_work_hold_the_tree_and_an_unready_agent_does_too() {
        let mut state = empty();
        assert!(quiescent(&state, true));
        assert!(
            !quiescent(&state, false),
            "an unready agent is not quiescent"
        );
        state.indexes.live_tools.insert("tool".into(), true);
        assert!(!quiescent(&state, true));
        state.indexes.live_tools.clear();
        state.uncertain_tasks.insert("lost".into(), true);
        assert!(!quiescent(&state, true), "work ace lost track of holds it");
        state.uncertain_tasks.clear();
        assert!(!runs_provider_work(&state));
        assert_eq!(CONTINUE_MESSAGE, "Continue where you left off.");
    }
}
