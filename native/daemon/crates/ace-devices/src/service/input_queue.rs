// SPDX-License-Identifier: Apache-2.0
//! The device input queue (`packages/devices/src/input-queue.ts`): one lane per
//! actor kind, 32 waiting per kind, and the guard every retry re-proves.
//!
//! Priority 1 (behaviour.md §3): a person's takeover invalidates every pending
//! agent command, including one waiting for the person to stop using the
//! device. An admitted input keeps its ticket alive while it waits (`retain`),
//! so a takeover still moves the epoch and the next guard fails it.
//!
//! Sans-IO: the shell owns the session's `tail` chain and awaits the person;
//! this module decides admission, the counts, the guard and the result a waited
//! action returns. The TypeScript's retry loop is: guard, wait for the person,
//! guard, take the tail, guard, and give the queue back if the person became
//! active in the meantime — the shell asks [`super::lease`] and cowork for
//! those, and this module for everything else.

use ace_json::{JsString, Value};

use super::lease::{Actor, ActorKind, ControllerLease, Retained};
use super::words;
use crate::error::DeviceError;

/// `session.pendingInput[kind] >= 32` refuses with `busy` (`input-queue.ts:23`).
pub const MAX_PENDING_PER_KIND: usize = 32;
/// The catalog key of that refusal.
pub const QUEUE_FULL_KEY: &str = "inputQueueFull";

/// `session.pendingInput` and `session.pending`: the per-kind admission counts.
/// Separate lanes keep waiting agents from refusing the person's input.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PendingInput {
    human: usize,
    agent: usize,
    /// `session.pending`: both lanes, which is what an idle-session sweep reads.
    total: usize,
}

impl PendingInput {
    pub fn new() -> Self {
        Self::default()
    }

    /// How many inputs of this kind wait now.
    pub fn count(&self, kind: ActorKind) -> usize {
        match kind {
            ActorKind::Human => self.human,
            ActorKind::Agent => self.agent,
        }
    }

    /// Every waiting input, both lanes.
    pub fn total(&self) -> usize {
        self.total
    }

    /// Whether this kind's lane has no room (`input-queue.ts:23`).
    pub fn full(&self, kind: ActorKind) -> bool {
        self.count(kind) >= MAX_PENDING_PER_KIND
    }

    fn admitted(&mut self, kind: ActorKind) {
        match kind {
            ActorKind::Human => self.human = self.human.saturating_add(1),
            ActorKind::Agent => self.agent = self.agent.saturating_add(1),
        }
        self.total = self.total.saturating_add(1);
    }

    fn finished(&mut self, kind: ActorKind) {
        match kind {
            ActorKind::Human => self.human = self.human.saturating_sub(1),
            ActorKind::Agent => self.agent = self.agent.saturating_sub(1),
        }
        self.total = self.total.saturating_sub(1);
    }
}

/// One agent input that was admitted: the ticket it runs under, and the retain
/// that keeps the lease alive until [`finish`] is called.
#[derive(Debug)]
pub struct Admission {
    ticket: u64,
    retained: Retained,
    kind: ActorKind,
}

impl Admission {
    /// The lease epoch this input runs under; every guard checks it again.
    pub fn ticket(&self) -> u64 {
        self.ticket
    }

    pub fn kind(&self) -> ActorKind {
        self.kind
    }
}

/// One person input admitted to the shared lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SharedInput {
    kind: ActorKind,
}

/// `enqueueDeviceInput`'s admission: prove the lease, check the lane, retain the
/// ticket, then count it. A refusal changes nothing.
pub fn admit(
    lease: &mut ControllerLease,
    pending: &mut PendingInput,
    actor: &Actor,
    now: f64,
) -> Result<Admission, DeviceError> {
    let ticket = lease.ticket(actor, now)?;
    if pending.full(actor.kind) {
        return Err(words::refusal(QUEUE_FULL_KEY));
    }
    let retained = lease.retain(actor, ticket, now)?;
    pending.admitted(actor.kind);
    Ok(Admission {
        ticket,
        retained,
        kind: actor.kind,
    })
}

/// `enqueueSharedInput`'s admission: the person's input in cowork takes no
/// ticket, but the lane still bounds it.
pub fn admit_shared(pending: &mut PendingInput, actor: &Actor) -> Result<SharedInput, DeviceError> {
    if pending.full(actor.kind) {
        return Err(words::refusal(QUEUE_FULL_KEY));
    }
    pending.admitted(actor.kind);
    Ok(SharedInput { kind: actor.kind })
}

/// The input ended, either way: its retain and its count go back.
pub fn finish(lease: &mut ControllerLease, pending: &mut PendingInput, admission: Admission) {
    lease.release_retained(admission.retained);
    pending.finished(admission.kind);
}

/// The shared input ended, either way.
pub fn finish_shared(pending: &mut PendingInput, shared: SharedInput) {
    pending.finished(shared.kind);
}

/// `guard`: the caller's lifetime (the shell's `authorize`) and the ticket's
/// lease, at every asynchronous boundary.
pub fn guard(
    lease: &mut ControllerLease,
    actor: &Actor,
    ticket: u64,
    now: f64,
) -> Result<(), DeviceError> {
    lease.assert_held(actor, Some(ticket), now)
}

/// `enqueueSharedInput`'s guard: the person's input passes in cowork, but input
/// queued before a Take control must respect its new exclusive holder.
pub fn shared_guard(
    lease: &mut ControllerLease,
    actor: &Actor,
    pending_controller: bool,
    now: f64,
) -> Result<(), DeviceError> {
    if pending_controller
        || lease
            .current(now)
            .is_some_and(|current| current.kind == ActorKind::Human)
    {
        return lease.assert_held(actor, None, now);
    }
    Ok(())
}

/// The result a waited action returns: a plain object carries the note, and
/// anything else is returned unchanged (`input-queue.ts:53`-`:56`).
pub fn with_waited(result: Value, waited: Option<&str>) -> Value {
    let Some(waited) = waited.filter(|waited| !waited.is_empty()) else {
        return result;
    };
    match result {
        Value::Object(mut object) => {
            object.insert("waited", Value::String(JsString::from(waited)));
            Value::Object(object)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests;
