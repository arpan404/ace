// SPDX-License-Identifier: Apache-2.0
//! Who takes a device, and how control moves between holders
//! (`packages/devices/src/service.ts`: `claimForAgent`, `authorize` and
//! `assignController`).
//!
//! Priority 1 (behaviour.md §3): a person's takeover invalidates every pending
//! agent command, including one still waiting on a cleanup. Every takeover bumps
//! `controlRevision`, releases the lease before anything is awaited, and a holder
//! that comes back to a different revision loses with `busy`.

use super::binding::{
    Bind, Bound, TURNED_OFF_KEY, begin_bind, begin_bind_for_person, fail_bind, finish_bind,
    holds_reservation,
};
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
/// person's, started after it — keeps its guard, its epoch and its recording, so
/// its own cleanup is not refused `bindingDisabled` by a stale agent that landed
/// later. The live bind that still owns the epoch clears the old thread's
/// published recording here, as `bindDevice`'s cleanup does, even when control
/// moved on. A completion replayed after that reservation was consumed, or a
/// superseded one, changes nothing: the epoch alone still matches, and the
/// recording published since belongs to the thread that holds the device now.
fn abort_stale_bind(session: &mut Session, bind: &Bind) {
    let Bind::Cleanup { epoch, .. } = bind else {
        return;
    };
    if !holds_reservation(session, *epoch) {
        return;
    }
    session.changing_binding = false;
    session.binding_owner = None;
    session.completed = None;
    session.recording_artifact = None;
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
    // `claimForAgent` asks `assertEnabled` before its bind (`service.ts:453`), so a
    // claim that lands while another bind cleans up answers `devicesDisabled`, not
    // the `bindingBusy` its own bind would report.
    if session.changing_binding {
        return Err(words::refusal(DISABLED_KEY));
    }
    let bind = begin_bind(session, thread_id, &actor.owner)?;
    // The claim is not a takeover: no assignment records the bind it started, so
    // record the epoch here. If the agent is dropped mid-cleanup, its own
    // invalidation retires exactly this reservation, and only while it is still the
    // live one.
    session.claim_bind_epoch = bind.cleanup_epoch();
    Ok(bind)
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
    let bind = begin_bind_for_person(session, thread_id, &person.owner)?;
    // Remember the epoch of the cleanup this assignment reserved, and only that: an
    // unchanged bind reserves nothing for a retire to clear, and the owner may start
    // another bind before this assignment is invalidated, whose live epoch a retire
    // must never take.
    session.pending_bind_epoch = bind.cleanup_epoch();
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
    if cleanup_failed && let Some(epoch) = bind.cleanup_epoch() {
        // `binding.ts` throws the cleanup's own failure before it checks the
        // disable, so a disable must not replace it. A disable moves the generation
        // and invalidates the pending takeover with it; a hand-back or a drop moves
        // only the revision, so this assignment still loses with `controlChanged`.
        let disabled = assignment.generation != session.generation;
        fail_bind(session, epoch);
        if !disabled && !control_still_current(session, &bind) {
            cancel_assign(session, assignment);
            return Err(words::refusal(CONTROL_CHANGED_KEY));
        }
        cancel_assign(session, assignment);
        return Ok(());
    }
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
            match finish_bind(session, thread_id, *epoch, false, enabled) {
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
    // The cleanup's own failure outranks the control check, as `binding.ts` throws
    // it before its epoch and disable checks: a disable and a fresh takeover that
    // landed during the cleanup must not replace it.
    if cleanup_failed && let Some(epoch) = bind.cleanup_epoch() {
        fail_bind(session, epoch);
        return Ok(None);
    }
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
            match finish_bind(session, thread_id, *epoch, false, enabled) {
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

/// `authorize`: devices on, no bind in flight, and an agent only on the device its
/// thread took. The caller's own lifetime (`actor.guard`) is the shell's check.
///
/// The bind guard is for everyone, a person included: while a bind cleans up, the
/// previous thread's completed recording and its publication are still published,
/// and an ordinary operation — a `record.stop`, say — must not consume them before
/// the bind clears them (`service.ts:525`, `assertEnabled`). Only the person's
/// `controller` entry point passes the guard, in [`authorize_controller`].
pub fn authorize(
    session: &Session,
    actor: &Actor,
    enabled: bool,
    closed: bool,
) -> Result<(), DeviceError> {
    if closed || !enabled || session.changing_binding {
        return Err(words::refusal(DISABLED_KEY));
    }
    require_taken(session, actor)
}

/// The person's `controller` entry point: a person's takeover supersedes the bind
/// that is still cleaning up, so only it may pass the bind guard. An agent never
/// does, even here; it takes the device like every other operation.
pub fn authorize_controller(
    session: &Session,
    actor: &Actor,
    enabled: bool,
    closed: bool,
) -> Result<(), DeviceError> {
    if closed || !enabled || (session.changing_binding && actor.kind != ActorKind::Human) {
        return Err(words::refusal(DISABLED_KEY));
    }
    require_taken(session, actor)
}

fn require_taken(session: &Session, actor: &Actor) -> Result<(), DeviceError> {
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
    session.pending_bind_epoch = None;
}

/// A disable stops every capture and unbinds the device, so a takeover whose
/// cleanup is still out must not claim afterwards. TypeScript re-authorizes after
/// the input release and moves the generation when it stops the capture; in Rust
/// the state transition invalidates the pending takeover itself.
pub(crate) fn invalidate_pending_control(session: &mut Session) {
    session.generation = session.generation.saturating_add(1);
    clear_pending(session);
}

fn pending_still_matches(session: &Session, assignment: &Assignment) -> bool {
    session.pending_controller.as_deref() == Some(assignment.owner.as_str())
        && assignment.revision == session.control_revision
}

/// Retire the bind reservation at `epoch`, and only that one: a reservation that
/// started later holds a newer epoch and keeps its guard and its owner, so its own
/// cleanup is not refused by a stale assignment that landed later. The cleanup this
/// reservation was waiting for is skipped from now on, so its publication is
/// cleared here, as `bindDevice` clears it before its own checks: an old recording
/// must not stay published.
fn retire_bind_at_epoch(session: &mut Session, epoch: u64) {
    if !session.changing_binding || session.binding_epoch != epoch {
        return;
    }
    session.binding_epoch = session.binding_epoch.saturating_add(1);
    session.changing_binding = false;
    session.binding_owner = None;
    session.completed = None;
    session.recording_artifact = None;
}

/// Retire the bind reservation this owner's takeover started, if it is still
/// running. An invalidated assignment must not leave the device reserved for a
/// cleanup nobody will finish: a person starts a threaded bind, hands back or
/// drops, and an agent's bind would otherwise be refused `bindingBusy` until the
/// person's stale continuation lands. Retire the epoch the assignment's own bind
/// began under, never the live one: a bind the same owner started later holds a
/// newer epoch and is not the assignment's to retire.
fn retire_owner_bind(session: &mut Session, owner: &str) {
    if session.binding_owner.as_deref() != Some(owner) {
        return;
    }
    let Some(epoch) = session.pending_bind_epoch else {
        return;
    };
    retire_bind_at_epoch(session, epoch);
}

/// Retire the bind in flight that no pending takeover owns: an agent's claim, or a
/// bind whose assignment is already gone. This takeover moves the revision, so that
/// bind's own continuation loses with `controlChanged` and nothing will ever finish
/// its cleanup; keeping its reservation would gate every ordinary operation — the
/// person's included — on a completion that cannot succeed. A bind a still-pending
/// owner started keeps its reservation and its epoch: that owner finishes it.
fn retire_unowned_bind(session: &mut Session, requester: &Actor) {
    let Some(owner) = session.binding_owner.clone() else {
        return;
    };
    if owner == requester.owner || session.pending_controller.as_deref() == Some(owner.as_str()) {
        return;
    }
    retire_bind_at_epoch(session, session.binding_epoch);
}

/// Retire the bind reservation this owner's claim started, and only that one.
///
/// An agent's claim has no assignment: nothing but [`start_bind_for_agent`] records
/// the epoch its bind began under. The agent's own drop still invalidates it, or the
/// reservation would gate every ordinary operation — the person's included — on a
/// completion nobody will deliver, or let a late completion reach an assignment for
/// an owner that is gone. A newer bind holds a newer epoch, whoever started it, and
/// keeps its guard and its recording.
fn retire_claim_bind(session: &mut Session, owner: &str) -> bool {
    if session.binding_owner.as_deref() != Some(owner) {
        return false;
    }
    let Some(epoch) = session.claim_bind_epoch else {
        return false;
    };
    if !holds_reservation(session, epoch) {
        return false;
    }
    session.claim_bind_epoch = None;
    retire_bind_at_epoch(session, epoch);
    true
}

/// `disconnect` / owner drop: invalidate only this owner's pending takeover
/// (`service.ts:1199`), and the bind that takeover left in flight.
pub fn invalidate_pending_owner(session: &mut Session, owner: &str) {
    if session.pending_controller.as_deref() == Some(owner) {
        session.control_revision = session.control_revision.saturating_add(1);
        retire_owner_bind(session, owner);
        clear_pending(session);
        return;
    }
    // No assignment of this owner's is pending, so the only bind it can have left in
    // flight is the one its claim began. Its continuation is now stale: the revision
    // moves too, so a late success answers `controlChanged` and assigns nothing.
    if retire_claim_bind(session, owner) {
        session.control_revision = session.control_revision.saturating_add(1);
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
    }
    // This takeover invalidates the requester's earlier one, so that one's bind
    // reservation goes with it: a hand-back is not blocked by its own clean-up.
    retire_owner_bind(session, &requester.owner);
    // It invalidates the assignment it replaces too, so the bind that assignment
    // left in flight is retired with it, at the epoch it holds: one person replaces
    // another's cleanup bind without a thread, and the agent that follows must bind
    // without waiting for the displaced person's stale continuation.
    if let Some(displaced) = session.pending_controller.clone() {
        retire_owner_bind(session, &displaced);
    }
    // A bind in flight that belongs to no pending takeover — an agent's claim, whose
    // resume this revision bump invalidates — is retired here, so the takeover's own
    // control is not gated on a cleanup that can no longer finish.
    retire_unowned_bind(session, requester);
    // A later person supersedes an earlier person's reservation, as `assignController`
    // does: the revision moves, so the earlier one loses with `controlChanged`.
    session.control_revision = session.control_revision.saturating_add(1);
    let assignment = Assignment {
        revision: session.control_revision,
        generation: session.generation,
        kind: requester.kind,
        owner: requester.owner.clone(),
    };
    session.pending_controller = Some(requester.owner.clone());
    session.pending_controller_kind = Some(requester.kind);
    // This assignment has no bind yet; the caller records the epoch of the one it
    // starts. The previous assignment's epoch does not belong to it.
    session.pending_bind_epoch = None;
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
