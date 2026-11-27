// SPDX-License-Identifier: Apache-2.0
//! Moving a device between threads (`packages/devices/src/binding.ts`).
//!
//! A device belongs to the thread whose agent or person took it last. Moving it
//! to another thread starts fresh logs and recordings, so nothing from the old
//! thread reaches the new one; the live view keeps running, whoever was in
//! control lets go, and the caller hands control on.
//!
//! Sans-IO: the cleanup (the capture's held input, the recording, the log
//! stream) is the shell's, so `begin_bind` decides and clears what it can, and
//! `finish_bind` decides on the outcome.

use super::session::Session;
use super::words;
use crate::error::DeviceError;

/// `busy` while another bind runs (`binding.ts:25`).
pub const CHANGING_THREADS_KEY: &str = "bindingBusy";
/// `busy` when devices were turned off during the cleanup (`binding.ts:50`).
pub const TURNED_OFF_KEY: &str = "bindingDisabled";

/// The cleanup's own failure (`binding.ts:45`), an `AggregateError` the failure
/// mapper reports as `command_failed`.
pub const BINDING_CLEANUP_FAILED: &str = "Device binding cleanup failed";
/// One device's disable failure (`binding.ts:74`).
pub const DISABLE_CLEANUP_FAILED: &str = "Device disable cleanup failed";
/// Every device's disable failure (`binding.ts:78`).
pub const DISABLE_ALL_CLEANUP_FAILED: &str = "Devices disable cleanup failed";

/// What starting a bind decided.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Bind {
    /// The device already belongs to this thread, as of this binding epoch.
    Unchanged { epoch: u64, control_revision: u64 },
    /// Run the cleanup, then report it with [`finish_bind`].
    Cleanup { epoch: u64, control_revision: u64 },
}

impl Bind {
    pub fn control_revision(&self) -> u64 {
        match self {
            Self::Unchanged {
                control_revision, ..
            } => *control_revision,
            Self::Cleanup {
                control_revision, ..
            } => *control_revision,
        }
    }

    /// The binding epoch this bind was created under.
    pub fn epoch(&self) -> u64 {
        match self {
            Self::Unchanged { epoch, .. } | Self::Cleanup { epoch, .. } => *epoch,
        }
    }

    /// The epoch of the cleanup this bind started, if it ran one.
    pub fn cleanup_epoch(&self) -> Option<u64> {
        match self {
            Self::Cleanup { epoch, .. } => Some(*epoch),
            Self::Unchanged { .. } => None,
        }
    }
}

/// A person's takeover supersedes an agent's bind that is still cleaning up.
pub fn supersede_inflight_bind(session: &mut Session) {
    if !session.changing_binding {
        return;
    }
    session.binding_epoch = session.binding_epoch.saturating_add(1);
    session.changing_binding = false;
    session.binding_owner = None;
    session.thread_id = None;
    session.log_owners.clear();
    session.lease.release(None);
}

/// What finishing a bind decided.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    Bound,
    /// The cleanup failed: the device stays unbound and the caller reports
    /// [`BINDING_CLEANUP_FAILED`].
    CleanupFailed,
}

/// `bindDevice`'s first half: refuse a second bind, then free the device from
/// its thread and let go of control before anything is awaited.
pub fn begin_bind(
    session: &mut Session,
    thread_id: &str,
    owner: &str,
) -> Result<Bind, DeviceError> {
    let control_revision = session.control_revision;
    if session.thread_id.as_deref() == Some(thread_id) {
        return Ok(Bind::Unchanged {
            epoch: session.binding_epoch,
            control_revision,
        });
    }
    if session.changing_binding {
        return Err(words::refusal(CHANGING_THREADS_KEY));
    }
    session.changing_binding = true;
    session.binding_owner = Some(owner.to_owned());
    session.binding_epoch = session.binding_epoch.saturating_add(1);
    let epoch = session.binding_epoch;
    session.thread_id = None;
    session.log_owners.clear();
    session.lease.release(None);
    Ok(Bind::Cleanup {
        epoch,
        control_revision,
    })
}

/// `controller` with a thread after control is reserved: supersede an agent bind,
/// then move the device like [`begin_bind`].
pub fn begin_bind_for_person(
    session: &mut Session,
    thread_id: &str,
    owner: &str,
) -> Result<Bind, DeviceError> {
    let control_revision = session.control_revision;
    if session.thread_id.as_deref() == Some(thread_id) {
        supersede_inflight_bind(session);
        return Ok(Bind::Unchanged {
            epoch: session.binding_epoch,
            control_revision,
        });
    }
    supersede_inflight_bind(session);
    begin_bind(session, thread_id, owner)
}

/// The cleanup threw. Its failure is the caller's error whatever else happened to
/// the device: `binding.ts` throws the AggregateError before it checks the epoch
/// or the disable, so a hand-back, a disable and a fresh takeover that landed
/// during the cleanup cannot hide it. Only the bind that still owns the epoch
/// clears the reservation and the publication its cleanup never got to clear.
pub fn fail_bind(session: &mut Session, epoch: u64) -> Bound {
    if session.binding_epoch == epoch {
        session.changing_binding = false;
        session.binding_owner = None;
        session.completed = None;
        session.recording_artifact = None;
    }
    Bound::CleanupFailed
}

/// `bindDevice`'s second half: the cleanup ran (the caller's `guard` already
/// checked the caller's lifetime), so bind the device unless devices were turned
/// off or a newer bind passed this one.
///
/// Only the bind that still owns the current epoch may touch the session: a
/// superseded bind's late completion leaves the newer bind's reservation and
/// recording alone.
pub fn finish_bind(
    session: &mut Session,
    thread_id: &str,
    epoch: u64,
    cleanup_failed: bool,
    enabled: bool,
) -> Result<Bound, DeviceError> {
    if cleanup_failed {
        // The cleanup's own failure outranks the newer epoch, as `binding.ts`
        // throws it before its disabled check.
        return Ok(fail_bind(session, epoch));
    }
    if session.binding_epoch != epoch {
        return Err(words::refusal(TURNED_OFF_KEY));
    }
    session.changing_binding = false;
    session.binding_owner = None;
    session.completed = None;
    session.recording_artifact = None;
    if !enabled {
        return Err(words::refusal(TURNED_OFF_KEY));
    }
    session.thread_id = Some(thread_id.to_owned());
    Ok(Bound::Bound)
}

/// `disableDeviceSessions`: turning devices off frees every device from its
/// thread before its resources are stopped, and retires any bind still in flight
/// so a later bind does not find a reservation nobody will finish. Returns the
/// epoch the disable moved to, which its completion carries back.
pub fn begin_disable(session: &mut Session) -> u64 {
    session.binding_epoch = session.binding_epoch.saturating_add(1);
    session.thread_id = None;
    session.changing_binding = false;
    session.binding_owner = None;
    super::control::invalidate_pending_control(session);
    session.binding_epoch
}

/// The stop ran: the published recording it may have left is cleared, unless a
/// later bind or disable passed this one while it was out. A recording published
/// after re-enable belongs to that newer epoch and stays.
pub fn finish_disable(session: &mut Session, epoch: u64) {
    if session.binding_epoch != epoch {
        return;
    }
    session.completed = None;
    session.recording_artifact = None;
}

#[cfg(test)]
mod tests;
