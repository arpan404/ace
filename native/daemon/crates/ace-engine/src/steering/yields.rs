// SPDX-License-Identifier: Apache-2.0
//! `steer-yield.ts` (E5.5): the run ace interrupted so a person's steer reaches the model now,
//! the record of it, and the facts its end is marked with.

use ace_core::state::ThreadState;
use ace_json::Value;

/// Whether the provider took the interrupt. A refused one never retries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum YieldState {
    Pending,
    Refused,
}

/// The run ace interrupted for a steer, and the waiting steer it made way for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SteerYield {
    pub run: String,
    pub state: YieldState,
    pub intent_id: Option<i64>,
}

/// Each thread's yield, as E5.5's `steerNow`/`yieldTurn` record it. E5.2's actor does not carry
/// it, so the engine keeps it here beside the other per-thread bookkeeping.
#[derive(Debug, Default)]
pub struct Steering {
    yields: std::collections::HashMap<crate::ThreadId, SteerYield>,
}

impl Steering {
    pub fn yield_for(&self, thread: &str) -> Option<&SteerYield> {
        self.yields.get(thread)
    }

    pub fn set_yield(&mut self, thread: &str, yielded: SteerYield) {
        self.yields.insert(thread.to_owned(), yielded);
    }

    /// A yield whose run is no longer the root's is stale: the lane forgets it.
    pub fn clear_stale(&mut self, thread: &str, run: Option<&str>) {
        let Some(run) = run else {
            return;
        };
        if self
            .yields
            .get(thread)
            .is_some_and(|yielded| yielded.run != run)
        {
            self.yields.remove(thread);
        }
    }

    pub fn clear(&mut self, thread: &str) {
        self.yields.remove(thread);
    }
}

/// `markYieldedEnd`: the root's turn end that made way for the person's message reads as
/// continuing into the steer, not as a stop.
pub fn mark_yielded_end(
    facts: Vec<Value>,
    state: &ThreadState,
    yielded: Option<&SteerYield>,
) -> Vec<Value> {
    if !super::route::yield_in_flight(state, yielded) {
        return facts;
    }
    let Some(yielded) = yielded else {
        return facts;
    };
    let native_id = state
        .runs
        .get(&yielded.run)
        .and_then(|run| run.native_id.clone());
    if !facts
        .iter()
        .any(|fact| fact.get("type").and_then(Value::as_str) == Some("turn.ended"))
    {
        return facts;
    }
    let root = state.root_key.as_deref();
    facts
        .into_iter()
        .map(|fact| {
            let is_end = fact.get("type").and_then(Value::as_str) == Some("turn.ended")
                && fact.get("agent").and_then(Value::as_str) == root
                && fact.get("outcome").and_then(Value::as_str) == Some("interrupted")
                && fact.get("historical") != Some(&Value::Bool(true));
            let same_turn = match (fact.get("nativeTurnId").and_then(Value::as_str), &native_id) {
                (Some(turn), Some(native)) => turn == native,
                _ => true,
            };
            if !is_end || !same_turn {
                return fact;
            }
            let mut marked = fact;
            if let Some(object) = marked.as_object_mut() {
                object.insert("endedBy", Value::from("steer"));
            }
            marked
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ace_core::state::{AgentRecord, CoreConfig, create_thread_state};

    fn value(text: &str) -> Value {
        ace_json::parse(text).expect("json")
    }

    fn state(active_run: Option<&str>, native_id: Option<&str>) -> ThreadState {
        let mut state = create_thread_state(
            "thread-1".to_owned(),
            None,
            CoreConfig {
                provider: "codex".to_owned(),
                silence_ms: 1_000.0,
                liveness: None,
            },
        )
        .expect("state");
        state.root_key = Some("root".to_owned());
        let extra = active_run
            .map(|run| format!(r#","activeRun":"{run}""#))
            .unwrap_or_default();
        let record: AgentRecord = ace_json::from_value(&value(&format!(
            r#"{{"agent":{{"id":"agent-1","threadId":"thread-1","parentId":null,"origin":"root","native":{{"provider":"codex"}},"status":{{"state":"idle"}},"fidelity":"full","cwd":"/test","background":false,"createdAt":1}},"activity":"idle","lastSignalAt":1{extra}}}"#
        )))
        .expect("record");
        state.agents.insert("root".to_owned(), record);
        let run: ace_core::runs::Run = ace_json::from_value(&value(&format!(
            r#"{{"id":"run-1","seq":1,"threadId":"thread-1","agentId":"agent-1","trigger":"user","state":"active","startedAt":1{}}}"#,
            native_id
                .map(|native| format!(r#","nativeId":"{native}""#))
                .unwrap_or_default()
        )))
        .expect("run");
        state.runs.insert("run-1".to_owned(), run);
        state
    }

    fn pending(run: &str) -> SteerYield {
        SteerYield {
            run: run.to_owned(),
            state: YieldState::Pending,
            intent_id: Some(7),
        }
    }

    #[test]
    fn the_root_turn_end_that_made_way_for_a_steer_is_marked_and_nothing_else_is() {
        let state = state(Some("run-1"), Some("native-1"));
        let facts = vec![
            value(
                r#"{"type":"turn.ended","agent":"root","outcome":"interrupted","nativeTurnId":"native-1"}"#,
            ),
            value(
                r#"{"type":"turn.ended","agent":"child","outcome":"interrupted","nativeTurnId":"native-1"}"#,
            ),
            value(
                r#"{"type":"turn.ended","agent":"root","outcome":"completed","nativeTurnId":"native-1"}"#,
            ),
            value(
                r#"{"type":"turn.ended","agent":"root","outcome":"interrupted","historical":true,"nativeTurnId":"native-1"}"#,
            ),
            value(
                r#"{"type":"turn.ended","agent":"root","outcome":"interrupted","nativeTurnId":"other"}"#,
            ),
            value(r#"{"type":"item.upsert","agent":"root"}"#),
        ];
        let marked = mark_yielded_end(facts, &state, Some(&pending("run-1")));
        assert_eq!(
            marked[0].get("endedBy").and_then(Value::as_str),
            Some("steer")
        );
        for fact in &marked[1..] {
            assert_eq!(fact.get("endedBy"), None, "{fact}");
        }
    }

    #[test]
    fn a_turn_end_with_no_native_id_on_either_side_still_matches_and_a_yield_not_in_flight_marks_nothing()
     {
        let state = state(Some("run-1"), None);
        let facts = vec![value(
            r#"{"type":"turn.ended","agent":"root","outcome":"interrupted"}"#,
        )];
        let marked = mark_yielded_end(facts.clone(), &state, Some(&pending("run-1")));
        assert_eq!(
            marked[0].get("endedBy").and_then(Value::as_str),
            Some("steer")
        );
        // Another run's yield, or a refused one, is not in flight.
        assert_eq!(
            mark_yielded_end(facts.clone(), &state, Some(&pending("run-2")))[0].get("endedBy"),
            None
        );
        let refused = SteerYield {
            run: "run-1".to_owned(),
            state: YieldState::Refused,
            intent_id: Some(7),
        };
        assert_eq!(
            mark_yielded_end(facts.clone(), &state, Some(&refused))[0].get("endedBy"),
            None
        );
        assert_eq!(
            mark_yielded_end(facts, &state, None)[0].get("endedBy"),
            None
        );
    }

    #[test]
    fn the_engines_record_keeps_one_yield_per_thread_and_forgets_a_stale_one() {
        let mut steering = Steering::default();
        steering.set_yield("t", pending("run-1"));
        assert_eq!(steering.yield_for("t"), Some(&pending("run-1")));
        // The root moved to another run: the old yield is stale.
        steering.clear_stale("t", Some("run-2"));
        assert_eq!(steering.yield_for("t"), None);
        steering.set_yield("t", pending("run-2"));
        steering.clear_stale("t", Some("run-2"));
        assert!(
            steering.yield_for("t").is_some(),
            "the current run's yield stays"
        );
        steering.clear("t");
        assert!(steering.yield_for("t").is_none());
    }
}
