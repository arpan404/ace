// SPDX-License-Identifier: Apache-2.0
//! Who controls one device (`packages/devices/src/lease.ts` rule for rule, and
//! `lease-expiry.ts`'s owner name).
//!
//! Priority 1 (behaviour.md §3): an agent never acts on a device it doesn't
//! hold, and a person's takeover invalidates every pending agent command,
//! including those waiting on an SDK lookup or a permission check. A takeover
//! is `claim` (the epoch moves), and an expired lease keeps its actor for
//! `resume` only — never a revoked or transferred one.
//!
//! Every method that reads the clock takes `now`; the service passes its own.

use indexmap::IndexMap;

use crate::error::DeviceError;

use super::words;

/// `claim`'s lease length (`lease.ts:25`).
pub const LEASE_MS: f64 = 30_000.0;
/// The catalog key of the refusal a caller without the lease gets
/// (`lease.ts:74`-`:79`).
pub const LEASE_REQUIRED_KEY: &str = "leaseRequired";

/// Who is acting: a person, or an agent in a thread.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActorKind {
    Human,
    Agent,
}

impl ActorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Human => "human",
            Self::Agent => "agent",
        }
    }
}

/// `Actor`: the identity a lease is held by. `guard` (the TypeScript's lifetime
/// recheck) belongs to the caller that awaits, not to the lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub kind: ActorKind,
    pub owner: String,
    pub thread_id: Option<String>,
    pub agent_id: Option<String>,
}

impl Actor {
    pub fn human(owner: &str) -> Self {
        Self {
            kind: ActorKind::Human,
            owner: owner.to_owned(),
            thread_id: None,
            agent_id: None,
        }
    }

    pub fn agent(owner: &str, thread_id: &str, agent_id: &str) -> Self {
        Self {
            kind: ActorKind::Agent,
            owner: owner.to_owned(),
            thread_id: Some(thread_id.to_owned()),
            agent_id: Some(agent_id.to_owned()),
        }
    }
}

/// The `controller` field of `status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Controller {
    None,
    Human,
    Agent,
}

impl Controller {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Human => "human",
            Self::Agent => "agent",
        }
    }
}

/// The `holder` a person's tools never read: only an agent with both ids has one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub thread_id: String,
    pub agent_id: String,
}

/// `status()`: who controls the device, until when, and the agent holding it.
#[derive(Debug, Clone, PartialEq)]
pub struct LeaseStatus {
    pub controller: Controller,
    pub expires_at: Option<f64>,
    pub holder: Option<Holder>,
}

/// One `retain` call's ticket. Dropping it does not release: the caller says so
/// with [`ControllerLease::release_retained`], which consumes it, so a second
/// release is impossible — the TypeScript's per-closure `released` flag — and no
/// per-call entry is kept in the lease (its `retained` counts per epoch only).
#[derive(Debug, PartialEq, Eq)]
pub struct Retained {
    epoch: u64,
}

impl Retained {
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
}

/// `ControllerLease`: the one control of a device.
#[derive(Debug, Default)]
pub struct ControllerLease {
    epoch: u64,
    actor: Option<Actor>,
    expired: Option<Actor>,
    deadline: f64,
    /// `this.retained`: how many pending actions hold each epoch alive.
    retained: IndexMap<u64, u32>,
}

impl ControllerLease {
    pub fn new() -> Self {
        Self::default()
    }

    /// `claim`: a new control. Taking over is what invalidates the previous
    /// holder's pending work, because the epoch moves.
    pub fn claim(&mut self, actor: Actor, now: f64) {
        self.expired = None;
        self.actor = Some(actor);
        self.deadline = now + LEASE_MS;
        self.epoch = self.epoch.saturating_add(1);
    }

    /// `release(owner?)`: with an owner, only that owner's control (held or
    /// expired) is released. Releasing a device nobody holds changes nothing
    /// and invalidates nothing, so the epoch stays.
    pub fn release(&mut self, owner: Option<&str>) {
        if let Some(owner) = owner
            && self.actor.as_ref().map(|actor| actor.owner.as_str()) != Some(owner)
            && self.expired.as_ref().map(|actor| actor.owner.as_str()) != Some(owner)
        {
            return;
        }
        self.expired = None;
        if self.actor.is_none() {
            return;
        }
        self.actor = None;
        self.deadline = 0.0;
        self.epoch = self.epoch.saturating_add(1);
    }

    /// `status`: renews while pending work retains the epoch, then expires a
    /// lease nobody renewed. The expired actor is kept for `resume` only.
    pub fn status(&mut self, now: f64) -> LeaseStatus {
        if self.actor.is_some() && self.retained.contains_key(&self.epoch) {
            self.deadline = now + LEASE_MS;
        }
        if self.actor.is_some() && now >= self.deadline {
            // `lease.ts` expires through `release()`, so an expiry moves the epoch
            // and clears the deadline exactly as a hand-back does.
            let expired = self.actor.clone();
            self.release(None);
            self.expired = expired;
        }
        let Some(actor) = self.actor.clone() else {
            return LeaseStatus {
                controller: Controller::None,
                expires_at: None,
                holder: None,
            };
        };
        // `lease.ts` tests the ids by truthiness, so an empty one names no holder.
        let holder = match (actor.kind, actor.thread_id, actor.agent_id) {
            (ActorKind::Agent, Some(thread_id), Some(agent_id))
                if !thread_id.is_empty() && !agent_id.is_empty() =>
            {
                Some(Holder {
                    thread_id,
                    agent_id,
                })
            }
            _ => None,
        };
        LeaseStatus {
            controller: match actor.kind {
                ActorKind::Human => Controller::Human,
                ActorKind::Agent => Controller::Agent,
            },
            expires_at: Some(self.deadline),
            holder,
        }
    }

    /// `retain`: pending actions keep their ticket's epoch alive, but a takeover
    /// still invalidates it. The caller releases the ticket when the action ends.
    pub fn retain(&mut self, actor: &Actor, epoch: u64, now: f64) -> Result<Retained, DeviceError> {
        self.assert_held(actor, Some(epoch), now)?;
        *self.retained.entry(epoch).or_insert(0) += 1;
        Ok(Retained { epoch })
    }

    /// The `release` closure `retain` returned, once per ticket.
    pub fn release_retained(&mut self, retained: Retained) {
        let count = self.retained.get(&retained.epoch).copied().unwrap_or(0);
        if count > 1 {
            self.retained.insert(retained.epoch, count - 1);
        } else {
            self.retained.shift_remove(&retained.epoch);
        }
    }

    /// `ticket`: the epoch a new action runs under, after proving the lease.
    pub fn ticket(&mut self, actor: &Actor, now: f64) -> Result<u64, DeviceError> {
        self.assert_held(actor, None, now)?;
        Ok(self.epoch)
    }

    /// `assert`: the rule an agent's every action starts with. It renews the
    /// lease it proves.
    pub fn assert_held(
        &mut self,
        actor: &Actor,
        epoch: Option<u64>,
        now: f64,
    ) -> Result<(), DeviceError> {
        if !self.holds(actor, epoch.unwrap_or(self.epoch), now) {
            return Err(words::refusal(LEASE_REQUIRED_KEY));
        }
        self.deadline = now + LEASE_MS;
        Ok(())
    }

    /// `holds`: the epoch and the actor's kind and owner still control it.
    pub fn holds(&mut self, actor: &Actor, epoch: u64, now: f64) -> bool {
        self.status(now);
        epoch == self.epoch
            && self
                .actor
                .as_ref()
                .is_some_and(|held| held.kind == actor.kind && held.owner == actor.owner)
    }

    /// `resume`: only an expired delegation comes back, never a revoked or
    /// transferred control.
    pub fn resume(&mut self, actor: Actor, now: f64) -> bool {
        self.status(now);
        if actor.kind != ActorKind::Agent
            || self.actor.is_some()
            || self.expired.as_ref().map(|expired| expired.owner.as_str())
                != Some(actor.owner.as_str())
        {
            return false;
        }
        self.claim(actor, now);
        true
    }

    /// `controlEpoch`: which control this is. It changes whenever anyone takes,
    /// hands back or loses the controls.
    pub fn control_epoch(&mut self, now: f64) -> u64 {
        self.status(now);
        self.epoch
    }

    /// `current`: the actor holding it, if any.
    pub fn current(&mut self, now: f64) -> Option<Actor> {
        self.status(now);
        self.actor.clone()
    }

    /// How many epochs have a pending action retaining them, for tests and
    /// diagnostics: the TypeScript's `retained` map has one entry per epoch.
    pub fn retained_epochs(&self) -> usize {
        self.retained.len()
    }

    /// `owned`: whether this owner holds it.
    pub fn owned(&mut self, owner: &str, now: f64) -> bool {
        self.status(now);
        self.actor.as_ref().map(|actor| actor.owner.as_str()) == Some(owner)
    }
}

/// `agentOwner`: the lease owner name of one agent in one thread, as
/// `JSON.stringify([threadId, agentId])` writes it.
pub fn agent_owner(thread_id: &str, agent_id: &str) -> String {
    ace_json::to_string(&ace_json::json!([thread_id, agent_id]))
}

pub mod watch;

pub use watch::{LeaseWatch, WatchStep};

#[cfg(test)]
mod tests;
