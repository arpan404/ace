// SPDX-License-Identifier: Apache-2.0
//! One trait per owner for every call the persistence frame makes into a module another E5 item
//! owns (E5.3 step 7). A method nobody has implemented yet returns
//! `Err(EngineError::not_ported("<what>", "E5.<n>"))`: unported paths fail at the call, never
//! silently no-op.
//!
//! The `impl <Trait> for State {}` lines sit at the end of this file. An owner implements its
//! methods in its own module and deletes its one empty `impl` line here in the same commit. The
//! probe's pass-through (`probe_passthrough_collaborators`, `engine-probe` only) answers the
//! same calls with the fact unchanged or no rows, so a plain fold runs before E5.4 to E5.9 land;
//! the last owner to land deletes it.

use ace_core::ThreadState;
use ace_core::item_model::ToolCall;
use ace_json::Value;

use crate::{EngineError, EngineStore, State};

/// What `session(id)` answers: the thread's model and native session id (E5.6).
#[derive(Debug, Clone, Default)]
pub struct SessionInfo {
    pub model: Option<String>,
    pub native_session_id: Option<String>,
    /// The provider backend, for `captureFrame`'s Cursor SDK check.
    pub backend: Option<String>,
}

/// The engine queue's metadata (E5.4's `queue.get`).
#[derive(Debug, Clone, Default)]
pub struct QueueInfo {
    pub continuation: bool,
    pub trigger: Option<String>,
    pub limited: bool,
    pub paused: bool,
    pub reason: Option<String>,
}

/// A pending in-flight input (E5.4's `pending.handedOver`).
#[derive(Debug, Clone)]
pub struct PendingInfo {
    pub id: i64,
    pub command_id: String,
    pub continuation: bool,
}

/// What `quiescent` reads from a stored state (`transition-history.ts:8`), copied out of the
/// snapshot so no snapshot borrow is held across the collaborator call.
#[derive(Debug, Clone, Default)]
pub struct QuiescenceView {
    /// A provider-sourced queued message: it waits on the provider, not on the fold.
    pub provider_queue: bool,
    pub live_tools: usize,
    pub pending_interactions: usize,
    /// Provider background work still running or lost track of (`runsProviderWork`).
    pub provider_work: bool,
}

/// The run selection a save stamps on a root run (E5.9's `transitions.get`, else the thread's
/// own config and session).
#[derive(Debug, Clone, Default)]
pub struct Selection {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub instance_id: Option<String>,
}

/// The one gate every unported collaborator call goes through: the probe's pass-through when
/// it is on, else `NativeEngineIncomplete: <what> lands in <item>`.
pub trait ProbeGate {
    fn not_ported<T>(
        &self,
        what: &'static str,
        item: &'static str,
        probe: T,
    ) -> Result<T, EngineError>;
}

impl ProbeGate for State {
    fn not_ported<T>(
        &self,
        what: &'static str,
        item: &'static str,
        probe: T,
    ) -> Result<T, EngineError> {
        if self.repo.probe_passthrough {
            Ok(probe)
        } else {
            Err(EngineError::not_ported(what, item))
        }
    }
}

/// E5.2's frame facts.
pub trait FrameFacts: ProbeGate {
    /// `coalesceFacts` (`delta-batch.ts`).
    fn coalesce_facts(&mut self, facts: Vec<Value>) -> Result<Vec<Value>, EngineError> {
        self.not_ported("coalescing a batch's facts", "E5.2", facts)
    }
    /// `streamFacts` (`stream-facts.ts`), the live path: the fold over the repository's own
    /// snapshot, returned as the batch's events.
    fn stream_facts(
        &mut self,
        _store: &EngineStore,
        _thread: &str,
        _facts_json: &str,
        _now: f64,
    ) -> Result<String, EngineError> {
        self.not_ported("a live stream's facts", "E5.2", String::new())
    }
    /// `streamedFactsBytes` (`fact-bytes.ts`).
    fn streamed_facts_bytes(&mut self, _facts_json: &str) -> Result<f64, EngineError> {
        self.not_ported("a live stream's size", "E5.2", 0.0)
    }
    /// `capFact` (`raw.ts`): the previous stored call of the same item, for its normalisation.
    fn cap_fact(
        &mut self,
        _store: &EngineStore,
        _thread: &str,
        fact: Value,
        _previous: Option<&ToolCall>,
    ) -> Result<Value, EngineError> {
        self.not_ported("capping a fact", "E5.2", fact)
    }
    /// `boundedJson` (`@ace/provider-kit/ipc`).
    fn bounded_json(&mut self, value: &Value) -> Result<String, EngineError> {
        self.not_ported("a bounded frame", "E5.2", ace_json::to_string(value))
    }
}

/// E5.4's input facts.
pub trait InputFacts: ProbeGate {
    /// `inputs.correlate`: `None` drops the fact. `generation` is the frame's session
    /// generation, and none while the fold replays stored history (`provider-facts.ts:97`).
    fn correlate(
        &mut self,
        _thread: &str,
        fact: Value,
        _generation: Option<f64>,
    ) -> Result<Option<Value>, EngineError> {
        self.not_ported("correlating a provider fact", "E5.4", Some(fact))
    }
    /// `inputs.keyFor`.
    fn input_key_for(
        &mut self,
        _thread: &str,
        _native_input_id: &str,
    ) -> Result<Option<String>, EngineError> {
        self.not_ported("a native input's key", "E5.4", None)
    }
    /// `aceInputs.attribute`.
    fn attribute_input(&mut self, _thread: &str, fact: Value) -> Result<Value, EngineError> {
        self.not_ported("attributing an ace input", "E5.4", fact)
    }
    /// `pending.handedOver`.
    fn handed_over(&mut self, _thread: &str) -> Result<Option<PendingInfo>, EngineError> {
        self.not_ported("a handed-over input", "E5.4", None)
    }
    /// `pending.uncertainContinuation`.
    fn uncertain_continuation(
        &mut self,
        _thread: &str,
    ) -> Result<Option<PendingInfo>, EngineError> {
        self.not_ported("an uncertain continuation", "E5.4", None)
    }
    /// `pending.resolvingInteractions`.
    fn resolving_interactions(&mut self, _thread: &str) -> Result<Vec<String>, EngineError> {
        self.not_ported("the resolving interactions", "E5.4", Vec::new())
    }
    /// `pending.finishContinuation`.
    fn finish_continuation(&mut self, _thread: &str) -> Result<(), EngineError> {
        self.not_ported("finishing a continuation", "E5.4", ())
    }
    /// `pending.awaiting`.
    fn awaiting(&mut self, _thread: &str) -> Result<bool, EngineError> {
        self.not_ported("an awaited input", "E5.4", false)
    }
    /// `queue.get`.
    fn queue_get(&mut self, _thread: &str) -> Result<QueueInfo, EngineError> {
        self.not_ported("the engine queue", "E5.4", QueueInfo::default())
    }
    /// `queue.set`.
    fn queue_set(&mut self, _thread: &str, _json: &str, _at: f64) -> Result<(), EngineError> {
        self.not_ported("a queue update", "E5.4", ())
    }
    /// `queue.prune`.
    fn queue_prune(&mut self, _id: i64) -> Result<(), EngineError> {
        self.not_ported("a queue prune", "E5.4", ())
    }
    /// `queue.hasUncertain`.
    fn queue_has_uncertain(&mut self, _thread: &str) -> Result<bool, EngineError> {
        self.not_ported("an uncertain queue entry", "E5.4", false)
    }
    /// `bindConsumedInput`.
    fn bind_consumed_input(
        &mut self,
        _thread: &str,
        _key: &str,
        _generation: Option<f64>,
        _now: f64,
    ) -> Result<Vec<Value>, EngineError> {
        self.not_ported("a consumed input's binding", "E5.4", Vec::new())
    }
    /// `bindStartedRun`.
    fn bind_started_run(
        &mut self,
        _thread: &str,
        _run: &str,
        _generation: Option<f64>,
    ) -> Result<Vec<Value>, EngineError> {
        self.not_ported("a started run's binding", "E5.4", Vec::new())
    }
    /// `retireEndedTurnInputs`.
    fn retire_ended_turn_inputs(
        &mut self,
        _thread: &str,
        _generation: f64,
        _now: f64,
    ) -> Result<(), EngineError> {
        self.not_ported("retiring an ended turn's inputs", "E5.4", ())
    }
    /// `aceWaitFact`.
    fn ace_wait_fact(
        &mut self,
        _thread: &str,
        _fact: &Value,
    ) -> Result<Option<Value>, EngineError> {
        self.not_ported("an ace wait fact", "E5.4", None)
    }
    /// `goalChange`: `None` is the provider's absent goal, `Some(Null)` its null.
    fn goal_change(
        &mut self,
        _current: Option<&Value>,
        _goal: Option<&Value>,
    ) -> Result<Option<Value>, EngineError> {
        self.not_ported("a provider goal change", "E5.4a", None)
    }
    /// `rootRunStart`: the trigger and whether the run takes the handed input.
    fn root_run_start(
        &mut self,
        trigger: &str,
        _handed: Option<&PendingInfo>,
    ) -> Result<(String, bool), EngineError> {
        self.not_ported("a root run start", "E5.4", (trigger.to_owned(), true))
    }
}

/// E5.6's session facts.
pub trait SessionFacts: ProbeGate {
    /// `session(id)`: the thread's model and native session id.
    fn session(&mut self, _thread: &str) -> Result<SessionInfo, EngineError> {
        self.not_ported("a provider session", "E5.6", SessionInfo::default())
    }
    /// `shapeProviderError`.
    fn shape_provider_error(
        &mut self,
        fact: Value,
        _provider: &str,
        _model: Option<&str>,
    ) -> Result<Value, EngineError> {
        self.not_ported("a provider error", "E5.6", fact)
    }
    /// `structuredError`.
    fn structured_error(&mut self, error: Value, _provider: &str) -> Result<Value, EngineError> {
        self.not_ported("a structured error", "E5.6", error)
    }
}

/// E5.7's access and interaction facts.
pub trait AccessFacts: ProbeGate {
    /// `permissions.effective`: the root turn's permission mode.
    fn permissions_effective(&mut self, _thread: &str) -> Result<Option<String>, EngineError> {
        self.not_ported("the effective permissions", "E5.7", None)
    }
    /// `interactions.obsolete`: whether the fact is for an interaction ace already settled.
    fn interactions_obsolete(&mut self, _thread: &str, _fact: &Value) -> Result<bool, EngineError> {
        self.not_ported("an obsolete interaction check", "E5.7", false)
    }
    /// `interactions.opened`.
    fn interactions_opened(
        &mut self,
        _thread: &str,
        _fact: &Value,
        _generation: Option<f64>,
    ) -> Result<(), EngineError> {
        self.not_ported("an opened interaction", "E5.7", ())
    }
    /// `interactions.closed`: the facts a settled interaction emits.
    fn interactions_closed(&mut self, _event: &Value) -> Result<Vec<Value>, EngineError> {
        self.not_ported("a closed interaction", "E5.7", Vec::new())
    }
    /// `interactions.observe`.
    fn interactions_observe(
        &mut self,
        _thread: &str,
        _events: &[Value],
    ) -> Result<(), EngineError> {
        self.not_ported("an interaction observation", "E5.7", ())
    }
    /// `attributeAceAction`.
    fn attribute_ace_action(&mut self, _thread: &str, fact: Value) -> Result<Value, EngineError> {
        self.not_ported("an ace action's attribution", "E5.7", fact)
    }
}

/// E5.8's recovery facts.
pub trait RecoveryFacts: ProbeGate {
    /// `resendingCode` (`cursor-attempt.ts`).
    fn resending_code(&mut self) -> Result<&'static str, EngineError> {
        self.not_ported("a resending notice's code", "E5.8", "")
    }
    /// `resentNotice` (`cursor-attempt.ts`).
    fn resent_notice(&mut self) -> Result<Value, EngineError> {
        self.not_ported("a resent notice", "E5.8", Value::Null)
    }
}

/// E5.9's move, transition and readiness facts.
pub trait MoveFacts: ProbeGate {
    /// `forkReplaySource` (`fork-replay.ts`).
    fn fork_replay_source(&mut self, _thread: &str) -> Result<Option<Value>, EngineError> {
        self.not_ported("a fork's replay source", "E5.9", None)
    }
    /// `inheritedReplay`.
    fn inherited_replay(
        &mut self,
        fact: Value,
        _source: &Value,
        _state: &ThreadState,
    ) -> Result<Value, EngineError> {
        self.not_ported("an inherited replay", "E5.9", fact)
    }
    /// `transitions.get`: the thread's current selection.
    fn transitions_get(&mut self, _thread: &str) -> Result<Option<Selection>, EngineError> {
        self.not_ported("the thread's transition", "E5.9", None)
    }
    /// `transitions.delivered`.
    fn transitions_delivered(&mut self, _thread: &str) -> Result<(), EngineError> {
        self.not_ported("a delivered transition", "E5.9", ())
    }
    /// `readiness.capture`.
    fn readiness_capture(
        &mut self,
        _state: &ThreadState,
        _events: &[Value],
    ) -> Result<(), EngineError> {
        self.not_ported("a readiness capture", "E5.9", ())
    }
    /// `readiness.refreshBlocked`.
    fn readiness_refresh_blocked(&mut self, _state: &ThreadState) -> Result<(), EngineError> {
        self.not_ported("a blocked readiness refresh", "E5.9", ())
    }
    /// `readiness.agentsReady`.
    fn readiness_agents_ready(&mut self, _thread: &str) -> Result<bool, EngineError> {
        self.not_ported("an agents-ready answer", "E5.9", false)
    }
    /// `readiness.acceptsPersonInput`.
    fn readiness_accepts_person_input(
        &mut self,
        _state: &ThreadState,
    ) -> Result<bool, EngineError> {
        self.not_ported("an input-ready answer", "E5.9", false)
    }
    /// `quiescent` (`transition-history.ts:8`). The view carries the state it reads, so the
    /// caller never holds a snapshot borrow across this call.
    fn quiescent(
        &mut self,
        _view: &QuiescenceView,
        _agents_ready: bool,
    ) -> Result<bool, EngineError> {
        self.not_ported("quiescence", "E5.9", false)
    }
}

impl FrameFacts for State {
    /// `coalesceFacts` (`delta-batch.ts:4`): adjacent deltas of one item merge up to 4 KiB.
    fn coalesce_facts(&mut self, facts: Vec<Value>) -> Result<Vec<Value>, EngineError> {
        Ok(crate::frames::coalesce_facts(&facts))
    }

    /// `streamFacts` (`stream-facts.ts:7`): the canonical reducer over the resident snapshot.
    fn stream_facts(
        &mut self,
        store: &EngineStore,
        thread: &str,
        facts_json: &str,
        now: f64,
    ) -> Result<String, EngineError> {
        let facts = Self::facts(facts_json)?;
        let snapshot = self.repo.require_state(store, thread)?;
        let deadline = snapshot.borrow_mut().deadline(None);
        let mut ids = super::fold::store_ids(store);
        let mut borrowed = snapshot.borrow_mut();
        let mut live = crate::snapshot::stream::LiveStream::new(&mut borrowed, deadline);
        let events = crate::frames::stream_facts(&mut live, &facts, now as i64, &mut ids);
        if let Some(error) = live.take_error() {
            return Err(error);
        }
        drop(live);
        let mut json = String::new();
        ace_core::event_json::write_events(&events, &mut json);
        Ok(json)
    }

    /// `streamedFactsBytes` (`fact-bytes.ts:7`): the batch's JSON size, in bytes.
    fn streamed_facts_bytes(&mut self, facts_json: &str) -> Result<f64, EngineError> {
        let facts = Self::facts(facts_json)?;
        Ok(crate::frames::streamed_facts_bytes(&facts) as f64)
    }

    /// `capFact` (`raw.ts:8`): the ace-call normalisation and the store's `capRaw`.
    fn cap_fact(
        &mut self,
        store: &EngineStore,
        thread: &str,
        fact: Value,
        previous: Option<&ToolCall>,
    ) -> Result<Value, EngineError> {
        crate::frames::cap_fact(
            &mut |raw| {
                let capped = store.cap_raw(thread, &ace_json::to_string(&raw))?;
                ace_json::parse(&capped).map_err(|error| EngineError::Records(error.to_string()))
            },
            fact,
            previous,
        )
    }
}
impl SessionFacts for State {}
impl AccessFacts for State {}
impl RecoveryFacts for State {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_production_frame_facts_coalesce_and_measure_a_batch() {
        // E5.2 has landed, so a fold's first collaborator call is its own code, not NotPorted.
        let mut state = State::default();
        let batch = r#"[{"type":"item.delta","agent":"root","item":"i","field":"text","append":"a"},{"type":"item.delta","agent":"root","item":"i","field":"text","append":"b"}]"#;
        let facts = State::facts(batch).unwrap();
        let merged = state.coalesce_facts(facts).unwrap();
        assert_eq!(merged.len(), 1, "the two appends are one fact");
        let bytes = state.streamed_facts_bytes(batch).unwrap();
        assert_eq!(
            bytes as usize,
            crate::frames::streamed_facts_bytes(&State::facts(batch).unwrap())
        );
    }
}
