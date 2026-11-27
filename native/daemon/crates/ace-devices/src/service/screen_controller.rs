// SPDX-License-Identifier: Apache-2.0
//! Screen and device tools consult the same lease for a Simulator window
//! (`packages/devices/src/screen-controller.ts`).
//!
//! Sans-IO: `mirror` says what the screen manager is told, and the two callbacks
//! it hands back — a guard that re-proves the control, and a release that lets go
//! when the screen manager drops it — are decided here and run by the shell.

use super::lease::{Actor, ControllerLease};
use super::session::Session;
use crate::error::DeviceError;

/// What the screen manager is told about the device's control.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mirror {
    /// The capture has no screen session: nothing to mirror.
    None,
    /// Nobody controls the device.
    Cleared,
    /// This actor controls it, under this ticket.
    Controlled { actor: Actor, ticket: u64 },
}

/// `mirrorDeviceController`: the control the screen manager should show.
pub fn mirror(
    session: &mut Session,
    screen_session_id: Option<&str>,
    now: f64,
) -> Result<Mirror, DeviceError> {
    if screen_session_id.is_none() {
        return Ok(Mirror::None);
    }
    let Some(actor) = session.lease.current(now) else {
        return Ok(Mirror::Cleared);
    };
    let ticket = session.lease.ticket(&actor, now)?;
    Ok(Mirror::Controlled { actor, ticket })
}

/// The screen manager's `authorize`: the caller's lifetime (the shell's own
/// check) and the control this mirror was made under.
pub fn authorize(
    lease: &mut ControllerLease,
    actor: &Actor,
    ticket: u64,
    now: f64,
) -> Result<(), DeviceError> {
    lease.assert_held(actor, Some(ticket), now)
}

/// The screen manager's `released`: let go of the control if this mirror still
/// holds it. `true` means the control was released, so the caller emits a state.
pub fn released(lease: &mut ControllerLease, actor: &Actor, ticket: u64, now: f64) -> bool {
    if !lease.holds(actor, ticket, now) {
        return false;
    }
    lease.release(Some(&actor.owner));
    true
}

#[cfg(test)]
mod tests;
