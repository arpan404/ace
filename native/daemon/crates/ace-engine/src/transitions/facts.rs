// SPDX-License-Identifier: Apache-2.0
//! E5.9's `MoveFacts`: the fold's synchronous questions about a thread's transition, its fork's
//! replay and the readiness rows a batch leaves behind. One impl of E5.3's trait, so every hook
//! an unported path used to answer with `NativeEngineIncomplete` now answers from this item.
//!
//! The TypeScript is `fork-replay.ts`, `transition-readiness.ts` and `repository.ts:485`-
//! `:507`; the pure cases live beside their decisions in `fork_replay.rs` and `readiness.rs`.
//! These methods only read the two rows a transition writes (the metadata and the thread's
//! lineage) and hand the decision to them.

use ace_json::Value;

use crate::repository::collaborators::{MoveFacts, QuiescenceView, Selection};
use crate::transitions::fork_replay;
use crate::transitions::readiness;
use crate::{EngineError, EngineStore, State};

/// `forkReplaySource` (`fork-replay.ts:12`): the source thread, when the opening fork is the
/// provider's own inherited fork. The lineage read is the thread row's own JSON.
pub fn fork_replay_source(
    store: &EngineStore,
    metadata: &crate::transitions::metadata::TransitionMetadata,
    thread: &str,
) -> Result<Option<Value>, EngineError> {
    let lineage = store
        .get_thread(thread)?
        .and_then(|json| ace_json::parse(&json).ok())
        .and_then(|thread| {
            thread
                .get("lineage")
                .and_then(|lineage| lineage.get("parentThreadId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    Ok(fork_replay::fork_replay_source(metadata, lineage.as_deref()).map(Value::from))
}

/// `transitions.get(id).selection` (`repository.ts:495`): the selection a thread's transition
/// records, or none when it has never switched.
pub fn transition_selection(
    store: &EngineStore,
    state: &mut State,
    thread: &str,
) -> Result<Option<Selection>, EngineError> {
    let metadata = state.transition_get(store, thread)?;
    let Some(selection) = metadata.selection else {
        return Ok(None);
    };
    let text = |key: &str| {
        selection
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    Ok(Some(Selection {
        provider: text("provider"),
        model: text("model"),
        instance_id: text("instanceId"),
    }))
}

impl MoveFacts for State {
    /// `forkReplaySource`: only a native fork that marks its turns inherited names its source.
    fn fork_replay_source(&mut self, thread: &str) -> Result<Option<Value>, EngineError> {
        let Some(core) = self.engine.upgrade() else {
            return Ok(None);
        };
        let metadata = self.transition_get(&core.store, thread)?;
        fork_replay_source(&core.store, &metadata, thread)
    }

    /// `inheritedReplay`: the pure decision, over the state's item keys.
    fn inherited_replay(
        &mut self,
        fact: Value,
        source: &Value,
        state: &ace_core::state::ThreadState,
    ) -> Result<Value, EngineError> {
        let Some(source) = source.as_str() else {
            return Ok(fact);
        };
        Ok(fork_replay::inherited_replay(&fact, source, |item| {
            state.items.contains_key(item)
        }))
    }

    /// `transitions.get`: the thread's current selection.
    fn transitions_get(&mut self, thread: &str) -> Result<Option<Selection>, EngineError> {
        let Some(core) = self.engine.upgrade() else {
            return Ok(None);
        };
        transition_selection(&core.store, self, thread)
    }

    /// `transitions.delivered` (`transition-state.ts:120`): what a taken input consumed.
    fn transitions_delivered(&mut self, thread: &str) -> Result<(), EngineError> {
        let Some(core) = self.engine.upgrade() else {
            return Ok(());
        };
        self.transition_delivered(&core.store, thread)
    }

    /// `readiness.capture`: the agents a batch touched get their blocker row from its state.
    fn readiness_capture(
        &mut self,
        state: &ace_core::state::ThreadState,
        events: &[Value],
    ) -> Result<(), EngineError> {
        let Some(core) = self.engine.upgrade() else {
            return Ok(());
        };
        let now = self.readiness_now();
        readiness::capture(state, core.store.conn(), events, now)
    }

    /// `readiness.refreshBlocked`: the thread's blockers follow its agents.
    fn readiness_refresh_blocked(
        &mut self,
        state: &ace_core::state::ThreadState,
    ) -> Result<(), EngineError> {
        let now = self.readiness_now();
        let thread = state.thread_id.clone();
        self.refresh_blocked_now(&thread, now)
    }

    /// `readiness.agentsReady`.
    fn readiness_agents_ready(&mut self, thread: &str) -> Result<bool, EngineError> {
        let Some(core) = self.engine.upgrade() else {
            return Ok(true);
        };
        readiness::agents_ready(core.store.conn(), thread)
    }

    /// `readiness.acceptsPersonInput`: the root is between turns and free for the next message,
    /// read through the snapshot's records.
    fn readiness_accepts_person_input(
        &mut self,
        state: &ace_core::state::ThreadState,
    ) -> Result<bool, EngineError> {
        let now = self.readiness_now();
        let thread = state.thread_id.clone();
        if self.readiness_snapshot(&thread)?.is_none() {
            return Ok(ace_core::person_input::accepts_person_input(state, now));
        }
        readiness::accepts_person_input(self, &thread, now)
    }

    /// `quiescent` (`transition-history.ts:8`), over E5.3's view.
    fn quiescent(
        &mut self,
        view: &QuiescenceView,
        agents_ready: bool,
    ) -> Result<bool, EngineError> {
        Ok(readiness::quiescent(view, agents_ready))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repository::testsupport::{Shell, header, home};

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    #[test]
    fn a_transition_selection_is_read_and_a_delivered_handoff_is_cleared() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        let mut state = State::default();
        assert!(
            transition_selection(&store, &mut state, "t")
                .expect("no transition")
                .is_none()
        );
        state
            .transition_set(
                &store,
                "t",
                &value(
                    r#"{"selection":{"provider":"codex","model":"gpt","instanceId":"a","options":{}},
                       "handoff":{"version":1,"sourceThreadId":"src"},
                       "marker":"handoff:cmd",
                       "fallback":{"provider":"claude"},
                       "context":["carried"]}"#,
                ),
            )
            .expect("metadata");
        let selection = transition_selection(&store, &mut state, "t")
            .expect("selection")
            .expect("some");
        assert_eq!(
            (selection.provider.as_deref(), selection.model.as_deref()),
            (Some("codex"), Some("gpt"))
        );
        assert_eq!(selection.instance_id.as_deref(), Some("a"));
        // A taken input consumes the waiting handoff, its marker and the context, and keeps
        // the selection a later switch starts from.
        state.transition_delivered(&store, "t").expect("delivered");
        let metadata = state.transition_get(&store, "t").expect("metadata");
        assert!(metadata.handoff.is_none());
        assert!(metadata.marker.is_none());
        assert!(metadata.fallback.is_none());
        assert!(metadata.context.is_empty());
        assert!(metadata.selection.is_some());
    }

    #[test]
    fn a_fork_without_inherited_turns_names_no_replay_source() {
        let conn = home("t", &header("t"));
        let store = Shell::store(&conn);
        let inherited = crate::transitions::metadata::TransitionMetadata {
            fork: Some(value(r#"{"nativeSessionId":"s","inherited":true}"#)),
            ..Default::default()
        };
        // The test shell has no thread row, so there is no lineage to name.
        assert_eq!(
            fork_replay_source(&store, &inherited, "t").expect("source"),
            None
        );
        let plain = crate::transitions::metadata::TransitionMetadata::default();
        assert_eq!(
            fork_replay_source(&store, &plain, "t").expect("source"),
            None
        );
    }
}
