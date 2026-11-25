// SPDX-License-Identifier: Apache-2.0
//! One discovery read (`readSnapshot`, `session-discovery.ts:127`-`:251`): the
//! snapshot request, the parent's read, the bounded history read E3-codex.4
//! owns, the background terminals, then the fold.

use ace_json::{Map, Value};
use indexmap::IndexSet;

use super::{HistoryReady, Origin, REQUEST_MS, origin_failed};
use crate::session::frames::Effect;
use crate::session::frames::without_history;
use crate::session::routing::parent_of;
use crate::session::state::{Session, text_of};
use crate::session::terminals::TerminalRead;

/// Where one read is in the TypeScript's chain of awaits.
pub(crate) enum Stage {
    /// `await request("thread/read", ...)`.
    Snapshot(u64),
    /// `await readThread(parent, ancestors)`.
    Parent,
    /// `await readHistory(request, threadId, ...)`.
    History(u64),
    /// `await readBackgroundTerminals(request, threadId)`.
    Terminals(TerminalRead),
}

/// One thread's read in flight.
pub(crate) struct Read {
    pub ancestors: IndexSet<String>,
    pub(crate) revision: u64,
    pub(crate) origin: Origin,
    /// The thread was unknown when the read started (`:101`).
    pub(crate) unknown: bool,
    /// The read counted against `unknownRecoveries`.
    pub(crate) counted: bool,
    pub(crate) stage: Stage,
    pub(crate) parent: Option<String>,
    pub(crate) snapshot: Map,
    pub(crate) omitted: Vec<Value>,
    pub(crate) notes: Vec<Value>,
    /// This read's number, which ties its notes to its `thread-discovered`.
    pub(crate) history: u64,
}

impl Read {
    /// Whether this read waits for `call`'s `thread/read` reply.
    pub(crate) fn awaits_snapshot(&self, call: u64) -> bool {
        matches!(self.stage, Stage::Snapshot(pending) if pending == call)
    }
}

impl Session {
    /// `readThread`: start a thread's read, or join the one already running.
    /// A join's outcome belongs to the read's starter.
    pub(crate) fn read_thread(
        &mut self,
        thread: &str,
        ancestors: &IndexSet<String>,
        origin: Origin,
    ) -> Vec<Effect> {
        if ancestors.contains(thread) {
            // The TypeScript throws before any request goes out.
            return self.read_start_failed(origin, "Cyclic Codex thread ancestry");
        }
        if self.discovery.reads.contains_key(thread) {
            return Vec::new();
        }
        self.reading.insert(thread.to_owned());
        self.discovery
            .observations
            .insert(thread.to_owned(), super::ReadObservation::default());
        let call = self.calls.take();
        let revision = self.revisions.get(thread).copied().unwrap_or(0);
        self.discovery.reads.insert(
            thread.to_owned(),
            Read {
                ancestors: ancestors.clone(),
                revision,
                origin,
                unknown: !self.known.contains(thread),
                counted: false,
                stage: Stage::Snapshot(call),
                parent: None,
                snapshot: Map::new(),
                omitted: Vec::new(),
                notes: Vec::new(),
                history: 0,
            },
        );
        let mut params = Map::new();
        params.insert("threadId", Value::from(thread));
        vec![Effect::Request {
            call,
            method: "thread/read".to_owned(),
            params: Value::Object(params),
            timeout_ms: Some(REQUEST_MS),
        }]
    }

    /// `await readThread(nativeSessionId)` at open (E3-codex.4's open path).
    pub fn read_root(&mut self, thread: &str) -> Vec<Effect> {
        self.read_thread(thread, &IndexSet::new(), Origin::Direct)
    }

    /// One `thread/read` reply, or its failure.
    pub(crate) fn snapshot_settled(
        &mut self,
        call: u64,
        reply: Result<&Value, &str>,
    ) -> Vec<Effect> {
        let Some(thread) = self
            .discovery
            .reads
            .iter()
            .find(|(_, read)| matches!(read.stage, Stage::Snapshot(pending) if pending == call))
            .map(|(thread, _)| thread.clone())
        else {
            return Vec::new();
        };
        let result = match reply {
            Ok(result) => result,
            Err(message) => return self.read_failed(&thread, message),
        };
        let message = result.as_object().cloned().unwrap_or_default();
        let metadata = message
            .get("thread")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let snapshot = without_history(&metadata);
        let id = text_of(snapshot.get("id"));
        let thread_value = Value::Object(snapshot.clone());
        let parent = if thread == self.root {
            String::new()
        } else {
            parent_of(&thread_value)
                .map(|parent| parent.as_str().to_owned())
                .unwrap_or_default()
        };
        if id != thread {
            return self.read_failed(&thread, "Codex thread read returned a different id");
        }
        if let Some(read) = self.discovery.reads.get_mut(&thread) {
            read.snapshot = snapshot;
            read.parent = Some(parent.clone()).filter(|parent| !parent.is_empty());
        }
        if !parent.is_empty() && !self.known.contains(&parent) {
            // The session's own root is the top of its tree, whatever Codex
            // records above it; any other parent is followed once.
            self.discovery
                .dependencies
                .insert(thread.clone(), parent.clone());
            let ancestors = self
                .discovery
                .reads
                .get(&thread)
                .map(|read| read.ancestors.clone())
                .unwrap_or_default();
            let mut seen = ancestors.clone();
            seen.insert(thread.clone());
            let mut next = parent.clone();
            while !next.is_empty() {
                if seen.contains(&next) {
                    return self.read_failed(&thread, "Cyclic Codex thread ancestry");
                }
                seen.insert(next.clone());
                next = self
                    .discovery
                    .dependencies
                    .get(&next)
                    .cloned()
                    .unwrap_or_default();
            }
            if let Some(read) = self.discovery.reads.get_mut(&thread) {
                read.stage = Stage::Parent;
            }
            if self.discovery.reads.contains_key(&parent) {
                // Join the parent's read: this one resumes when it releases.
                self.discovery
                    .blocked
                    .entry(parent)
                    .or_default()
                    .push(thread.clone());
                return Vec::new();
            }
            self.discovery
                .blocked
                .entry(parent.clone())
                .or_default()
                .push(thread.clone());
            return self.read_thread(&parent, &ancestors, Origin::Direct);
        }
        self.read_gate(&thread)
    }

    /// The tree gate, then the history read (`:154`-`:170`).
    fn read_gate(&mut self, thread: &str) -> Vec<Effect> {
        let parent = self
            .discovery
            .reads
            .get(thread)
            .and_then(|read| read.parent.clone());
        if thread != self.root && parent.as_ref().is_none_or(|p| !self.known.contains(p)) {
            self.revisions.shift_remove(thread);
            self.discovery.uncertain.shift_remove(thread);
            self.release_read(thread);
            return self.finish_output_recovery();
        }
        let read_number = self.discovery.history_reads + 1;
        self.discovery.history_reads = read_number;
        let call = self.calls.take();
        let Some(read) = self.discovery.reads.get_mut(thread) else {
            return Vec::new();
        };
        read.stage = Stage::History(call);
        read.history = read_number;
        read.omitted.clear();
        read.notes.clear();
        vec![Effect::ReadHistory {
            call,
            thread: thread.to_owned(),
        }]
    }

    /// `await readHistory(...)` returned, or its failure.
    pub fn history_ready(&mut self, call: u64, ready: Result<HistoryReady, String>) -> Vec<Effect> {
        let Some(thread) = self
            .discovery
            .reads
            .iter()
            .find(|(_, read)| matches!(read.stage, Stage::History(pending) if pending == call))
            .map(|(thread, _)| thread.clone())
        else {
            return Vec::new();
        };
        let ready = match ready {
            Ok(ready) => ready,
            Err(message) => return self.read_failed(&thread, &message),
        };
        let Some(read) = self.discovery.reads.get_mut(&thread) else {
            return Vec::new();
        };
        read.snapshot
            .insert("turns", Value::Array(ready.turns.into()));
        read.omitted = ready.omitted;
        // A note's own `threadId` and `read` are the read's to say: whoever
        // built the notes cannot know this read's number, and the fold emits
        // them as they are.
        let read_number = read.history;
        read.notes = ready
            .notes
            .into_iter()
            .map(|note| {
                let mut note = note.as_object().cloned().unwrap_or_default();
                note.insert("threadId", Value::from(thread.clone()));
                note.insert("read", Value::from(read_number as f64));
                Value::Object(note)
            })
            .collect();
        // Summaries omit commands. Only Codex's live-terminal list can rule out
        // a background shell (`:176`).
        let needs_terminals = self.discovery.uncertain.contains(&thread)
            && (!read.omitted.is_empty()
                || read.notes.iter().any(|note| {
                    note.get("event").and_then(Value::as_str) == Some("thread-history-omitted")
                }));
        if !needs_terminals {
            return self.read_fold(&thread, None);
        }
        let (terminals, effects) = TerminalRead::start(&thread, &mut self.calls);
        if let Some(read) = self.discovery.reads.get_mut(&thread) {
            read.stage = Stage::Terminals(terminals);
        }
        effects
    }

    /// One terminal page for a read in flight; `None` when no read waits on it.
    pub(crate) fn read_terminal_page(
        &mut self,
        call: u64,
        reply: Result<&Value, &str>,
    ) -> Option<Vec<Effect>> {
        let thread = self
            .discovery
            .reads
            .iter()
            .find(|(_, read)| match &read.stage {
                Stage::Terminals(terminals) => terminals.awaits(call),
                _ => false,
            })
            .map(|(thread, _)| thread.clone())?;
        let Some(read) = self.discovery.reads.get_mut(&thread) else {
            return Some(Vec::new());
        };
        let Stage::Terminals(terminals) = &mut read.stage else {
            return Some(Vec::new());
        };
        let effects = terminals.settled(&mut self.calls, reply);
        if terminals.outcome().is_none() {
            return Some(effects);
        }
        let outcome = terminals.outcome().cloned().unwrap_or(Ok(Vec::new()));
        match outcome {
            Ok(list) => {
                let mut effects = effects;
                effects.extend(self.read_fold(&thread, Some(list)));
                Some(effects)
            }
            Err(message) => Some(self.read_failed(&thread, &message)),
        }
    }

    /// The snapshot's fold: the uncertainty rules, the hydration, and the notes
    /// that record what was read (`:186`-`:251`).
    /// A read failed: release it, report it, and let its starter retry.
    fn read_failed(&mut self, thread: &str, message: &str) -> Vec<Effect> {
        let origin = self
            .discovery
            .reads
            .get(thread)
            .map(|read| read.origin.clone())
            .unwrap_or(Origin::Direct);
        // Children waiting on a failed read fail with it; `release_read`
        // reports them before the starter's own retry.
        let mut effects = self.diagnostic(message);
        self.release_read(thread);
        effects.extend(origin_failed(self, origin, thread));
        effects
    }

    /// A read that could not start (a cycle in its own ancestry).
    fn read_start_failed(&mut self, origin: Origin, message: &str) -> Vec<Effect> {
        let mut effects = self.diagnostic(message);
        effects.extend(origin_failed(self, origin, ""));
        effects
    }

    /// `readThread`'s release: the read, its observation, and its recovery
    /// bookkeeping. Children blocked on it continue; a reconcile waiting on it
    /// moves on.
    pub(crate) fn release_read(&mut self, thread: &str) {
        let Some(read) = self.discovery.reads.shift_remove(thread) else {
            return;
        };
        self.reading.shift_remove(thread);
        self.discovery.observations.shift_remove(thread);
        self.discovery.dependencies.shift_remove(thread);
        if read.counted {
            self.discovery.unknown_recoveries = self.discovery.unknown_recoveries.saturating_sub(1);
        }
        self.discovery.recovering.shift_remove(thread);
        let blocked = self
            .discovery
            .blocked
            .shift_remove(thread)
            .unwrap_or_default();
        if self.known.contains(thread) {
            for child in blocked {
                let _ = self.read_gate(&child);
            }
        } else {
            let message = "Codex thread read failed";
            for child in blocked {
                let _ = self.read_failed(&child, message);
            }
        }
        let tasks: Vec<String> = self.discovery.tasks.keys().cloned().collect();
        for task in &tasks {
            let _ = self.reconcile_continue(task, thread);
        }
    }
}
