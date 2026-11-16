// SPDX-License-Identifier: Apache-2.0
//! One viewer's stream request kept within its link, matching `LinkFollow` in
//! `packages/browser/src/link-follow.ts` (ADR 0088's link-driven rate, ADR 0149's steps), for the
//! device and screen views ace-media delivers (D1). The view asks for a size, rate and bit rate;
//! the caller caps it to what the link carries now (`device_control::link_capped` at the link's
//! step), and this decides when that reaches the capture:
//!
//! - the view's own request is applied at once;
//! - after that, about once a second, the capped request is applied again only when its step
//!   changed (frame rate or size), or its bit rate moved more than 15 % from the one applied, so
//!   a steady link never restarts the encoder.
//!
//! Pure: no clock, no I/O.
use crate::device_control::StreamSettings;

/// A capped bit rate this close to the one applied isn't worth a change (or an encoder restart).
pub const CHANGE_SHARE: f64 = 0.15;

/// Whether `next` should replace `applied`: another step, or a bit rate that moved more than
/// [`CHANGE_SHARE`]. As in TypeScript, a bit rate moving from 0 always counts as moved.
pub fn reapply(applied: &StreamSettings, next: &StreamSettings) -> bool {
    let same_step = next.fps == applied.fps
        && next.max_width == applied.max_width
        && next.max_height == applied.max_height;
    let moved = if applied.bitrate == 0 {
        // 0 / 0 and n / 0 in TypeScript: NaN and Infinity, neither within the share.
        f64::INFINITY
    } else {
        (f64::from(next.bitrate) - f64::from(applied.bitrate)).abs() / f64::from(applied.bitrate)
    };
    !(moved <= CHANGE_SHARE && same_step)
}

#[derive(Debug, Default)]
pub struct LinkFollow {
    asked: Option<StreamSettings>,
    applied: Option<StreamSettings>,
    closed: bool,
}

impl LinkFollow {
    pub fn new() -> Self {
        Self::default()
    }

    /// The view's own request, as it asked: what the caller caps on each tick.
    pub fn asked(&self) -> Option<StreamSettings> {
        self.asked
    }

    /// The view asked for `asked`, which its link caps to `capped`: applied at once.
    pub fn ask(&mut self, asked: StreamSettings, capped: StreamSettings) -> StreamSettings {
        self.asked = Some(asked);
        self.applied = Some(capped);
        capped
    }

    /// The request capped to the link now: the settings to apply, when they moved enough.
    pub fn tick(&mut self, capped: StreamSettings) -> Option<StreamSettings> {
        if self.closed || self.asked.is_none() {
            return None;
        }
        let applied = self.applied?;
        if !reapply(&applied, &capped) {
            return None;
        }
        self.applied = Some(capped);
        Some(capped)
    }

    pub fn close(&mut self) {
        self.closed = true;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_control::{Codec, VIDEO_STREAM};

    fn at(bitrate: u32) -> StreamSettings {
        StreamSettings {
            bitrate,
            ..VIDEO_STREAM
        }
    }

    #[test]
    fn the_request_applies_at_once_and_a_steady_link_changes_nothing() {
        let mut follow = LinkFollow::new();
        assert_eq!(follow.ask(VIDEO_STREAM, at(4_000_000)), at(4_000_000));
        // 15 % either way is within the share: no encoder restart.
        assert_eq!(follow.tick(at(4_600_000)), None);
        assert_eq!(follow.tick(at(3_400_000)), None);
        assert_eq!(follow.tick(at(4_000_000)), None);
    }

    #[test]
    fn a_bit_rate_that_moves_past_the_share_is_applied_and_becomes_the_new_reference() {
        let mut follow = LinkFollow::new();
        follow.ask(VIDEO_STREAM, at(4_000_000));
        assert_eq!(follow.tick(at(4_750_000)), Some(at(4_750_000)));
        // Measured from what was applied last, not from the first request.
        assert_eq!(follow.tick(at(5_250_000)), None);
        assert_eq!(follow.tick(at(3_250_000)), Some(at(3_250_000)));
    }

    #[test]
    fn a_new_step_is_applied_even_at_the_same_bit_rate() {
        let mut follow = LinkFollow::new();
        follow.ask(VIDEO_STREAM, at(1_000_000));
        let fewer = StreamSettings {
            fps: 30,
            ..at(1_000_000)
        };
        assert_eq!(follow.tick(fewer), Some(fewer));
        let smaller = StreamSettings {
            max_width: 1152,
            ..fewer
        };
        assert_eq!(follow.tick(smaller), Some(smaller));
        let shorter = StreamSettings {
            max_height: 2304,
            ..smaller
        };
        assert_eq!(follow.tick(shorter), Some(shorter));
        assert_eq!(follow.tick(shorter), None);
    }

    #[test]
    fn nothing_is_applied_before_a_request_or_after_close() {
        let mut follow = LinkFollow::new();
        assert_eq!(follow.tick(at(1_000_000)), None);
        follow.ask(VIDEO_STREAM, at(4_000_000));
        follow.close();
        assert_eq!(follow.tick(at(500_000)), None);
    }

    #[test]
    fn a_bit_rate_moving_from_zero_counts_as_moved_as_in_typescript() {
        let jpeg = StreamSettings {
            codec: Codec::Jpeg,
            bitrate: 0,
            ..VIDEO_STREAM
        };
        assert!(reapply(&jpeg, &jpeg));
        assert!(reapply(&jpeg, &at(1)));
    }
}
