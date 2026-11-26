// SPDX-License-Identifier: Apache-2.0
//! `scrcpy-early.ts`: D1's units that arrive before the daemon installs its link. Ready and
//! video travel on separate lanes, so a reader's first keyframe can come before its link; it is
//! held with the deltas after it and handed over once the link is in. Bounded: past the bound
//! everything held is dropped and the link is told to ask for a keyframe.

use crate::platform::media_paths::VideoUnit;

/// Most units held for a link not installed yet: about four seconds at 60 fps.
pub const EARLY_MAX_UNITS: usize = 240;
/// Most bytes held for it.
pub const EARLY_MAX_BYTES: usize = 16 * 1024 * 1024;

/// What was held, in order, and whether units were dropped.
#[derive(Debug, Default, PartialEq)]
pub struct Taken {
    pub units: Vec<VideoUnit>,
    pub lost: bool,
}

#[derive(Debug, Default)]
pub struct EarlyUnits {
    units: Vec<VideoUnit>,
    bytes: usize,
    lost: bool,
    closed: bool,
}

impl EarlyUnits {
    pub fn hold(&mut self, unit: VideoUnit) {
        // A reader that ended or failed admits nothing more: a unit already on the egress lane
        // must not refill the queue before teardown finishes.
        if self.closed {
            return;
        }
        if unit.keyframe {
            self.clear();
        } else if self.units.is_empty() {
            // A delta with no keyframe held decodes to nothing.
            self.lost = true;
            return;
        }
        if self.units.len() >= EARLY_MAX_UNITS || self.bytes + unit.payload.len() > EARLY_MAX_BYTES
        {
            self.clear();
            self.lost = true;
            return;
        }
        self.bytes += unit.payload.len();
        self.units.push(unit);
    }

    /// What is held, in order, and whether units were dropped. Nothing is held afterwards.
    pub fn take(&mut self) -> Taken {
        let taken = Taken {
            units: std::mem::take(&mut self.units),
            lost: self.lost,
        };
        self.bytes = 0;
        self.lost = false;
        taken
    }

    /// A new reader, or none: what an earlier one sent is never shown.
    pub fn clear(&mut self) {
        self.units.clear();
        self.bytes = 0;
        self.lost = false;
        self.closed = false;
    }

    /// This reader ended or its handshake failed: held units go and in-flight ones are dropped
    /// until a new dial clears it.
    pub fn close(&mut self) {
        self.clear();
        self.closed = true;
    }

    pub fn len(&self) -> usize {
        self.units.len()
    }

    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(keyframe: bool, bytes: usize) -> VideoUnit {
        VideoUnit {
            payload: vec![0; bytes],
            keyframe,
            video_codec: "avc1.640033".to_string(),
            width: 4,
            height: 4,
            pts: 0,
            encode: None,
        }
    }

    #[test]
    fn a_delta_before_any_keyframe_is_dropped_and_the_link_asks_for_one() {
        let mut early = EarlyUnits::default();
        early.hold(unit(false, 4));
        assert!(early.is_empty());
        let taken = early.take();
        assert!(taken.units.is_empty());
        assert!(taken.lost);
        assert!(!early.take().lost, "taking them clears the loss");
    }

    #[test]
    fn a_keyframe_and_its_deltas_are_held_in_order_until_the_link_takes_them() {
        let mut early = EarlyUnits::default();
        early.hold(unit(true, 3));
        early.hold(unit(false, 4));
        early.hold(unit(false, 5));
        let taken = early.take();
        assert_eq!(taken.units.len(), 3);
        assert!(taken.units[0].keyframe);
        assert!(early.is_empty());
    }

    #[test]
    fn a_new_keyframe_replaces_the_held_units() {
        let mut early = EarlyUnits::default();
        early.hold(unit(true, 3));
        early.hold(unit(true, 3));
        assert_eq!(early.len(), 1);
    }

    #[test]
    fn the_queue_is_bounded_and_drops_everything_past_the_bound() {
        let mut early = EarlyUnits::default();
        early.hold(unit(true, 1));
        for _ in 0..EARLY_MAX_UNITS {
            early.hold(unit(false, 1));
        }
        let taken = early.take();
        assert!(
            taken.units.is_empty(),
            "past the unit bound everything goes"
        );
        assert!(taken.lost);
        let mut big = EarlyUnits::default();
        big.hold(unit(true, EARLY_MAX_BYTES));
        big.hold(unit(false, 1));
        assert!(big.take().lost, "past the byte bound everything goes");
    }

    #[test]
    fn a_closed_queue_refuses_units_until_a_new_dial_clears_it() {
        let mut early = EarlyUnits::default();
        early.hold(unit(true, 3));
        early.close();
        assert!(early.is_empty());
        early.hold(unit(true, 3));
        assert!(early.is_empty(), "closed admits nothing");
        early.clear();
        early.hold(unit(true, 3));
        assert_eq!(early.len(), 1);
    }
}
