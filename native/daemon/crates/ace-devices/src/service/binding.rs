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
    /// The device already belongs to this thread.
    Unchanged,
    /// Run the cleanup, then report it with [`finish_bind`].
    Cleanup { epoch: u64 },
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
pub fn begin_bind(session: &mut Session, thread_id: &str) -> Result<Bind, DeviceError> {
    if session.thread_id.as_deref() == Some(thread_id) {
        return Ok(Bind::Unchanged);
    }
    if session.changing_binding {
        return Err(words::refusal(CHANGING_THREADS_KEY));
    }
    session.changing_binding = true;
    session.binding_epoch = session.binding_epoch.saturating_add(1);
    let epoch = session.binding_epoch;
    session.thread_id = None;
    session.log_owners.clear();
    session.lease.release(None);
    Ok(Bind::Cleanup { epoch })
}

/// `bindDevice`'s second half: the cleanup ran (the caller's `guard` already
/// checked the caller's lifetime), so bind the device unless devices were turned
/// off or a newer bind passed this one.
pub fn finish_bind(
    session: &mut Session,
    thread_id: &str,
    epoch: u64,
    cleanup_failed: bool,
    enabled: bool,
) -> Result<Bound, DeviceError> {
    session.changing_binding = false;
    session.completed = None;
    session.recording_artifact = None;
    if cleanup_failed {
        return Ok(Bound::CleanupFailed);
    }
    if !enabled || session.binding_epoch != epoch {
        return Err(words::refusal(TURNED_OFF_KEY));
    }
    session.thread_id = Some(thread_id.to_owned());
    Ok(Bound::Bound)
}

/// `disableDeviceSessions`: turning devices off frees every device from its
/// thread before its resources are stopped.
pub fn begin_disable(session: &mut Session) {
    session.binding_epoch = session.binding_epoch.saturating_add(1);
    session.thread_id = None;
}

/// The stop ran: the published recording it may have left is cleared.
pub fn finish_disable(session: &mut Session) {
    session.completed = None;
    session.recording_artifact = None;
}

#[cfg(test)]
mod tests;
