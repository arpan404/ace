// SPDX-License-Identifier: Apache-2.0
//! Bounded recovery evidence for one recovery epoch
//! (`packages/adapter-opencode/src/recovery-evidence.ts`). Text and absence
//! have separate clocks: a delta's coverage comes only from a full snapshot
//! that ends with it, and a snapshot is final only when no later event touched
//! its session.
//!
//! Rule 17: text lengths (`chunk.text.length`, `coveredPrefix`) count UTF-16
//! units; the delta budget counts UTF-8 bytes, as `Buffer.byteLength` does.
//! Every map is an `IndexMap` and is removed from with `shift_remove`, as the
//! TypeScript's `Map.delete` keeps the rest in place.

use ace_json::Value;
use indexmap::IndexMap;
use std::collections::HashSet;

use ace_json::Map;

use crate::translate::data::{arr_in, fields, get, n_in, num_str, s_in, s_in_fb, utf16_len};

use super::coverage::covered_prefix;

/// `this.deltas.size >= 4096` and an entry's 4,096 chunks.
const MAX_DELTAS: usize = 4096;
/// `this.deltaBytes > 8 * 1024 * 1024`.
const MAX_DELTA_BYTES: usize = 8 * 1024 * 1024;
/// One entry's chunk bound (`entry.chunks.length >= 4096`).
const MAX_CHUNKS: usize = 4096;
/// `this.snapshots.length >= 4096`.
const MAX_SNAPSHOTS: usize = 4096;
/// `this.bytes > 8 * 1024 * 1024`.
const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
/// `this.shells.size >= 4096`.
const MAX_SHELLS: usize = 4096;

/// Why the evidence refused to grow. The TypeScript throws plain `Error`s with
/// these texts; `Keys` is a ZodError there and has no single line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum EvidenceError {
    #[error("OpenCode recovery text budget")]
    TextBudget,
    #[error("OpenCode snapshot budget exceeded")]
    SnapshotBudget,
    #[error("OpenCode shell snapshot budget exceeded")]
    ShellBudget,
    #[error("OpenCode partial delta coverage is uncertain")]
    PartialCoverage,
    #[error("OpenCode interaction keys failed their check")]
    Keys,
}

/// One staged snapshot, replayed in recovery order.
pub struct Snapshot {
    pub channel: &'static str,
    pub data: Value,
    pub session: String,
    pub started: u64,
}

/// One buffered delta and the watermark it arrived at.
struct Chunk {
    text: String,
    watermark: u64,
}

#[derive(Default)]
struct Delta {
    chunks: Vec<Chunk>,
    /// The watermark of the last chunk a snapshot proved present.
    covered: u64,
}

/// One shell the recovery pass learned about.
#[derive(Debug, Clone)]
pub struct ShellState {
    pub owner: String,
    pub started: u64,
}

/// Bounded evidence for one recovery epoch.
#[derive(Default)]
pub struct RecoveryEvidence {
    snapshots: Vec<Snapshot>,
    bytes: usize,
    deltas: IndexMap<String, Delta>,
    delta_bytes: usize,
    work: IndexMap<String, u64>,
    interactions: IndexMap<String, u64>,
    inbox: IndexMap<String, u64>,
    shells: IndexMap<String, ShellState>,
}

impl RecoveryEvidence {
    pub fn new() -> Self {
        Self::default()
    }

    /// `reset`: forget everything, for a new epoch.
    pub fn reset(&mut self) {
        self.snapshots.clear();
        self.bytes = 0;
        self.delta_bytes = 0;
        self.deltas.clear();
        self.work.clear();
        self.interactions.clear();
        self.inbox.clear();
        self.shells.clear();
    }

    /// `pass`: a new read starts; the deltas and clocks carry over.
    pub fn pass(&mut self) {
        self.snapshots.clear();
        self.bytes = 0;
        self.shells.clear();
    }

    /// `observe`: one event that was buffered while recovering. `typ` and
    /// `payload` are the envelope's fields, which the server already checked.
    pub fn observe(
        &mut self,
        typ: &str,
        payload: &Map,
        watermark: u64,
    ) -> Result<(), EvidenceError> {
        let session = s_in(payload, "sessionID");
        if typ == "session.text.delta" || typ == "session.reasoning.delta" {
            let kind = if typ.contains("reasoning") {
                "reasoning"
            } else {
                "text"
            };
            let key = key(
                kind,
                session,
                s_in(payload, "assistantMessageID"),
                n_in(payload, "ordinal"),
            );
            let text = s_in(payload, "delta").to_owned();
            self.delta_bytes += text.len();
            let entry = self.deltas.get(&key);
            if (self.deltas.len() >= MAX_DELTAS && entry.is_none())
                || self.delta_bytes > MAX_DELTA_BYTES
                || entry.is_some_and(|entry| entry.chunks.len() >= MAX_CHUNKS)
            {
                return Err(EvidenceError::TextBudget);
            }
            self.deltas
                .entry(key)
                .or_default()
                .chunks
                .push(Chunk { text, watermark });
        } else if typ.starts_with("permission.") || typ.starts_with("form.") {
            // `string(object(p.form).sessionID, session)`.
            let form = fields(get(payload, "form"));
            let id = s_in_fb(form, "sessionID", session).to_owned();
            self.interactions.insert(id, watermark);
        } else if typ.starts_with("session.inbox.") {
            self.inbox.insert(session.to_owned(), watermark);
            self.work.insert(session.to_owned(), watermark);
        } else if typ.starts_with("session.execution.")
            || typ.starts_with("session.tool.")
            || typ == "session.synthetic"
        {
            self.work.insert(session.to_owned(), watermark);
        }
        Ok(())
    }

    /// `message`: a full `snapshot.message` settles which deltas it covers.
    pub fn message(&mut self, data: &Value) -> Result<(), EvidenceError> {
        let payload = fields(data);
        let message = fields(get(payload, "message"));
        let session = s_in(payload, "sessionID");
        if s_in(message, "type") != "assistant" {
            return Ok(());
        }
        let id = s_in(message, "id");
        for (ordinal, block) in arr_in(message, "content").iter().enumerate() {
            let block = fields(block);
            let kind = s_in(block, "type");
            if kind != "text" && kind != "reasoning" {
                continue;
            }
            let entry_key = key(kind, session, id, ordinal as f64);
            let Some(entry) = self.deltas.get_mut(&entry_key) else {
                continue;
            };
            let joined: String = entry
                .chunks
                .iter()
                .map(|chunk| chunk.text.as_str())
                .collect();
            let matched = covered_prefix(s_in(block, "text"), &joined);
            // Only a matching suffix establishes coverage: arrival time alone
            // cannot prove a concurrent reply includes a delta.
            entry.covered = 0;
            let mut length = 0usize;
            for chunk in &entry.chunks {
                length += utf16_len(&chunk.text);
                if length > matched {
                    if matched > length - utf16_len(&chunk.text) {
                        return Err(EvidenceError::PartialCoverage);
                    }
                    break;
                }
                entry.covered = chunk.watermark;
            }
        }
        Ok(())
    }

    /// `covered`: whether a replayed snapshot already says this event.
    /// `session` is the event's `eventSession`, which the caller already read.
    pub fn covered(
        &self,
        typ: &str,
        payload: &Map,
        session: &str,
        created: Option<f64>,
        watermark: u64,
    ) -> bool {
        if typ == "shell.created" {
            let id = s_in(fields(get(payload, "info")), "id");
            return self
                .shells
                .get(id)
                .is_some_and(|state| state.owner == session && watermark <= state.started);
        }
        if typ == "permission.asked" || typ == "form.created" || typ == "session.execution.started"
        {
            return self.snapshots.iter().any(|snapshot| {
                if snapshot.session != session || watermark > snapshot.started {
                    return false;
                }
                let data = fields(&snapshot.data);
                if typ == "session.execution.started" {
                    let idle_at = data.get("idleAt");
                    let running = data.get("running");
                    return snapshot.channel == "snapshot.active"
                        && running == Some(&Value::Bool(false))
                        && idle_at.and_then(Value::as_f64).is_some()
                        && (created.is_none()
                            || idle_at.and_then(Value::as_f64).unwrap_or(0.0)
                                >= created.unwrap_or(0.0));
                }
                if snapshot.channel != "snapshot.interactions" {
                    return false;
                }
                let interaction = if typ == "form.created" {
                    fields(get(payload, "form"))
                } else {
                    payload
                };
                let prefix = if typ == "form.created" {
                    "form"
                } else {
                    "permission"
                };
                let key = format!("{prefix}:{session}:{}", s_in(interaction, "id"));
                self.interaction_keys(&snapshot.data)
                    .is_ok_and(|keys| !keys.contains(&key))
            });
        }
        if typ != "session.text.delta" && typ != "session.reasoning.delta" {
            return false;
        }
        let kind = if typ.contains("reasoning") {
            "reasoning"
        } else {
            "text"
        };
        let key = key(
            kind,
            s_in(payload, "sessionID"),
            s_in(payload, "assistantMessageID"),
            n_in(payload, "ordinal"),
        );
        self.deltas
            .get(&key)
            .is_some_and(|entry| watermark <= entry.covered)
    }

    /// `stage`: one snapshot for the replay, bounded by bytes and count.
    pub fn stage(
        &mut self,
        channel: &'static str,
        data: &Value,
        session: &str,
        started: u64,
    ) -> Result<(), EvidenceError> {
        self.bytes += ace_json::to_string(data).len();
        if self.bytes > MAX_SNAPSHOT_BYTES || self.snapshots.len() >= MAX_SNAPSHOTS {
            return Err(EvidenceError::SnapshotBudget);
        }
        self.snapshots.push(Snapshot {
            channel,
            data: data.clone(),
            session: session.to_owned(),
            started,
        });
        Ok(())
    }

    /// `positive`: the snapshots replayed before the buffered events.
    pub fn positive(&mut self) -> Vec<Snapshot> {
        let mut positive = Vec::new();
        let mut remaining = Vec::new();
        for snapshot in std::mem::take(&mut self.snapshots) {
            let running = snapshot.channel == "snapshot.active"
                && fields(&snapshot.data).get("running") == Some(&Value::Bool(true));
            if running {
                positive.push(snapshot);
            } else {
                remaining.push(snapshot);
            }
        }
        self.snapshots = remaining;
        positive
    }

    /// `complete`: both of a session's snapshots are staged.
    pub fn complete(&self, session: &str) -> bool {
        ["snapshot.active", "snapshot.interactions"]
            .iter()
            .all(|channel| {
                self.snapshots
                    .iter()
                    .any(|snapshot| snapshot.session == session && snapshot.channel == *channel)
            })
    }

    /// `shell`: a shell snapshot for the replay.
    pub fn shell(&mut self, id: &str, owner: &str, started: u64) -> Result<(), EvidenceError> {
        if self.shells.len() >= MAX_SHELLS && !self.shells.contains_key(id) {
            return Err(EvidenceError::ShellBudget);
        }
        self.shells.insert(
            id.to_owned(),
            ShellState {
                owner: owner.to_owned(),
                started,
            },
        );
        Ok(())
    }

    /// `completeShell`: the shell's snapshot names its owner.
    pub fn complete_shell(&self, id: &str, owner: &str) -> bool {
        self.shells
            .get(id)
            .is_some_and(|state| state.owner == owner)
    }

    /// `finish`: the snapshots no later event overtook, in stage order.
    pub fn finish(&mut self) -> Vec<Snapshot> {
        let snapshots = std::mem::take(&mut self.snapshots);
        snapshots
            .into_iter()
            .filter(|snapshot| {
                let clock = if snapshot.channel == "snapshot.interactions" {
                    &self.interactions
                } else if snapshot.channel == "snapshot.inbox" {
                    &self.inbox
                } else {
                    &self.work
                };
                clock.get(&snapshot.session).copied().unwrap_or(0) <= snapshot.started
            })
            .collect()
    }

    /// `interactionKeys`: the snapshot's keys, each a string (a ZodError there).
    pub fn interaction_keys(&self, data: &Value) -> Result<HashSet<String>, EvidenceError> {
        let values = match fields(data).get("keys") {
            Some(Value::Array(values)) => values,
            _ => return Err(EvidenceError::Keys),
        };
        let mut keys = HashSet::with_capacity(values.len());
        for value in values.iter() {
            let Value::String(text) = value else {
                return Err(EvidenceError::Keys);
            };
            keys.insert(text.as_str().to_owned());
        }
        Ok(keys)
    }
}

/// `key(type, session, message, ordinal)`.
fn key(kind: &str, session: &str, message: &str, ordinal: f64) -> String {
    format!("{kind}:{session}:{message}:{}", num_str(ordinal))
}

#[cfg(test)]
mod tests;
