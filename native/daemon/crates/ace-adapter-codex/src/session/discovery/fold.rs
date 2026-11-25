// SPDX-License-Identifier: Apache-2.0
//! The snapshot's fold (`session-discovery.ts:186`-`:251`): the uncertainty
//! rules, the hydration a current read performs, and the notes that record what
//! was read, in the TypeScript's emit order.

use ace_json::{Map, Value};

use crate::session::frames::Effect;
use crate::session::state::{Session, hydrate_controls, remember_historical_questions};
use crate::session::terminals::Terminal;

use super::{Revision, recovery_uncertain};

impl Session {
    pub(crate) fn read_fold(
        &mut self,
        thread: &str,
        terminals: Option<Vec<Terminal>>,
    ) -> Vec<Effect> {
        let Some(read) = self.discovery.reads.get(thread) else {
            return Vec::new();
        };
        let revision = Revision {
            read: read.revision,
            current: self.revisions.get(thread).copied().unwrap_or(0),
        };
        let snapshot = read.snapshot.clone();
        let omitted = read.omitted.clone();
        let notes = read.notes.clone();
        let parent = read.parent.clone();
        let read_number = read.history;
        let output_recovery = self.discovery.uncertain.contains(thread);
        let uncertain = (output_recovery
            && snapshot
                .get("status")
                .and_then(Value::as_object)
                .and_then(|status| status.get("type"))
                .and_then(Value::as_str)
                == Some("active")
            && !turns_of(&snapshot)
                .iter()
                .any(|turn| turn.get("status").and_then(Value::as_str) == Some("inProgress")))
            || terminals
                .as_ref()
                .is_some_and(|list| list.iter().any(|terminal| terminal.item_id.is_none()))
            || (output_recovery && revision.read != revision.current)
            || self
                .discovery
                .observations
                .get(thread)
                .is_some_and(|observed| {
                    recovery_uncertain(&Value::Object(snapshot.clone()), revision, observed)
                });
        let mut effects = Vec::new();
        if uncertain {
            self.recovered.shift_remove(thread);
            effects.extend(self.schedule_recovery(thread));
        } else {
            self.recovered.insert(thread.to_owned());
            if self.timers.shift_remove(thread).is_some() {
                effects.push(Effect::CancelTimer {
                    key: thread.to_owned(),
                });
            }
        }
        if !uncertain && revision.read == revision.current {
            // A dropped completion leaves stale controls; a current read
            // replaces them.
            if output_recovery {
                self.active.shift_remove(thread);
                self.shells.retain(|_, owner| owner != thread);
            }
            hydrate_controls(
                &Value::Object(snapshot.clone()),
                &mut self.active,
                &mut self.shells,
                &self.ended_turns,
            );
            for terminal in terminals.iter().flatten() {
                if let Some(item) = &terminal.item_id {
                    self.shells.insert(item.clone(), thread.to_owned());
                }
            }
        }
        remember_historical_questions(&Value::Object(snapshot.clone()), &mut self.seen_questions);
        for note in &omitted {
            let mut note = note.as_object().cloned().unwrap_or_default();
            note.insert("threadId", Value::from(thread));
            note.insert("read", Value::from(read_number));
            effects.extend(self.emit_note(&Value::Object(note)));
        }
        for note in &notes {
            effects.extend(self.emit_note(note));
        }
        self.known.insert(thread.to_owned());
        if let Some(parent) = &parent {
            self.parents.insert(thread.to_owned(), parent.clone());
        }
        let mut discovered = Map::new();
        discovered.insert("event", Value::from("thread-discovered"));
        let mut metadata = snapshot.clone();
        metadata.insert("turns", Value::Array(ace_json::Array::new()));
        discovered.insert("thread", Value::Object(metadata));
        discovered.insert("history", Value::from(read_number));
        let mut evidence = Map::new();
        evidence.insert("read", Value::from(revision.read));
        evidence.insert("current", Value::from(revision.current));
        evidence.insert("uncertain", Value::Bool(uncertain));
        if output_recovery {
            evidence.insert("outputRecovery", Value::Bool(true));
        }
        if let Some(list) = &terminals
            && !uncertain
            && revision.read == revision.current
        {
            let items: Vec<Value> = list
                .iter()
                .filter_map(|terminal| terminal.item_id.clone().map(Value::from))
                .collect();
            evidence.insert("liveTerminalItems", Value::Array(items.into()));
        }
        discovered.insert("revision", Value::Object(evidence));
        effects.extend(self.emit_note(&Value::Object(discovered)));
        if !uncertain && revision.read == revision.current {
            self.discovery.uncertain.shift_remove(thread);
            effects.extend(self.finish_output_recovery());
        }
        self.release_read(thread);
        effects
    }
}

/// `withoutHistory`: a thread's metadata without the turns it carried.
pub(crate) fn without_history(thread: &Map) -> Map {
    let mut copy = Map::with_capacity(thread.len());
    for (key, value) in thread {
        if key.as_str() != "turns" {
            copy.insert(key.clone(), value.clone());
        }
    }
    copy
}

fn turns_of(snapshot: &Map) -> Vec<Map> {
    snapshot
        .get("turns")
        .and_then(Value::as_array)
        .map(|turns| {
            turns
                .iter()
                .filter_map(|turn| turn.as_object().cloned())
                .collect()
        })
        .unwrap_or_default()
}
