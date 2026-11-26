// SPDX-License-Identifier: Apache-2.0
//! `simulator-rotation.ts`: the turn a viewer applies to serve-sim's picture, and the
//! orientation that matches it. serve-sim's pictures and touch coordinates stay in the
//! simulator's portrait framebuffer when the device turns; only the orientation it announces
//! changes. Checked on an iOS 18.5 iPhone 16 with serve-sim 0.1.47: `landscape_left` reads
//! upright after 90 degrees clockwise, `landscape_right` after 270. Unknown names keep the
//! picture as it is.

/// The orientation shown upright, given an orientation serve-sim may announce.
pub const PORTRAIT: &str = "portrait";

/// Degrees clockwise a viewer turns a picture to show it upright: 0, 90, 180 or 270.
pub fn simulator_rotation(orientation: &str) -> u16 {
    match orientation {
        "landscape_left" => 90,
        "portrait_upside_down" => 180,
        "landscape_right" => 270,
        _ => 0,
    }
}

/// The orientation to turn a Simulator to so it matches what serve-sim announced: an unknown
/// name is shown upright, so the device is turned upright too.
pub fn known_orientation(orientation: &str) -> &str {
    if simulator_rotation(orientation) == 0 {
        PORTRAIT
    } else {
        orientation
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_announced_orientation_maps_to_the_turn_that_reads_upright() {
        for (announced, turn) in [
            ("portrait", 0),
            ("landscape_left", 90),
            ("portrait_upside_down", 180),
            ("landscape_right", 270),
            ("face_up", 0),
        ] {
            assert_eq!(simulator_rotation(announced), turn);
        }
    }

    #[test]
    fn an_unknown_orientation_is_shown_and_turned_upright() {
        assert_eq!(known_orientation("face_up"), PORTRAIT);
        assert_eq!(known_orientation("portrait"), PORTRAIT);
        assert_eq!(known_orientation("landscape_left"), "landscape_left");
    }
}
