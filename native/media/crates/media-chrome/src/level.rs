// SPDX-License-Identifier: Apache-2.0
//! The WebCodecs codec string for an encode: H.264 Constrained Baseline (the profile Chrome's
//! software encoder writes) at the lowest level whose limits hold the picture and frame rate.

use media_codec::Size;

/// `(level_idc, MaxMBPS, MaxFS)` from H.264 Table A-1, lowest first.
const LEVELS: [(u8, u64, u64); 12] = [
    (30, 40_500, 1_620),
    (31, 108_000, 3_600),
    (32, 216_000, 5_120),
    (40, 245_760, 8_192),
    (41, 245_760, 8_192),
    (42, 522_240, 8_704),
    (50, 589_824, 22_080),
    (51, 983_040, 36_864),
    (52, 2_073_600, 36_864),
    (60, 4_177_920, 139_264),
    (61, 8_355_840, 139_264),
    (62, 16_711_680, 139_264),
];

/// `avc1.42E0xx` for `size` at `fps`, where `xx` is the level in hex.
pub fn h264_codec_string(size: Size, fps: u32) -> String {
    let macroblocks = u64::from(size.width.div_ceil(16)) * u64::from(size.height.div_ceil(16));
    let rate = macroblocks * u64::from(fps);
    let level = LEVELS
        .iter()
        .find(|(_, max_rate, max_frame)| macroblocks <= *max_frame && rate <= *max_rate)
        // Beyond 6.2 the standard has no level; the encoder decides whether it can.
        .map_or(62, |(level, _, _)| *level);
    format!("avc1.42E0{level:02X}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn size(width: u32, height: u32) -> Size {
        Size { width, height }
    }

    #[test]
    fn picks_the_lowest_level_that_holds_size_and_rate() {
        for (width, height, fps, expected) in [
            (640, 360, 30, "avc1.42E01E"),
            (1280, 720, 30, "avc1.42E01F"),
            (1280, 800, 60, "avc1.42E028"),
            (1920, 1080, 30, "avc1.42E028"),
            (1920, 1080, 60, "avc1.42E02A"),
            (3840, 2160, 30, "avc1.42E033"),
            (3840, 2160, 60, "avc1.42E034"),
            (8192, 8192, 120, "avc1.42E03E"),
        ] {
            assert_eq!(
                h264_codec_string(size(width, height), fps),
                expected,
                "{width}x{height}@{fps}"
            );
        }
    }
}
