// SPDX-License-Identifier: Apache-2.0
//! The streaming fold (`stream-facts.ts`): the canonical reducer over a snapshot the repository
//! owns. Rust fixes the snapshot's interface as a trait, and E5.3 implements it on its snapshot.

use ace_core::ThreadState;
use ace_core::emit::Event;
use ace_core::reduce::FactBatch;
use ace_core::state::{ApplyContext, IdSource};
use ace_json::Value;

/// What `prepare` hands back to `finish`, on every path, including a rejected fact. The snapshot
/// interprets it; the fold only carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Prepared(pub u64);

/// The snapshot the repository owns (`Snapshot` in `persistence.ts`).
pub trait StreamSnapshot {
    fn begin(&mut self);
    /// `FactBatch`'s stable-signal deadline: `None` when there is none.
    fn deadline(&self) -> Option<Option<i64>>;
    fn state(&mut self) -> &mut ThreadState;
    fn prepare(&mut self, fact: &Value) -> Prepared;
    fn finish(&mut self, prepared: Prepared);
    fn delta(&mut self, fact: &Value);
    fn remember(&mut self, fact: &Value, emitted: &[Event]);
    fn update_deadlines(&mut self, facts: &[Value], events: &[Event], now: i64);
    fn retain_changes(&mut self, events: &[Event]);
}

/// Fold `facts` into the snapshot, returning every event the fold emitted.
pub fn stream_facts(
    snapshot: &mut dyn StreamSnapshot,
    facts: &[Value],
    now: i64,
    ids: &mut dyn IdSource,
) -> Vec<Event> {
    snapshot.begin();
    let deadline = snapshot.deadline();
    let mut batch = FactBatch::new(deadline);
    let mut events: Vec<Event> = Vec::new();
    for fact in facts {
        let prepared = snapshot.prepare(fact);
        let mut emitted: Vec<Event> = Vec::new();
        let mut ctx = ApplyContext {
            now,
            ids,
            resolving_interactions: None,
        };
        batch.apply(snapshot.state(), fact, &mut ctx, &mut emitted);
        if is_delta(fact)
            && emitted
                .iter()
                .any(|event| matches!(event, Event::ItemDelta { .. }))
        {
            snapshot.delta(fact);
        }
        snapshot.remember(fact, &emitted);
        events.extend(emitted);
        // `finish` runs even when `apply` returned nothing.
        snapshot.finish(prepared);
    }
    events.extend(batch.flush(snapshot.state()));
    snapshot.update_deadlines(facts, &events, now);
    snapshot.retain_changes(&events);
    events
}

fn is_delta(fact: &Value) -> bool {
    matches!(fact, Value::Object(map) if matches!(map.get("type"), Some(Value::String(kind)) if kind.as_str() == "item.delta"))
}

#[cfg(test)]
mod tests {
    use super::{Prepared, StreamSnapshot, stream_facts};
    use ace_core::ThreadState;
    use ace_core::emit::Event;
    use ace_core::state::IdSource;
    use ace_json::{Value, json};

    /// Records the order every snapshot call happened in.
    struct Recording {
        calls: Vec<String>,
        state: ThreadState,
    }

    impl Recording {
        fn new() -> Recording {
            Recording {
                calls: Vec::new(),
                state: ace_core::state::create_thread_state(
                    "t".to_string(),
                    None,
                    ace_core::state::CoreConfig {
                        provider: "claude".to_string(),
                        silence_ms: 30_000.0,
                        liveness: None,
                    },
                )
                .expect("an empty state"),
            }
        }
    }

    impl StreamSnapshot for Recording {
        fn begin(&mut self) {
            self.calls.push("begin".to_string());
        }
        fn deadline(&self) -> Option<Option<i64>> {
            Some(None)
        }
        fn state(&mut self) -> &mut ThreadState {
            &mut self.state
        }
        fn prepare(&mut self, fact: &Value) -> Prepared {
            self.calls.push(format!(
                "prepare:{}",
                match fact {
                    Value::Object(map) => match map.get("type") {
                        Some(Value::String(kind)) => kind.to_string(),
                        _ => "?".to_string(),
                    },
                    _ => "?".to_string(),
                }
            ));
            Prepared(1)
        }
        fn finish(&mut self, _prepared: Prepared) {
            self.calls.push("finish".to_string());
        }
        fn delta(&mut self, _fact: &Value) {
            self.calls.push("delta".to_string());
        }
        fn remember(&mut self, _fact: &Value, _emitted: &[Event]) {
            self.calls.push("remember".to_string());
        }
        fn update_deadlines(&mut self, _facts: &[Value], _events: &[Event], _now: i64) {
            self.calls.push("updateDeadlines".to_string());
        }
        fn retain_changes(&mut self, _events: &[Event]) {
            self.calls.push("retainChanges".to_string());
        }
    }

    fn ids() -> impl IdSource {
        |_kind: &str| Some("id".to_string())
    }

    #[test]
    fn the_snapshot_is_prepared_and_finished_around_every_fact_a_rejected_one_included() {
        let mut snapshot = Recording::new();
        // A delta of an item that does not exist is rejected by the fold.
        // A fact the fold refuses: it emits nothing, and `finish` still runs.
        let facts = vec![json!({"type": "not-a-fact"})];
        let mut source = ids();
        let _ = stream_facts(&mut snapshot, &facts, 1, &mut source);
        assert_eq!(
            snapshot.calls,
            vec![
                "begin".to_string(),
                "prepare:not-a-fact".to_string(),
                "remember".to_string(),
                "finish".to_string(),
                "updateDeadlines".to_string(),
                "retainChanges".to_string(),
            ]
        );
    }
}
