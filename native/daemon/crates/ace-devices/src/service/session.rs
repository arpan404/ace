// SPDX-License-Identifier: Apache-2.0
//! One device's session (`packages/devices/src/session.ts`): everything the
//! service's rules read, created with the TypeScript's starting values.
//!
//! The shell owns what a session points at — the frame hub, logs, the capture,
//! the recording and its promises. This module owns the state those rules
//! decide about, so it stays pure and testable.

use super::input_queue::PendingInput;
use super::lease::{ActorKind, ControllerLease};
use crate::error::DeviceFailure;

/// `session.lifecycle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Idle,
    Starting,
    Live,
    Stopping,
    Failed,
}

impl Lifecycle {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Starting => "starting",
            Self::Live => "live",
            Self::Stopping => "stopping",
            Self::Failed => "failed",
        }
    }
}

/// `session.video`: why a live view can't play now, while it can't.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VideoNote {
    pub retrying: bool,
    pub reason: String,
}

impl VideoNote {
    pub fn status(&self) -> &'static str {
        if self.retrying {
            "retrying"
        } else {
            "unavailable"
        }
    }
}

/// One device's session.
#[derive(Debug)]
pub struct Session {
    pub device_id: String,
    pub thread_id: Option<String>,
    pub booting: bool,
    pub lifecycle: Lifecycle,
    pub stream_id: Option<String>,
    pub error: Option<DeviceFailure>,
    /// The last thing an agent did here, numbered by `activity_sequence`.
    pub activity_sequence: u64,
    /// A view has the capture streaming video: its own stills are no longer kept fresh.
    pub live_video: bool,
    /// Why the live video can't play now (`DeviceState.video`).
    pub video: Option<VideoNote>,
    pub lease: ControllerLease,
    pub control_revision: u64,
    /// A Take control being applied; the shared input lane respects it.
    pub pending_controller: Option<String>,
    /// Who began that takeover: a person's must never be superseded by an agent's.
    pub pending_controller_kind: Option<ActorKind>,
    pub pending: PendingInput,
    pub generation: u64,
    pub binding_epoch: u64,
    pub changing_binding: bool,
    pub recording_starting: bool,
    /// A recording that ended on its own, published, waiting for its `record.stop`.
    /// The shell holds the recording itself; this names it.
    pub completed: Option<String>,
    /// The published artifact of the recording above, likewise.
    pub recording_artifact: Option<String>,
    /// Who subscribed to this session's logs; the shell's tokens.
    pub log_owners: Vec<String>,
}

impl Session {
    /// `createSession`: the TypeScript's starting values.
    pub fn new(device_id: &str) -> Self {
        Self {
            device_id: device_id.to_owned(),
            thread_id: None,
            booting: false,
            lifecycle: Lifecycle::Idle,
            stream_id: None,
            error: None,
            activity_sequence: 0,
            live_video: false,
            video: None,
            lease: ControllerLease::new(),
            control_revision: 0,
            pending_controller: None,
            pending_controller_kind: None,
            pending: PendingInput::new(),
            generation: 0,
            binding_epoch: 0,
            changing_binding: false,
            recording_starting: false,
            completed: None,
            recording_artifact: None,
            log_owners: Vec::new(),
        }
    }

    /// `session.pending` in the TypeScript: every queued input, both lanes.
    pub fn pending(&self) -> usize {
        self.pending.total()
    }
}

#[cfg(test)]
mod tests;
