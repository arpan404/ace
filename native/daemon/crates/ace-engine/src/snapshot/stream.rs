// SPDX-License-Identifier: Apache-2.0
//! The snapshot as E5.2's streaming fold sees it (`frames/stream.rs`, `stream-facts.ts:13`-`:31`):
//! `begin`, the batch's stable-signal deadline, then per fact `prepare`, `apply` (by the fold),
//! `delta`, `remember` and `finish`, then the deadlines and `retainChanges`.
//!
//! The fold's trait carries no error, so a section read or write that fails is kept here and
//! returned once the fold ends; the fact that failed is the last one the snapshot touched.

use std::collections::HashMap;

use ace_core::ThreadState;
use ace_core::emit::Event;
use ace_json::Value;

use super::Snapshot;
use crate::EngineError;
use crate::frames::{Prepared, StreamSnapshot};

/// One live batch's view of a resident snapshot.
pub struct LiveStream<'a> {
    snapshot: &'a mut Snapshot,
    deadline: Option<i64>,
    /// The item each `prepare` was for, by its token: `finish` clears it.
    prepared: HashMap<u64, String>,
    next: u64,
    error: Option<EngineError>,
}

impl<'a> LiveStream<'a> {
    /// The snapshot over one `stream` batch. `deadline` is the stable-signal deadline the batch
    /// computed before the fold (`repository.ts:378`).
    pub fn new(snapshot: &'a mut Snapshot, deadline: Option<i64>) -> LiveStream<'a> {
        LiveStream {
            snapshot,
            deadline,
            prepared: HashMap::new(),
            next: 0,
            error: None,
        }
    }

    /// The error a section read or write raised during the fold, if any.
    pub fn take_error(&mut self) -> Option<EngineError> {
        self.error.take()
    }

    fn record(&mut self, outcome: Result<(), EngineError>) {
        if self.error.is_none()
            && let Err(error) = outcome
        {
            self.error = Some(error);
        }
    }
}

fn text_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// The fold's events as the JSON values the snapshot's own steps take.
fn event_values(events: &[Event]) -> Vec<Value> {
    let mut json = String::new();
    ace_core::event_json::write_events(events, &mut json);
    match ace_json::parse(&json) {
        Ok(Value::Array(items)) => items.into_vec(),
        _ => Vec::new(),
    }
}

impl StreamSnapshot for LiveStream<'_> {
    fn begin(&mut self) {
        self.snapshot.begin();
    }

    fn deadline(&self) -> Option<Option<i64>> {
        Some(self.deadline)
    }

    fn state(&mut self) -> &mut ThreadState {
        &mut self.snapshot.state
    }

    fn prepare(&mut self, fact: &Value) -> Prepared {
        let item = text_field(fact, "item").unwrap_or_default().to_owned();
        let field = text_field(fact, "field").unwrap_or_default().to_owned();
        let outcome = self.snapshot.prepare(&item, &field);
        self.record(outcome);
        let token = self.next;
        self.next += 1;
        self.prepared.insert(token, item);
        Prepared(token)
    }

    fn finish(&mut self, prepared: Prepared) {
        if let Some(item) = self.prepared.remove(&prepared.0) {
            self.snapshot.finish_prepare(&item);
        }
    }

    fn delta(&mut self, fact: &Value) {
        let item = text_field(fact, "item").unwrap_or_default().to_owned();
        let append = text_field(fact, "append").unwrap_or_default().to_owned();
        let outcome = self.snapshot.delta(&item, &append, true);
        self.record(outcome);
    }

    fn remember(&mut self, fact: &Value, emitted: &[Event]) {
        let kind = text_field(fact, "type").unwrap_or_default().to_owned();
        let item = text_field(fact, "item").unwrap_or_default().to_owned();
        let outcome = self.snapshot.remember(&kind, &item, &event_values(emitted));
        self.record(outcome);
    }

    fn update_deadlines(&mut self, facts: &[Value], events: &[Event], now: i64) {
        self.snapshot
            .update_deadlines(facts, &event_values(events), now);
    }

    fn retain_changes(&mut self, events: &[Event]) {
        self.snapshot.retain_changes(&event_values(events));
    }
}
