// SPDX-License-Identifier: Apache-2.0
//! Who takes a device, and how control moves between holders
//! (`packages/devices/src/service.ts`: `claimForAgent`, `authorize` and
//! `assignController`).
//!
//! Priority 1 (behaviour.md §3): a person's takeover invalidates every pending
//! agent command, including one still waiting on a cleanup. Every takeover bumps
//! `controlRevision`, releases the lease before anything is awaited, and a holder
//! that comes back to a different revision loses with `busy`.

use super::binding::{Bind, Bound, TURNED_OFF_KEY, begin_bind, begin_bind_for_person, finish_bind};
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
/// The operations ace keeps for a person (`service.ts:585`).
pub const PERSON_ONLY_OPS: [&str; 4] = [
    "enable",
    "controller",
    "stream.configure",
    "stream.keyframe",
];
/// The catalog key of the person-only refusal.
pub const PERSON_ONLY_KEY: &str = "personOnly";
/// Downloading the device tools is a person's (`service.ts:636`).
pub const TOOLS_PERSON_ONLY_KEY: &str = "toolsPersonOnly";
/// Asking macOS for a permission is a person's (`service.ts:924`).
pub const HUMAN_AUTHORIZATION_KEY: &str = "humanAuthorization";

/// `perform`'s person-only gate: ace's own actions a person takes, never an
/// approval gate on a provider's decision.
pub fn require_person(operation: &str, actor: &Actor) -> Result<(), DeviceError> {
    if actor.kind == ActorKind::Human {
        return Ok(());
    }
    if PERSON_ONLY_OPS.contains(&operation) {
        return Err(words::refusal(PERSON_ONLY_KEY));
    }
    match operation {
        "tools.install" => Err(words::refusal(TOOLS_PERSON_ONLY_KEY)),
        "permissions.request" => Err(words::refusal(HUMAN_AUTHORIZATION_KEY)),
        _ => Ok(()),
    }
}

/// What `claimForAgent` decided for an agent's `sim_start`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Claim {
    /// The agent already holds the device for this thread: nothing to do.
    Already,
    /// Bind the device to the agent's thread, then take control.
    Take,
}

fn require_agent_caller(actor: &Actor) -> Result<(&str, &str), DeviceError> {
    if actor.kind != ActorKind::Agent {
        return Err(DeviceError::InvalidInput(String::from(
            AGENT_CALLER_REQUIRED,
        )));
    }
    let thread_id = actor
        .thread_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DeviceError::InvalidInput(String::from(AGENT_CALLER_REQUIRED)))?;
    let agent_id = actor
        .agent_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| DeviceError::InvalidInput(String::from(AGENT_CALLER_REQUIRED)))?;
    Ok((thread_id, agent_id))
}

/// Clear the bind this claim started, and only that one: a newer bind — a
/// person's, started after it — keeps its guard and its epoch, so its own
/// cleanup is not refused `bindingDisabled` by a stale agent that landed later.
fn abort_stale_bind(session: &mut Session, bind: &Bind) {
    let Bind::Cleanup { epoch, .. } = bind else {
        return;
    };
    if session.changing_binding && session.binding_epoch == *epoch {
        session.changing_binding = false;
    }
}

fn control_still_current(session: &Session, bind: &Bind) -> bool {
    bind.control_revision() == session.control_revision
}

/// Shared gates before an agent may take or bind a device.
fn agent_takeover_allowed(
    session: &mut Session,
    actor: &Actor,
    now: f64,
    pending_agents_block: bool,
) -> Result<(), DeviceError> {
    match session.pending_controller_kind {
        Some(ActorKind::Human) => return Err(words::refusal(PERSON_CONTROLLING_KEY)),
        Some(ActorKind::Agent) if pending_agents_block => {
            return Err(words::refusal(OTHER_AGENT_KEY));
        }
        _ => {}
    }
    match session.lease.current(now) {
        Some(current) if current.kind == ActorKind::Human => {
            return Err(words::refusal(PERSON_CONTROLLING_KEY));
        }
        Some(current) if current.owner != actor.owner => {
            return Err(words::refusal(OTHER_AGENT_KEY));
        }
        _ => {}
    }
    Ok(())
}

/// `claimForAgent`: an agent takes a free device, or one it already holds, with no
/// prompt. A person in control, or another agent holding it, refuses — control
/// moves only on hand-back or lease expiry.
pub fn claim_for_agent(
    session: &mut Session,
    actor: &Actor,
    now: f64,
) -> Result<Claim, DeviceError> {
    let (thread_id, _agent_id) = require_agent_caller(actor)?;
    agent_takeover_allowed(session, actor, now, true)?;
    match session.lease.current(now) {
        Some(_) if session.thread_id.as_deref() == Some(thread_id) => return Ok(Claim::Already),
        _ => {}
    }
    Ok(Claim::Take)
}

/// `claimForAgent`'s bind half: reserve the device for the agent's thread before
/// anything is awaited, but only while no person's takeover is in flight.
pub fn start_bind_for_agent(
    session: &mut Session,
    actor: &Actor,
    now: f64,
) -> Result<Bind, DeviceError> {
    let (thread_id, _) = require_agent_caller(actor)?;
    agent_takeover_allowed(session, actor, now, true)?;
    begin_bind(session, thread_id)
}

/// A person's `controller` with a thread: the takeover it reserved and the bind
/// that moves the device to that thread. They finish together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadedTakeover {
    assignment: Assignment,
    bind: Bind,
}

/// `controller` with a thread for a person: reserve control, then supersede any
/// agent bind and move the device to that thread.
pub fn start_human_controller_with_thread(
    session: &mut Session,
    person: &Actor,
    thread_id: &str,
    now: f64,
) -> Result<ThreadedTakeover, DeviceError> {
    if person.kind != ActorKind::Human {
        return Err(words::refusal(PERSON_ONLY_KEY));
    }
    let assignment = begin_assign(session, person, now)?;
    let bind = begin_bind_for_person(session, thread_id)?;
    Ok(ThreadedTakeover { assignment, bind })
}

/// Finishes a person's threaded controller after bind cleanup.
pub fn resume_human_controller_with_thread(
    session: &mut Session,
    takeover: ThreadedTakeover,
    thread_id: &str,
    holder: Option<&Actor>,
    cleanup_failed: bool,
    enabled: bool,
    now: f64,
) -> Result<(), DeviceError> {
    let ThreadedTakeover { assignment, bind } = takeover;
    if !control_still_current(session, &bind) {
        abort_stale_bind(session, &bind);
        cancel_assign(session, assignment);
        return Err(words::refusal(CONTROL_CHANGED_KEY));
    }
    match &bind {
        Bind::Unchanged { epoch, .. } => {
            // No cleanup ran, but a disable still refuses the takeover: this bind
            // may not hand control over across it.
            if !enabled || session.binding_epoch != *epoch {
                cancel_assign(session, assignment);
                return Err(words::refusal(TURNED_OFF_KEY));
            }
        }
        Bind::Cleanup { epoch, .. } => {
            match finish_bind(session, thread_id, *epoch, cleanup_failed, enabled) {
                Ok(Bound::CleanupFailed) => {
                    cancel_assign(session, assignment);
                    return Ok(());
                }
                Ok(Bound::Bound) => {}
                Err(error) => {
                    abort_stale_bind(session, &bind);
                    cancel_assign(session, assignment);
                    return Err(error);
                }
            }
        }
    }
    if !control_still_current(session, &bind) {
        abort_stale_bind(session, &bind);
        cancel_assign(session, assignment);
        return Err(words::refusal(CONTROL_CHANGED_KEY));
    }
    finish_assign(session, assignment, holder, now)
}

/// After a bind's cleanup: revalidate the claim, then begin handing control to the
/// agent — the same path `claimForAgent` resumes on.
pub fn resume_claim_for_agent(
    session: &mut Session,
    actor: &Actor,
    bind: Bind,
    cleanup_failed: bool,
    enabled: bool,
    now: f64,
) -> Result<Option<Assignment>, DeviceError> {
    let (thread_id, _) = require_agent_caller(actor)?;
    if !control_still_current(session, &bind) {
        abort_stale_bind(session, &bind);
        return Err(words::refusal(CONTROL_CHANGED_KEY));
    }
    match &bind {
        Bind::Unchanged { epoch, .. } => {
            // Its device already belonged to this thread when the claim began; a
            // disable since then still refuses the takeover.
            if !enabled || session.binding_epoch != *epoch {
                return Err(words::refusal(TURNED_OFF_KEY));
            }
        }
        Bind::Cleanup { epoch, .. } => {
            match finish_bind(session, thread_id, *epoch, cleanup_failed, enabled) {
                Ok(Bound::CleanupFailed) => return Ok(None),
                Ok(Bound::Bound) => {}
                Err(error) => {
                    abort_stale_bind(session, &bind);
                    return Err(error);
                }
            }
        }
    }
    if !control_still_current(session, &bind) {
        abort_stale_bind(session, &bind);
        return Err(words::refusal(CONTROL_CHANGED_KEY));
    }
    agent_takeover_allowed(session, actor, now, true)?;
    if session.thread_id.as_deref() != Some(thread_id) {
        return Err(words::refusal(NOT_TAKEN_KEY));
    }
    if session
        .lease
        .current(now)
        .is_some_and(|current| current.owner == actor.owner)
    {
        return Ok(None);
    }
    begin_assign(session, actor, now).map(Some)
}

/// `authorize`: devices on, no bind in flight for agents, and an agent only on the
/// device its thread took. The caller's own lifetime (`actor.guard`) is the shell's
/// check. A person's takeover is not blocked by another agent's bind.
pub fn authorize(
    session: &Session,
    actor: &Actor,
    enabled: bool,
    closed: bool,
) -> Result<(), DeviceError> {
    if closed || !enabled {
        return Err(words::refusal(DISABLED_KEY));
    }
    if session.changing_binding && actor.kind == ActorKind::Agent {
        return Err(words::refusal(DISABLED_KEY));
    }
    if actor.kind == ActorKind::Agent
        && (actor.thread_id.as_deref().is_none_or(str::is_empty)
            || session.thread_id != actor.thread_id)
    {
        return Err(words::refusal(NOT_TAKEN_KEY));
    }
    Ok(())
}

/// One takeover in flight: the revision it began under, the generation it saw, and
/// who began it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub revision: u64,
    pub generation: u64,
    pub kind: ActorKind,
    pub owner: String,
}

impl Assignment {
    pub fn revision(&self) -> u64 {
        self.revision
    }
}

fn clear_pending(session: &mut Session) {
    session.pending_controller = None;
    session.pending_controller_kind = None;
}

fn pending_still_matches(session: &Session, assignment: &Assignment) -> bool {
    session.pending_controller.as_deref() == Some(assignment.owner.as_str())
        && assignment.revision == session.control_revision
}

/// `disconnect` / owner drop: invalidate only this owner's pending takeover
/// (`service.ts:1199`).
pub fn invalidate_pending_owner(session: &mut Session, owner: &str) {
    if session.pending_controller.as_deref() == Some(owner) {
        session.control_revision = session.control_revision.saturating_add(1);
        clear_pending(session);
    }
}

/// `assignController`'s first half: mark the takeover, then let go of control
/// before the capture's held input is released. The caller awaits the cleanup and
/// calls [`finish_assign`] with the result.
pub fn begin_assign(
    session: &mut Session,
    requester: &Actor,
    now: f64,
) -> Result<Assignment, DeviceError> {
    if requester.kind == ActorKind::Agent {
        agent_takeover_allowed(session, requester, now, false)?;
    } else if session.pending_controller_kind == Some(ActorKind::Human)
        && session.pending_controller.as_deref() != Some(requester.owner.as_str())
    {
        return Err(words::refusal(PERSON_CONTROLLING_KEY));
    }
    session.control_revision = session.control_revision.saturating_add(1);
    let assignment = Assignment {
        revision: session.control_revision,
        generation: session.generation,
        kind: requester.kind,
        owner: requester.owner.clone(),
    };
    session.pending_controller = Some(requester.owner.clone());
    session.pending_controller_kind = Some(requester.kind);
    session.lease.release(None);
    Ok(assignment)
}

/// A takeover whose cleanup failed, or whose owner was dropped: invalidate only
/// when this assignment still owns the pending marker (`service.ts:1199`).
pub fn cancel_assign(session: &mut Session, assignment: Assignment) {
    if !pending_still_matches(session, &assignment) {
        return;
    }
    session.control_revision = session.control_revision.saturating_add(1);
    clear_pending(session);
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
        if pending_still_matches(session, &assignment) {
            clear_pending(session);
        }
        return Err(words::refusal(CONTROL_CHANGED_KEY));
    }
    if !pending_still_matches(session, &assignment) {
        return Err(words::refusal(CONTROL_CHANGED_KEY));
    }
    clear_pending(session);
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
