// SPDX-License-Identifier: Apache-2.0
//! The session's discovery (`session-discovery.ts`): recovery timers, output
//! recovery, the loaded-thread scan, the queue refresh, and the observations a
//! read fences its snapshot with. A discovery read's awaits are stages of one
//! machine in `read.rs`; nothing here blocks.
//!
//! Discovery is an I/O shell around native history and revision-fenced
//! controls: every request is an effect, and its reply comes back as an input.

use ace_json::{Map, Value};
use indexmap::{IndexMap, IndexSet};

use super::frames::{Effect, FrameDir};
use super::state::Session;
use crate::translate::retention::RecentSet;
use tasks::{QueueRead, Reconcile};

mod fold;
mod read;
mod tasks;

#[cfg(test)]
mod tests;

/// `revision: { read, current }` (`session-state.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Revision {
    pub read: u64,
    pub current: u64,
}

/// The output-recovery task's key (`session-discovery.ts:52`).
pub(crate) const OUTPUT_TASK: &str = "codex:output-recovery";
/// A recovery read is tried two seconds after a dropped frame (`:85`).
pub(crate) const RECOVERY_MS: f64 = 2_000.0;
/// At most eight reads at once, four of them for unknown threads (`:99`).
pub(crate) const RECOVERING: usize = 8;
pub(crate) const UNKNOWN_RECOVERIES: usize = 4;
/// One request's default deadline (`request` in `session.ts`).
pub(crate) const REQUEST_MS: f64 = 30_000.0;

/// What a history read answered (`readHistory`'s result, `history.ts:39`).
pub struct HistoryReady {
    /// The newest turns, oldest first.
    pub turns: Vec<Value>,
    /// `thread-history-omitted` notes without the read's own keys.
    pub omitted: Vec<Value>,
    /// `historyNotes`' bounded notes for these turns (E3-codex.4).
    pub notes: Vec<Value>,
}

/// `ReadObservation`: what a read saw live while its snapshot was in flight.
#[derive(Default)]
pub struct ReadObservation {
    pub started: Option<String>,
    pub completed: RecentSet,
}

/// `recoveryUncertain`: item changes do not prove that a snapshot's active turn
/// has settled or been superseded (`session-state.ts:15`).
pub fn recovery_uncertain(thread: &Value, revision: Revision, observed: &ReadObservation) -> bool {
    if revision.read == revision.current || observed.started.is_some() {
        return false;
    }
    let thread = thread.as_object().cloned().unwrap_or_default();
    let turns: Vec<Map> = thread
        .get("turns")
        .and_then(Value::as_array)
        .map(|turns| {
            turns
                .iter()
                .filter_map(|turn| turn.as_object().cloned())
                .collect()
        })
        .unwrap_or_default();
    let active: Vec<&Map> = turns
        .iter()
        .filter(|turn| turn.get("status").and_then(Value::as_str) == Some("inProgress"))
        .collect();
    active.iter().any(|turn| {
        !observed
            .completed
            .has(turn.get("id").and_then(Value::as_str).unwrap_or_default())
    }) || (thread
        .get("status")
        .and_then(Value::as_object)
        .and_then(|status| status.get("type"))
        .and_then(Value::as_str)
        == Some("active")
        && active.is_empty()
        && observed.completed.is_empty())
}

/// Who started a read: its failure belongs to that caller.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Origin {
    /// `recoverThread`: report it and schedule another try.
    Recovery,
    /// `reconcileLoaded`: fail the scan, which retries itself.
    Reconcile(String),
    /// The session's own open, which awaits the read directly.
    Direct,
}

/// Everything `sessionDiscovery` keeps besides the maps the session owns.
pub(crate) struct Discovery {
    pub recovering: IndexSet<String>,
    pub reads: IndexMap<String, read::Read>,
    pub blocked: IndexMap<String, Vec<String>>,
    pub observations: IndexMap<String, ReadObservation>,
    pub dependencies: IndexMap<String, String>,
    pub queue_counts: IndexMap<String, u64>,
    pub queues: IndexMap<u64, QueueRead>,
    pub tasks: IndexMap<String, Reconcile>,
    /// Reconcile retries armed after a failed scan, by task key.
    pub retries: IndexSet<String>,
    pub unknown_recoveries: usize,
    pub history_reads: u64,
    pub uncertain: IndexSet<String>,
    pub output_recovery: bool,
    pub output_scan: bool,
    pub output_revision: u64,
}

impl Discovery {
    pub(crate) fn new() -> Discovery {
        Discovery {
            recovering: IndexSet::new(),
            reads: IndexMap::new(),
            blocked: IndexMap::new(),
            observations: IndexMap::new(),
            dependencies: IndexMap::new(),
            queue_counts: IndexMap::new(),
            queues: IndexMap::new(),
            tasks: IndexMap::new(),
            retries: IndexSet::new(),
            unknown_recoveries: 0,
            history_reads: 0,
            uncertain: IndexSet::new(),
            output_recovery: false,
            output_scan: false,
            output_revision: 0,
        }
    }

    /// `isOutputUncertain`: a frame may have been lost.
    pub(crate) fn output_uncertain(&self) -> bool {
        self.output_recovery
    }
}

impl Session {
    /// `invalidateOutput`: this session's controls are recovered from fresh
    /// reads (`session-discovery.ts:60`).
    pub(crate) fn invalidate_output(&mut self) -> Vec<Effect> {
        let mut effects = Vec::new();
        if !self.discovery.output_recovery {
            self.discovery.output_recovery = true;
            let mut note = Map::new();
            note.insert("event", Value::from("discovery-start"));
            note.insert("threadId", Value::from(self.root.clone()));
            note.insert("task", Value::from(OUTPUT_TASK));
            effects.extend(self.emit_note(&Value::Object(note)));
        }
        let threads: Vec<String> = self
            .known
            .iter()
            .chain(self.reading.iter())
            .cloned()
            .collect();
        for thread in threads {
            let revision = self.revisions.get(&thread).copied().unwrap_or(0) + 1;
            self.revisions.insert(thread.clone(), revision);
            self.discovery.uncertain.insert(thread.clone());
            self.recovered.shift_remove(&thread);
            effects.extend(self.schedule_recovery(&thread));
        }
        // A dropped spawn notification may have hidden a descendant nobody knows
        // about yet.
        self.discovery.output_revision += 1;
        if !self.discovery.output_scan {
            self.discovery.output_scan = true;
            effects.extend(self.reconcile_loaded(OUTPUT_TASK));
        }
        effects
    }

    /// `finishOutputRecovery`: every uncertain thread has a current read.
    pub(crate) fn finish_output_recovery(&mut self) -> Vec<Effect> {
        if !self.discovery.output_recovery
            || self.discovery.output_scan
            || !self.discovery.uncertain.is_empty()
        {
            return Vec::new();
        }
        self.discovery.output_recovery = false;
        let mut note = Map::new();
        note.insert("event", Value::from("discovery-finished"));
        note.insert("threadId", Value::from(self.root.clone()));
        note.insert("task", Value::from(OUTPUT_TASK));
        self.emit_note(&Value::Object(note))
    }

    /// `scheduleRecovery`: one timer per thread, at most 256 of them (`:78`).
    pub(crate) fn schedule_recovery(&mut self, thread: &str) -> Vec<Effect> {
        if self.lifetime.is_closed()
            || self.timers.contains_key(thread)
            || self.timers.len() >= super::state::TIMER_LIMIT
        {
            return Vec::new();
        }
        self.timers.insert(thread.to_owned(), ());
        vec![Effect::ArmTimer {
            key: thread.to_owned(),
            ms: RECOVERY_MS,
        }]
    }

    /// `recoverThread`: a reserved read, with room for admitted children and
    /// control commands (`:98`).
    pub(crate) fn recover_thread(&mut self, thread: &str) -> Vec<Effect> {
        if self.discovery.recovering.contains(thread)
            || self.recovered.contains(thread)
            || self.lifetime.is_closed()
        {
            return Vec::new();
        }
        let unknown = !self.known.contains(thread);
        if self.discovery.recovering.len() >= RECOVERING
            || (unknown && self.discovery.unknown_recoveries >= UNKNOWN_RECOVERIES)
        {
            return self.schedule_recovery(thread);
        }
        self.discovery.recovering.insert(thread.to_owned());
        let effects = self.read_thread(thread, &IndexSet::new(), Origin::Recovery);
        if let Some(read) = self.discovery.reads.get_mut(thread)
            && read.unknown
            && !read.counted
        {
            read.counted = true;
            self.discovery.unknown_recoveries += 1;
        }
        effects
    }

    /// `timer(key)`: a recovery timer, the output-recovery retry, or a
    /// correlation deadline. The timer's key is the TypeScript map's key.
    pub fn timer(&mut self, key: &str, now: f64) -> Vec<Effect> {
        if self.timers.shift_remove(key).is_some() {
            if self.discovery.retries.shift_remove(key) {
                return self.reconcile_loaded(key);
            }
            return self.recover_thread(key);
        }
        if self.correlations.contains_key(key) {
            return self.correlation_timer(key, now);
        }
        Vec::new()
    }

    /// `observeRecovery`: a live turn the read must not mistake for settled.
    pub(crate) fn observe_recovery(&mut self, thread: &str, method: &str, turn: &str) {
        if thread.is_empty() || turn.is_empty() {
            return;
        }
        let Some(observed) = self.discovery.observations.get_mut(thread) else {
            return;
        };
        if method == "turn/started" {
            observed.started = Some(turn.to_owned());
        }
        if method == "turn/completed" {
            observed.completed.add(turn.to_owned());
        }
    }

    /// `diagnostic(error)`: the error's message as a stderr frame.
    pub(crate) fn diagnostic(&mut self, message: &str) -> Vec<Effect> {
        self.emit_dir(FrameDir::Stderr, &Value::from(message), "stdio", None)
            .unwrap_or_default()
    }
}

/// A read's failure reaches its starter's retry rule.
pub(crate) fn origin_failed(session: &mut Session, origin: Origin, thread: &str) -> Vec<Effect> {
    match origin {
        Origin::Recovery if !thread.is_empty() => session.schedule_recovery(thread),
        Origin::Reconcile(task) => session.reconcile_failed(&task),
        Origin::Recovery | Origin::Direct => Vec::new(),
    }
}
