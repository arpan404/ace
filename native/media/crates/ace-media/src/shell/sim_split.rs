// SPDX-License-Identifier: Apache-2.0
//! Which session encodes each unit of a Simulator transcode (ADR 0088 settle, two-session
//! design): motion units always go to the motion (bitrate) session; the still refresh goes
//! to a separate quantizer session opened lazily per (size, QP). Pure: time is passed in,
//! never read.
use super::sim_still::StillControl;

/// The session a unit is encoded by.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Session {
    /// The motion session, in plain bitrate mode at the planned bitrate.
    Motion,
    /// The still session, in quantizer mode at the refresh quantizer.
    Refresh,
}

pub struct Split {
    still: StillControl,
    /// The motion session's next encode is forced to a key (new stream, viewer ask, or the
    /// re-key after a refresh IDR went out).
    motion_force: bool,
    /// A refresh IDR went out: drop motion deltas until the motion session's own IDR, so
    /// the two sessions' deltas never interleave and the decoder always re-keys cleanly.
    hold_motion: bool,
}

impl Split {
    pub fn new(bitrate: f64, fps: f64) -> Self {
        let mut still = StillControl::new(bitrate, fps);
        // Seed the quantizer anchor: the motion session opens at a keyframe, and `settled`
        // prices the refresh IDR from that keyframe's measured size.
        let _ = still.next_qp(true);
        Self {
            still,
            motion_force: true,
            hold_motion: false,
        }
    }

    pub fn retarget(&mut self, bitrate: f64, fps: f64) {
        self.still.retarget(bitrate, fps);
    }

    /// A keyframe was asked for (viewer request): the motion session's next encode is one.
    pub fn request_key(&mut self) {
        self.motion_force = true;
    }

    /// One input unit in: motion always encodes it (never the refresh session). Returns the
    /// session and whether this encode is forced to a key; a skipped (backpressured) unit
    /// keeps the force flag via `motion_reached` below.
    pub fn input(&mut self, bytes: usize, key: bool, now_ms: f64) -> (Session, bool) {
        self.still.note_input(bytes, key, now_ms);
        (Session::Motion, self.motion_force)
    }

    /// The motion session took the unit: a forced key is no longer owed to it.
    pub fn motion_reached(&mut self) {
        self.motion_force = false;
    }

    /// Idle tick: is the still refresh due? Names the refresh session and its quantizer.
    pub fn tick(&mut self, now_ms: f64) -> Option<(Session, u8)> {
        self.still
            .should_refresh(now_ms)
            .map(|qp| (Session::Refresh, qp))
    }

    /// The refresh IDR was published: motion must re-key before any of its deltas go out.
    pub fn did_refresh(&mut self) {
        self.hold_motion = true;
        self.motion_force = true;
    }

    /// A motion output unit: publish it, or drop it while waiting for the post-refresh IDR?
    /// Returns false while holding for the motion session's own keyframe.
    pub fn motion_out(&mut self, key: bool) -> bool {
        if self.hold_motion && !key {
            return false;
        }
        if key {
            self.hold_motion = false;
        }
        true
    }

    pub fn observe(&mut self, bytes: usize, key: bool) {
        self.still.observe(bytes, key);
    }
}

#[cfg(test)]
#[path = "sim_split_tests.rs"]
mod tests;
