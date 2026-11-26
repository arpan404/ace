// SPDX-License-Identifier: Apache-2.0
//! Who takes a device, and how control moves between holders
//! (`packages/devices/src/service.ts`: `claimForAgent`, `authorize` and
//! `assignController`).
//!
//! Priority 1 (behaviour.md §3): a person's takeover invalidates every pending
//! agent command, including one still waiting on a cleanup. Every takeover bumps
//! `controlRevision`, releases the lease before anything is awaited, and a holder
//! that comes back to a different revision loses with `busy`.

use super::lease::{Actor, ActorKind, ControllerLease};
use super::session::Session;
use super::words;
use crate::error::DeviceError;

/// An agent that took a device this connection may not act for (`service.ts:441`).
pub const AGENT_CALLER_REQUIRED: &str = "Agent caller required";

/// The catalog key of a person's control (`service.ts:449`).
pub const PERSON_CONTROLLING_KEY: &str = "personControlling";
/// Another agent holding the device (`service.ts:455`).
pub const OTHER_AGENT_KEY: &str = "otherAgentUsing";
/// A control that changed while a takeover cleaned up (`service.ts:893`).
pub const CONTROL_CHANGED_KEY: &str = "controlChanged";
/// An agent acting on a device its thread has not taken (`service.ts:546`).
pub const NOT_TAKEN_KEY: &str = "deviceNotTaken";
/// Devices off, or a bind in flight (`service.ts:533`).
pub const DISABLED_KEY: &str = "devicesDisabled";

/// What `claimForAgent` decided for an agent's `sim_start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// The agent already holds the device for this thread: nothing to do.
    Already,
    /// Bind the device to the agent's thread, then take control.
    Take,
}

/// `claimForAgent`: an agent takes a free device, or one it already holds, with no
/// prompt. A person in control, or another agent holding it, refuses — control
/// moves only on hand-back or lease expiry.
pub fn claim_for_agent(
    session: &mut Session,
    actor: &Actor,
    now: f64,
) -> Result<Claim, DeviceError> {
    let (Some(thread_id), Some(_agent_id)) =
        (actor.thread_id.as_deref(), actor.agent_id.as_deref())
    else {
        return Err(DeviceError::InvalidInput(String::from(
            AGENT_CALLER_REQUIRED,
        )));
    };
    if actor.kind != ActorKind::Agent {
        return Err(DeviceError::InvalidInput(String::from(
            AGENT_CALLER_REQUIRED,
        )));
    }
    match session.lease.current(now) {
        Some(current) if current.kind == ActorKind::Human => {
            return Err(words::refusal(PERSON_CONTROLLING_KEY));
        }
        Some(current) if current.owner != actor.owner => {
            return Err(words::refusal(OTHER_AGENT_KEY));
        }
        Some(_) if session.thread_id.as_deref() == Some(thread_id) => return Ok(Claim::Already),
        _ => {}
    }
    Ok(Claim::Take)
}

/// `authorize`: devices on, no bind in flight, and an agent only on the device its
/// thread took. The caller's own lifetime (`actor.guard`) is the shell's check.
pub fn authorize(
    session: &Session,
    actor: &Actor,
    enabled: bool,
    closed: bool,
) -> Result<(), DeviceError> {
    if closed || !enabled || session.changing_binding {
        return Err(words::refusal(DISABLED_KEY));
    }
    if actor.kind == ActorKind::Agent
        && (actor.thread_id.is_none() || session.thread_id != actor.thread_id)
    {
        return Err(words::refusal(NOT_TAKEN_KEY));
    }
    Ok(())
}

/// One takeover in flight: the revision it began under and the generation it saw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Assignment {
    revision: u64,
    generation: u64,
}

impl Assignment {
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

/// `assignController`'s first half: mark the takeover, then let go of control
/// before the capture's held input is released. The caller awaits the cleanup and
/// calls [`finish_assign`] with the result.
pub fn begin_assign(session: &mut Session, requester_owner: &str) -> Assignment {
    session.control_revision = session.control_revision.saturating_add(1);
    let assignment = Assignment {
        revision: session.control_revision,
        generation: session.generation,
    };
    session.pending_controller = Some(requester_owner.to_owned());
    session.lease.release(None);
    assignment
}

/// `assignController`'s second half: a takeover that is still the newest one takes
/// the device, and a late one loses with `busy` — the person's takeover wins over
/// an agent's start that was still cleaning up.
pub fn finish_assign(
    session: &mut Session,
    assignment: Assignment,
    holder: Option<&Actor>,
    now: f64,
) -> Result<(), DeviceError> {
    if assignment.revision != session.control_revision
        || assignment.generation != session.generation
    {
        return Err(words::refusal(CONTROL_CHANGED_KEY));
    }
    session.pending_controller = None;
    match holder {
        Some(holder) => session.lease.claim(holder.clone(), now),
        None => session.lease.release(None),
    }
    Ok(())
}

/// `ownsControl`: a person's control belongs to one connection's lifetime.
pub fn owns_control(lease: &mut ControllerLease, owner: &str, now: f64) -> bool {
    lease
        .current(now)
        .is_some_and(|current| current.kind == ActorKind::Human)
        && lease.owned(owner, now)
}

#[cfg(test)]
mod tests;
