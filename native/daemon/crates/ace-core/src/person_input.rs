// SPDX-License-Identifier: Apache-2.0
//! The person's next message (`person-input.ts:16`, E5.4c): whether the provider can take the
//! person's words as its next turn now, and what Continue sends. Pure over a loaded state; cost
//! is proportional to live work, never to history. The tree's quiescence is E5.3's view
//! (`Snapshot::quiescence_view`), read by its `MoveFacts` hook.

use crate::emit::get;
use crate::indexes::pending_interaction_keys;
use crate::state::ThreadState;

/// What Continue sends after a Stop, a restart or a usage limit. The person's go-ahead, written
/// as their own words.
pub const CONTINUE_MESSAGE: &str = "Continue where you left off.";

/// Whether the provider can take a person's message as its next turn now. The person talks to
/// the root agent, so only the root's own turn matters; a provider-side queue drains first.
/// The state passed here is loaded: the caller reads the root and the indexed records first.
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
    fn continue_is_the_persons_go_ahead() {
        assert_eq!(CONTINUE_MESSAGE, "Continue where you left off.");
    }
}
