// SPDX-License-Identifier: Apache-2.0
//! One connection's subscribes and unsubscribes of each device
//! (`packages/devices/src/device-queue.ts`), strictly one at a time so a
//! subscribe's setup and rollback only ever meet the committed state.
//!
//! The latest wins: a new operation tells the one running that it is superseded
//! (it ends and rolls back before the next starts), and a subscribe still
//! waiting its turn when a newer operation comes is dropped without running.
//! Unsubscribes always run.
//!
//! Sans-IO: the service starts what the queue names and reports each end, so no
//! promise chain lives here. The TypeScript's `held.tail` is this queue's
//! per-device chain, and its `ticket.superseded` is [`DeviceQueue::superseded`].

use std::collections::VecDeque;

use indexmap::IndexMap;

/// What one submission asks the connection to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Subscribe,
    Unsubscribe,
}

/// `new Error("Device subscription superseded")`.
pub const SUPERSEDED: &str = "Device subscription superseded";

/// One operation the queue has decided about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Run {
    pub id: u64,
    pub device: String,
    pub kind: Kind,
}

/// What a submission leads to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Started {
    /// Nothing else runs on this device: the connection starts it now, and asks
    /// [`DeviceQueue::superseded`] before it sets anything up.
    Run(Run),
    /// It waits its turn; the queue names it when the one before ends.
    Queued(u64),
}

/// What one finished operation leads to.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Finished {
    /// Subscribes a newer operation passed before their turn: each fails with
    /// [`SUPERSEDED`] and never runs.
    pub dropped: Vec<u64>,
    /// The operation to start next, when one is ready.
    pub next: Option<Run>,
}

/// One submission, until the queue decides about it.
#[derive(Debug, Clone)]
struct Ticket {
    kind: Kind,
    /// The generation it was submitted under; a newer submission bumps it.
    generation: u64,
}

/// One device's chain.
#[derive(Debug, Default)]
struct Device {
    /// Bumped by every submission: only the latest subscribe may run.
    generation: u64,
    running: Option<u64>,
    waiting: VecDeque<u64>,
}

/// The queue of one connection.
#[derive(Debug, Default)]
pub struct DeviceQueue {
    devices: IndexMap<String, Device>,
    tickets: IndexMap<u64, Ticket>,
    next: u64,
}

impl DeviceQueue {
    pub fn new() -> Self {
        Self::default()
    }

    /// `run(device, kind, task)`: a new submission supersedes whatever runs and
    /// whatever a stale subscribe was waiting for.
    pub fn submit(&mut self, device: &str, kind: Kind) -> Started {
        let id = self.next;
        self.next = self.next.saturating_add(1);
        let entry = self.devices.entry(device.to_owned()).or_default();
        entry.generation = entry.generation.saturating_add(1);
        let generation = entry.generation;
        self.tickets.insert(id, Ticket { kind, generation });
        if entry.running.is_some() {
            entry.waiting.push_back(id);
            return Started::Queued(id);
        }
        entry.running = Some(id);
        Started::Run(Run {
            id,
            device: device.to_owned(),
            kind,
        })
    }

    /// Whether the running operation `id` has been told it is superseded. The
    /// service reads this where the TypeScript passed `() => ticket.superseded`.
    pub fn superseded(&self, device: &str, id: u64) -> bool {
        match (self.devices.get(device), self.tickets.get(&id)) {
            (Some(entry), Some(ticket)) => entry.generation != ticket.generation,
            _ => false,
        }
    }

    /// The running operation ended (either way): every stale subscribe in
    /// front is dropped, then the next one starts, or the chain is over.
    pub fn finish(&mut self, device: &str, id: u64) -> Finished {
        let Some(entry) = self.devices.get_mut(device) else {
            return Finished::default();
        };
        if entry.running != Some(id) {
            return Finished::default();
        }
        entry.running = None;
        self.tickets.shift_remove(&id);
        let finished = self.decide(device);
        self.prune(device);
        finished
    }

    /// How many operations wait for this device, for tests and diagnostics.
    pub fn waiting(&self, device: &str) -> usize {
        self.devices
            .get(device)
            .map_or(0, |entry| entry.waiting.len())
    }

    /// Whether anything runs on this device.
    pub fn running(&self, device: &str) -> bool {
        self.devices
            .get(device)
            .is_some_and(|entry| entry.running.is_some())
    }

    /// Start the next waiting operation, dropping the stale subscribes in front.
    fn decide(&mut self, device: &str) -> Finished {
        let mut finished = Finished::default();
        loop {
            let (id, generation) = {
                let Some(entry) = self.devices.get_mut(device) else {
                    return finished;
                };
                let Some(id) = entry.waiting.pop_front() else {
                    return finished;
                };
                (id, entry.generation)
            };
            let Some(ticket) = self.tickets.get(&id).cloned() else {
                continue;
            };
            // A subscribe waits only for the latest submission
            // (`device-queue.ts:32`); an unsubscribe always runs.
            if ticket.kind == Kind::Subscribe && ticket.generation != generation {
                self.tickets.shift_remove(&id);
                finished.dropped.push(id);
                continue;
            }
            let Some(entry) = self.devices.get_mut(device) else {
                return finished;
            };
            entry.running = Some(id);
            finished.next = Some(Run {
                id,
                device: device.to_owned(),
                kind: ticket.kind,
            });
            return finished;
        }
    }

    /// Forget an idle device, as the TypeScript deletes the entry once its tail
    /// settles and its generation is still the one it ran under.
    fn prune(&mut self, device: &str) {
        let idle = self
            .devices
            .get(device)
            .is_some_and(|entry| entry.running.is_none() && entry.waiting.is_empty());
        if idle {
            self.devices.shift_remove(device);
        }
    }
}

#[cfg(test)]
mod tests;
