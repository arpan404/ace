// SPDX-License-Identifier: Apache-2.0
//! The probe's transcript: what one apply did, and everything the scripted dependencies saw.

use ace_json::Value;
use std::cell::{Cell, RefCell};
use std::collections::HashSet;

/// What one `apply` did.
#[derive(Default)]
pub struct Applied {
    pub facts: usize,
    pub outermost: bool,
    pub committed: bool,
    pub streamed: bool,
    pub generation: u64,
    pub frames: usize,
}

/// The probe's shared script: the answers its repository gives and what it saw.
pub struct ProbeLog {
    pub delta_stream: bool,
    pub status: RefCell<Value>,
    pub aborted: RefCell<u32>,
    pub wakes: RefCell<u32>,
    pub diagnostics: RefCell<Vec<Value>>,
    pub released: RefCell<u32>,
    pub expired: RefCell<Vec<u64>>,
    pub retired: RefCell<Vec<u64>>,
    pub applied: RefCell<Vec<Applied>>,
    pub snapshots: RefCell<Vec<&'static str>>,
    pub live: RefCell<Vec<Value>>,
    /// The next probe event's sequence, so each `apply` is a real stored row.
    pub next_seq: Cell<u64>,
    /// Threads whose tick has been applied: the probe's root agent exists from then on.
    pub rooted: RefCell<HashSet<String>>,
    /// `apply` calls that throw a retryable store error before writing, for the retry cases.
    pub fail_apply: Cell<u32>,
    /// `persist` calls that throw a retryable store error, for the live retry case.
    pub fail_persist: Cell<u32>,
    /// `persist` calls that throw a fatal error, for the quarantine case.
    pub fail_persist_fatal: Cell<u32>,
    /// The labels scripted `enqueue` operations ran, in order.
    pub enqueued: RefCell<Vec<String>>,
    /// Each native flow mirror's `set_paused`, in order.
    pub flowed: RefCell<Vec<bool>>,
    /// Each real native-path acknowledgement, as `ok` or `rejected:<message>`.
    pub native_acks: RefCell<Vec<String>>,
    /// The facts each `apply` received, in order.
    pub facts: RefCell<Vec<Value>>,
    /// What the fold did, in order: an apply or a labelled enqueued op.
    pub order: RefCell<Vec<String>>,
    /// Each enqueued op's own transaction: whether it ran outermost.
    pub ops_outermost: RefCell<Vec<bool>>,
    /// Each `cursor_record` call: its entries and whether a transaction was open.
    pub journal: RefCell<Vec<Value>>,
    pub journal_in_transaction: RefCell<Vec<bool>>,
    /// `attachment` lookups that throw a retryable store error before answering.
    pub fail_attachment: Cell<u32>,
    /// A non-retryable failure before writing, for the native acknowledgement's rejection.
    pub fail_apply_fatal: Cell<u32>,
    /// The repository reports a Cursor SDK thread, so the journal path runs.
    pub cursor_route: Cell<bool>,
}

impl Default for ProbeLog {
    fn default() -> Self {
        ProbeLog {
            delta_stream: false,
            status: RefCell::new(ace_json::json!({"state": "running"})),
            aborted: RefCell::new(0),
            wakes: RefCell::new(0),
            diagnostics: RefCell::new(Vec::new()),
            released: RefCell::new(0),
            expired: RefCell::new(Vec::new()),
            retired: RefCell::new(Vec::new()),
            applied: RefCell::new(Vec::new()),
            snapshots: RefCell::new(Vec::new()),
            live: RefCell::new(Vec::new()),
            next_seq: Cell::new(0),
            rooted: RefCell::new(HashSet::new()),
            fail_apply: Cell::new(0),
            fail_persist: Cell::new(0),
            fail_persist_fatal: Cell::new(0),
            enqueued: RefCell::new(Vec::new()),
            flowed: RefCell::new(Vec::new()),
            native_acks: RefCell::new(Vec::new()),
            facts: RefCell::new(Vec::new()),
            order: RefCell::new(Vec::new()),
            ops_outermost: RefCell::new(Vec::new()),
            journal: RefCell::new(Vec::new()),
            journal_in_transaction: RefCell::new(Vec::new()),
            fail_attachment: Cell::new(0),
            fail_apply_fatal: Cell::new(0),
            cursor_route: Cell::new(false),
        }
    }
}

impl ProbeLog {
    pub(super) fn text<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
        match value {
            Value::Object(map) => match map.get(name) {
                Some(Value::String(text)) => Some(text.as_str()),
                _ => None,
            },
            _ => None,
        }
    }

    /// The probe's transcript of what it saw, as JSON.
    pub fn json(&self) -> String {
        let applied: Vec<Value> = self
            .applied
            .borrow()
            .iter()
            .map(|entry| {
                ace_json::json!({
                    "facts": entry.facts as u64,
                    "frames": entry.frames as u64,
                    "outermost": entry.outermost,
                    "committed": entry.committed,
                    "streamed": entry.streamed,
                    "generation": entry.generation,
                })
            })
            .collect();
        let expired: Vec<Value> = self
            .expired
            .borrow()
            .iter()
            .map(|generation| Value::Number((*generation).into()))
            .collect();
        ace_json::to_string(&ace_json::json!({
            "aborted": f64::from(*self.aborted.borrow()) as u64,
            "wakes": f64::from(*self.wakes.borrow()) as u64,
            "released": f64::from(*self.released.borrow()) as u64,
            "diagnostics": Value::Array(self.diagnostics.borrow().clone().into()),
            "applied": Value::Array(applied.into()),
            "expired": Value::Array(expired.into()),
            "retired": Value::Array(self.retired.borrow().iter().map(|g| Value::Number((*g).into())).collect::<Vec<Value>>().into()),
            "snapshots": Value::Array(self.snapshots.borrow().iter().map(|name| Value::String((*name).into())).collect::<Vec<Value>>().into()),
            "live": Value::Array(self.live.borrow().clone().into()),
            "enqueued": Value::Array(self.enqueued.borrow().iter().map(|label| Value::String(label.clone().into())).collect::<Vec<Value>>().into()),
            "flowed": Value::Array(self.flowed.borrow().iter().map(|paused| Value::Bool(*paused)).collect::<Vec<Value>>().into()),
            "facts": Value::Array(self.facts.borrow().clone().into()),
            "nativeAcks": Value::Array(self.native_acks.borrow().iter().map(|entry| Value::String(entry.clone().into())).collect::<Vec<Value>>().into()),
            "order": Value::Array(self.order.borrow().iter().map(|entry| Value::String(entry.clone().into())).collect::<Vec<Value>>().into()),
            "opsOutermost": Value::Array(self.ops_outermost.borrow().iter().map(|value| Value::Bool(*value)).collect::<Vec<Value>>().into()),
            "journal": Value::Array(self.journal.borrow().clone().into()),
            "journalInTransaction": Value::Array(self.journal_in_transaction.borrow().iter().map(|value| Value::Bool(*value)).collect::<Vec<Value>>().into()),
        }))
    }
}
