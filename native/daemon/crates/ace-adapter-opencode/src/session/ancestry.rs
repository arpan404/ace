// SPDX-License-Identifier: Apache-2.0
//! Unknown facts are bounded evidence until a GET chain proves ownership
//! (`packages/adapter-opencode/src/ancestry.ts:32`-`:171`). This is the
//! synchronous half: the bounds, the probe's buffer, and the replay and
//! absence answers. The chain itself is E3-opencode.3's; a new probe asks the
//! facade for it as one port at the point the TypeScript started its async
//! block (`:94`).
//!
//! The TypeScript rolls a buffered event back when a receipt sink throws.
//! Native callbacks cannot throw, so there is nothing to roll back here.

use ace_json::Value;
use indexmap::IndexMap;

use crate::translate::boundaries::event_session;
use crate::translate::data::{fields, get, s_in};

/// At most 8 probes in flight, 32 events each and 1 MiB of held events.
const MAX_PROBES: usize = 8;
const MAX_EVENTS: usize = 32;
const MAX_BYTES: usize = 1024 * 1024;

/// What the probe reads, and the effects it produces. The tenant implements it.
pub trait ProbeHost {
    fn owns_session(&self, id: &str) -> bool;
    fn directory(&self) -> String;
    fn recovering(&self) -> bool;
    fn info(&self, info: &Value);
    /// `session.ts:134`: covered evidence is not replayed, and while not
    /// recovering delivery skips the evidence check entirely.
    fn receive(&self, data: &Value, watermark: u64) -> Result<(), ProbeError>;
    fn buffered(&self, data: &Value, watermark: u64);
    fn pending(&self, guard: &str);
    fn settled(&self, guard: &str);
    fn failed(&self, data: &Value);
    /// One GET chain for a new probe (E3-opencode.3): its replies come back
    /// through the probe's own state, not through this call.
    fn lookup(&self, id: &str, guard: &str);
}

/// A receipt's failure, as the TypeScript's thrown `Error` text. The pass that
/// replayed the receipt rejects with it, exactly as `recoverOnce` does.
pub type ProbeError = String;

/// One held event, with the watermark it arrived at.
struct Entry {
    data: Value,
    watermark: u64,
    bytes: usize,
}

/// One unproven session's evidence.
struct Probe {
    guard: String,
    events: Vec<Entry>,
    needs_recovery: bool,
    lookup_failed: bool,
}

/// The probes one tenant holds.
#[derive(Default)]
pub struct AncestryProbe {
    probes: IndexMap<String, Probe>,
    unknown_bytes: usize,
    sequence: u64,
}

impl AncestryProbe {
    pub fn new() -> Self {
        Self::default()
    }

    /// `prove`: an event for a session this tree does not own, in this
    /// session's directory, waits as evidence.
    pub fn prove(&mut self, data: &Value, watermark: u64, host: &dyn ProbeHost) {
        let envelope = fields(data);
        let Some(Value::Object(location)) = envelope.get("location") else {
            return;
        };
        let id = event_session(data);
        if id.is_empty()
            || host.owns_session(id)
            || s_in(location, "directory") != host.directory()
            || s_in(envelope, "type") == "session.created"
        {
            return;
        }
        let bytes = ace_json::to_string(data).len();
        let queued = self.probes.get(id);
        if self.unknown_bytes + bytes > MAX_BYTES
            || queued.is_some_and(|probe| probe.events.len() >= MAX_EVENTS)
            || (queued.is_none() && self.probes.len() >= MAX_PROBES)
        {
            host.failed(data);
            return;
        }
        let is_new = queued.is_none();
        if is_new {
            self.sequence += 1;
            self.probes.insert(
                id.to_owned(),
                Probe {
                    guard: format!("ancestry:{}", self.sequence),
                    events: Vec::new(),
                    needs_recovery: host.recovering(),
                    lookup_failed: false,
                },
            );
        }
        let Some(probe) = self.probes.get_mut(id) else {
            return;
        };
        probe.events.push(Entry {
            data: data.clone(),
            watermark,
            bytes,
        });
        self.unknown_bytes += bytes;
        let guard = probe.guard.clone();
        host.buffered(data, watermark);
        if is_new {
            host.pending(&guard);
            host.lookup(id, &guard);
        }
    }

    /// `observePending`: a recovery pass starts, so every held event is part of
    /// the evidence a snapshot must cover.
    pub fn observe_pending(&mut self, observe: &mut dyn FnMut(&Value, u64)) {
        for probe in self.probes.values_mut() {
            probe.needs_recovery = true;
            for entry in &probe.events {
                observe(&entry.data, entry.watermark);
            }
        }
    }

    /// `needsSnapshots`: an owned probe still lacks one of its snapshots.
    pub fn needs_snapshots(&self, complete: &dyn Fn(&str) -> bool, host: &dyn ProbeHost) -> bool {
        self.probes
            .keys()
            .any(|id| host.owns_session(id) && !complete(id))
    }

    /// `shells`: every shell a held `shell.created` named, and its probe's id.
    pub fn shells(&self) -> IndexMap<String, String> {
        let mut shells = IndexMap::new();
        for (owner, probe) in &self.probes {
            for entry in &probe.events {
                let envelope = fields(&entry.data);
                if s_in(envelope, "type") != "shell.created" {
                    continue;
                }
                let payload = fields(get(envelope, "data"));
                let id = s_in(fields(get(payload, "info")), "id");
                if !id.is_empty() {
                    shells.insert(id.to_owned(), owner.clone());
                }
            }
        }
        shells
    }

    /// `needsShellSnapshots`: an owned probe's shell has no snapshot yet.
    pub fn needs_shell_snapshots(
        &self,
        complete: &dyn Fn(&str, &str) -> bool,
        host: &dyn ProbeHost,
    ) -> bool {
        self.shells()
            .into_iter()
            .any(|(id, owner)| host.owns_session(&owner) && !complete(&id, &owner))
    }

    /// `reconciled`: the pass is over; an owned probe replays and every probe
    /// that was looked up leaves.
    ///
    /// The events are collected before they are delivered: a replay calls back
    /// into the tenant, which takes the probe lock again (`owns` → `prove`).
    pub fn reconciled(&mut self, host: &dyn ProbeHost) -> Result<(), ProbeError> {
        let ids: Vec<String> = self.probes.keys().cloned().collect();
        for id in ids {
            let owned = host.owns_session(&id);
            let Some(probe) = self.probes.get(&id) else {
                continue;
            };
            if !owned && !probe.lookup_failed {
                continue;
            }
            let replay: Vec<(Value, u64)> = if owned {
                probe
                    .events
                    .iter()
                    .map(|entry| (entry.data.clone(), entry.watermark))
                    .collect()
            } else {
                Vec::new()
            };
            for (data, watermark) in replay {
                host.receive(&data, watermark)?;
            }
            self.finish(&id, host);
        }
        Ok(())
    }

    /// `finish`: the probe's bytes go back and its receipt settles.
    fn finish(&mut self, id: &str, host: &dyn ProbeHost) {
        let Some(probe) = self.probes.shift_remove(id) else {
            return;
        };
        for entry in &probe.events {
            self.unknown_bytes -= entry.bytes;
        }
        host.settled(&probe.guard);
    }

    /// The guard a probe holds, for the lookup's reply (E3-opencode.3).
    pub fn guard(&self, id: &str) -> Option<&str> {
        self.probes.get(id).map(|probe| probe.guard.as_str())
    }

    /// Mark the probe's lookup as failed, as the chain's `catch` does.
    pub fn mark_failed(&mut self, id: &str) -> bool {
        match self.probes.get_mut(id) {
            Some(probe) => {
                probe.needs_recovery = true;
                probe.lookup_failed = true;
                true
            }
            None => false,
        }
    }
}

#[cfg(test)]
mod tests;
