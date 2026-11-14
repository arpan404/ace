// SPDX-License-Identifier: Apache-2.0
//! The lowest level a stream fits: H.264 Table A-1 and H.265 Table A.8 (Main tier).

/// `(level_idc, MaxMBPS, MaxFS, MaxBR in 1000 bit/s)`.
const H264: [(u8, u64, u64, u64); 19] = [
    (10, 1_485, 99, 64),
    (11, 3_000, 396, 192),
    (12, 6_000, 396, 384),
    (13, 11_880, 396, 768),
    (20, 11_880, 396, 2_000),
    (21, 19_800, 792, 4_000),
    (22, 20_250, 1_620, 4_000),
    (30, 40_500, 1_620, 10_000),
    (31, 108_000, 3_600, 14_000),
    (32, 216_000, 5_120, 20_000),
    (40, 245_760, 8_192, 20_000),
    (41, 245_760, 8_192, 50_000),
    (42, 522_240, 8_704, 50_000),
    (50, 589_824, 22_080, 135_000),
    (51, 983_040, 36_864, 240_000),
    (52, 2_073_600, 36_864, 240_000),
    (60, 4_177_920, 139_264, 240_000),
    (61, 8_355_840, 139_264, 480_000),
    (62, 16_711_680, 139_264, 800_000),
];

/// `level_idc` for an H.264 stream, or `None` past level 6.2. `high` applies the High
/// profile's 1.25 bit-rate factor (Table A-2).
pub fn h264_level(
    width: u32,
    height: u32,
    fps: u32,
    bits_per_second: u32,
    high: bool,
) -> Option<u8> {
    let w = u64::from(width.div_ceil(16));
    let h = u64::from(height.div_ceil(16));
    let frame = w * h;
    let rate = frame * u64::from(fps);
    let factor = if high { 1250 } else { 1000 };
    H264.iter()
        .find(|(_, mbps, fs, br)| {
            // A.3.1 (f): each side at most sqrt(8 × MaxFS) macroblocks.
            frame <= *fs
                && rate <= *mbps
                && w * w <= 8 * fs
                && h * h <= 8 * fs
                && u64::from(bits_per_second) <= br * factor
        })
        .map(|(level, ..)| *level)
}

/// `(level × 30, MaxLumaPs, MaxLumaSr, MaxBR in 1000 bit/s)`, Main tier.
const HEVC: [(u8, u64, u64, u64); 13] = [
    (30, 36_864, 552_960, 128),
    (60, 122_880, 3_686_400, 1_500),
    (63, 245_760, 7_372_800, 3_000),
    (90, 552_960, 16_588_800, 6_000),
    (93, 983_040, 33_177_600, 10_000),
    (120, 2_228_224, 66_846_720, 12_000),
    (123, 2_228_224, 133_693_440, 20_000),
    (150, 8_912_896, 267_386_880, 25_000),
    (153, 8_912_896, 534_773_760, 40_000),
    (156, 8_912_896, 1_069_547_520, 60_000),
    (180, 35_651_584, 1_069_547_520, 60_000),
    (183, 35_651_584, 2_139_095_040, 120_000),
    (186, 35_651_584, 4_278_190_080, 240_000),
];

/// `general_level_idc` for an HEVC Main stream, or `None` past level 6.2.
pub fn hevc_level(width: u32, height: u32, fps: u32, bits_per_second: u32) -> Option<u8> {
    let ps = u64::from(width) * u64::from(height);
    let sr = ps * u64::from(fps);
    HEVC.iter()
        .find(|(_, max_ps, max_sr, br)| {
            // A.4.1: each side at most sqrt(8 × MaxLumaPs).
            ps <= *max_ps
                && sr <= *max_sr
                && u64::from(width).pow(2) <= 8 * max_ps
                && u64::from(height).pow(2) <= 8 * max_ps
                && u64::from(bits_per_second) <= br * 1000
        })
        .map(|(level, ..)| *level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn h264_levels_follow_table_a1() {
        assert_eq!(h264_level(1920, 1080, 30, 8_000_000, true), Some(40));
        assert_eq!(h264_level(1920, 1080, 60, 8_000_000, true), Some(42));
        assert_eq!(h264_level(1280, 720, 30, 4_000_000, false), Some(31));
        // A tall phone screen: 76 × 164 macroblocks is past level 4.2's frame size.
        assert_eq!(h264_level(1206, 2622, 60, 8_000_000, true), Some(51));
        assert_eq!(h264_level(3840, 2160, 30, 16_000_000, true), Some(51));
        assert_eq!(h264_level(8192, 8192, 120, 16_000_000, true), None);
    }

    #[test]
    fn a_bit_rate_past_the_level_limit_raises_the_level() {
        assert_eq!(h264_level(1280, 720, 30, 14_000_000, false), Some(31));
        assert_eq!(h264_level(1280, 720, 30, 16_000_000, false), Some(32));
        assert_eq!(h264_level(1280, 720, 30, 16_000_000, true), Some(31));
    }

    #[test]
    fn hevc_levels_follow_table_a8() {
        assert_eq!(hevc_level(1920, 1080, 30, 8_000_000), Some(120));
        assert_eq!(hevc_level(1920, 1080, 60, 8_000_000), Some(123));
        assert_eq!(hevc_level(1206, 2622, 60, 8_000_000), Some(150));
        assert_eq!(hevc_level(3840, 2160, 30, 16_000_000), Some(150));
        assert_eq!(hevc_level(3840, 2160, 60, 16_000_000), Some(153));
    }
}
