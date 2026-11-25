// SPDX-License-Identifier: Apache-2.0
//! A still Simulator picture, held sharp (the browser encoder's settle, ADR 0088): the
//! transcode opens its session in quantizer mode, and once the source has been still for
//! ~300 ms the last decoded picture is encoded again as a sharp keyframe at the quantizer
//! `QuantizerControl::settled` gives for the planned bitrate. Pure: time is passed in,
//! never read.
use media_core::quantizer::QuantizerControl;

/// How long the source must show no visible change before its last picture is refreshed.
pub const STILL_MS: f64 = 300.0;
/// A serve-sim delta at or above this is a visible change; below it the picture is still.
/// A still 1164x2532 delta is a few hundred bytes of headers; a scrolling one is tens of KB.
pub const STILL_DELTA_BYTES: usize = 8192;

pub struct StillControl {
    control: QuantizerControl,
    last_change_ms: f64,
    last_refresh_ms: f64,
    refreshed: bool,
    /// A keyframe has come out since the stream started: `settled()` needs its size.
    /// Without one the spell must stay armed, not be consumed.
    key_seen: bool,
}

impl StillControl {
    pub fn new(bitrate: f64, fps: f64) -> Self {
        Self {
            control: QuantizerControl::new(bitrate, fps),
            last_change_ms: f64::NEG_INFINITY,
            last_refresh_ms: f64::NEG_INFINITY,
            refreshed: true,
            key_seen: false,
        }
    }

    pub fn retarget(&mut self, bitrate: f64, fps: f64) {
        self.control.retarget(bitrate, fps);
    }

    /// The quantizer for an encode that is (or is not) a keyframe.
    pub fn next_qp(&mut self, key: bool) -> u8 {
        self.control.next(key).round().clamp(18.0, 51.0) as u8
    }

    pub fn observe(&mut self, bytes: usize, key: bool) {
        if key {
            self.key_seen = true;
        }
        self.control.observe(bytes, key);
    }

    /// One input unit seen: a keyframe or a delta big enough to see restarts the still clock
    /// and re-arms the refresh; tiny deltas leave it alone.
    pub fn note_input(&mut self, bytes: usize, key: bool, now_ms: f64) {
        if key || bytes >= STILL_DELTA_BYTES {
            self.last_change_ms = now_ms;
            self.refreshed = false;
        }
    }

    /// The sharp keyframe quantizer when the picture has been still long enough: once per
    /// still spell, never while frames are changing, never more often than the browser's
    /// settle pacing. `None` when still but no sharper quantizer is affordable.
    pub fn should_refresh(&mut self, now_ms: f64) -> Option<u8> {
        if self.refreshed {
            return None;
        }
        // No keyframe out yet (its output is still on its way): the spell stays armed.
        if !self.key_seen {
            return None;
        }
        if now_ms - self.last_change_ms < STILL_MS {
            return None;
        }
        if now_ms - self.last_refresh_ms < STILL_MS {
            return None;
        }
        self.refreshed = true;
        self.last_refresh_ms = now_ms;
        self.control
            .settled()
            .map(|q| q.round().clamp(18.0, 51.0) as u8)
    }
}

#[cfg(test)]
#[path = "sim_still_tests.rs"]
mod tests;
