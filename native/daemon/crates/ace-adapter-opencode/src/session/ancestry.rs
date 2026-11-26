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
    /// `session.ts:137`: the receipt's note and, while recovering, its evidence.
    /// A refusal is the TypeScript's throw (`ancestry.ts:64`-`:82`).
    fn buffered(&self, data: &Value, watermark: u64) -> Result<(), ProbeError>;
    fn pending(&self, guard: &str) -> Result<(), ProbeError>;
    fn settled(&self, guard: &str);
    fn failed(&self, data: &Value);
    /// One GET chain for a new probe (E3-opencode.3): its replies come back
    /// through the probe's own state, not through this call.
    fn lookup(&self, id: &str, guard: &str);
}

/// A receipt's failure, as the TypeScript's thrown `Error` text. The pass that
/// replayed the receipt rejects with it, exactly as `recoverOnce` does.
pub type ProbeError = String;

/// One probe `reconciled` acts on: its id and the events to replay, oldest first.
pub struct Reconcile {
    pub id: String,
    pub events: Vec<(Value, u64)>,
}

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
    /// The event that started the probe: the one `failed` reports.
    trigger: Value,
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
    ///
    /// A receipt sink that refuses rolls the receipt back before the error
    /// reaches routing, which fails the stream (`ancestry.ts:64`-`:82`).
    pub fn prove(
        &mut self,
        data: &Value,
        watermark: u64,
        host: &dyn ProbeHost,
    ) -> Result<(), ProbeError> {
        let envelope = fields(data);
        let Some(Value::Object(location)) = envelope.get("location") else {
            return Ok(());
        };
        let id = event_session(data);
        if id.is_empty()
            || host.owns_session(id)
            || s_in(location, "directory") != host.directory()
            || s_in(envelope, "type") == "session.created"
        {
            return Ok(());
        }
        let bytes = ace_json::to_string(data).len();
        let queued = self.probes.get(id);
        if self.unknown_bytes + bytes > MAX_BYTES
            || queued.is_some_and(|probe| probe.events.len() >= MAX_EVENTS)
            || (queued.is_none() && self.probes.len() >= MAX_PROBES)
        {
            host.failed(data);
            return Ok(());
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
                    trigger: data.clone(),
                },
            );
        }
        let Some(probe) = self.probes.get_mut(id) else {
            return Ok(());
        };
        probe.events.push(Entry {
            data: data.clone(),
            watermark,
            bytes,
        });
        self.unknown_bytes += bytes;
        let guard = probe.guard.clone();
        // `pendingStarted` is set before the call, as the TypeScript sets it.
        let mut pending_started = false;
        let delivered = host.buffered(data, watermark).and_then(|()| {
            if is_new {
                pending_started = true;
                host.pending(&guard)
            } else {
                Ok(())
            }
        });
        if let Err(error) = delivered {
            if self
                .probes
                .get_mut(id)
                .and_then(|probe| probe.events.pop())
                .is_some()
            {
                self.unknown_bytes -= bytes;
            }
            if is_new && self.probes.shift_remove(id).is_some() && pending_started {
                host.settled(&guard);
            }
            return Err(error);
        }
        if is_new {
            host.lookup(id, &guard);
        }
        Ok(())
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
    /// The list is collected under this lock and delivered by the caller with
    /// the lock released: a replay re-enters `owns` → `prove`, which takes this
    /// lock again. The caller finishes each probe with [`Self::finish`], so a
    /// failed delivery leaves that probe for the next pass, as the TypeScript's
    /// throw does.
    pub fn reconcile_order(&self, host: &dyn ProbeHost) -> Vec<Reconcile> {
        let mut order = Vec::new();
        for (id, probe) in &self.probes {
            let owned = host.owns_session(id);
            if !owned && !probe.lookup_failed {
                continue;
            }
            let events = if owned {
                probe
                    .events
                    .iter()
                    .map(|entry| (entry.data.clone(), entry.watermark))
                    .collect()
            } else {
                Vec::new()
            };
            order.push(Reconcile {
                id: id.clone(),
                events,
            });
        }
        order
    }

    /// `finish`: the probe's bytes go back and its receipt settles.
    pub fn finish(&mut self, id: &str, host: &dyn ProbeHost) {
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

    /// Whether the probe's facts need a pass (`probe.needsRecovery`).
    pub fn needs_recovery(&self, id: &str) -> bool {
        self.probes
            .get(id)
            .is_some_and(|probe| probe.needs_recovery)
    }

    /// The probe's held events and their watermarks, in arrival order.
    pub fn events(&self, id: &str) -> Vec<(Value, u64)> {
        self.probes.get(id).map_or_else(Vec::new, |probe| {
            probe
                .events
                .iter()
                .map(|entry| (entry.data.clone(), entry.watermark))
                .collect()
        })
    }

    /// The event that started the probe, for `failed`.
    pub fn trigger(&self, id: &str) -> Option<Value> {
        self.probes.get(id).map(|probe| probe.trigger.clone())
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
