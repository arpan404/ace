// SPDX-License-Identifier: Apache-2.0
//! Which VA profile, entrypoint, rate control and packed headers a session asks for, from
//! what the driver lists (`vaQueryConfigProfiles`, `vaQueryConfigEntrypoints`,
//! `vaGetConfigAttributes`).
use media_codec::{Codec, RateControl};

/// `VAProfile` values (`va.h`).
pub mod profile {
    pub const JPEG_BASELINE: i32 = 12;
    pub const H264_MAIN: i32 = 6;
    pub const H264_HIGH: i32 = 7;
    pub const H264_CONSTRAINED_BASELINE: i32 = 13;
    pub const HEVC_MAIN: i32 = 17;
    pub const NONE: i32 = -1;
}

/// `VAEntrypoint` values (`va.h`).
pub mod entrypoint {
    pub const VLD: i32 = 1;
    pub const ENC_SLICE: i32 = 6;
    pub const ENC_PICTURE: i32 = 7;
    pub const ENC_SLICE_LP: i32 = 8;
    pub const VIDEO_PROC: i32 = 10;
}

/// `VA_RC_*` rate-control bits.
pub mod rc {
    pub const CBR: u32 = 0x2;
    pub const VBR: u32 = 0x4;
    pub const CQP: u32 = 0x10;
}

/// `VA_ENC_PACKED_HEADER_*` bits.
pub mod packed {
    pub const SEQUENCE: u32 = 0x1;
    pub const PICTURE: u32 = 0x2;
    pub const SLICE: u32 = 0x4;
    pub const MISC: u32 = 0x8;
    pub const RAW_DATA: u32 = 0x10;
}

/// `VA_ATTRIB_NOT_SUPPORTED`.
pub const ATTRIB_NOT_SUPPORTED: u32 = 0x8000_0000;

/// One profile and entrypoint to try, in order of preference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub profile: i32,
    pub entrypoint: i32,
}

/// The H.264 profile ace's sessions prefer, best first.
const H264_PROFILES: [i32; 3] = [
    profile::H264_HIGH,
    profile::H264_MAIN,
    profile::H264_CONSTRAINED_BASELINE,
];

/// Encode candidates for `codec`, given the driver's `(profile, entrypoints)` list. The
/// low-power entrypoint (Intel's VDEnc, AMD's only one) comes first; the full one is the
/// fallback when creating the low-power config fails.
pub fn encode_candidates(codec: Codec, listed: &[(i32, Vec<i32>)]) -> Vec<Candidate> {
    let profiles: &[i32] = match codec {
        Codec::H264 => &H264_PROFILES,
        Codec::Hevc => &[profile::HEVC_MAIN],
        Codec::Vp8 | Codec::Vp9 => &[],
    };
    let mut out = Vec::new();
    for &p in profiles {
        let Some((_, entrypoints)) = listed.iter().find(|(lp, _)| *lp == p) else {
            continue;
        };
        for e in [entrypoint::ENC_SLICE_LP, entrypoint::ENC_SLICE] {
            if entrypoints.contains(&e) {
                out.push(Candidate {
                    profile: p,
                    entrypoint: e,
                });
            }
        }
    }
    out
}

/// Whether `(profile, entrypoint)` is listed.
pub fn lists(listed: &[(i32, Vec<i32>)], profile: i32, entrypoint: i32) -> bool {
    listed
        .iter()
        .any(|(p, e)| *p == profile && e.contains(&entrypoint))
}

/// The `VA_RC_*` mode for the requested rate control: CBR for a bit rate (VBR where CBR is
/// missing), CQP for ace's quantizer control. `None` when the driver offers neither.
pub fn rate_control(requested: RateControl, supported: u32) -> Option<u32> {
    if supported == ATTRIB_NOT_SUPPORTED {
        return None;
    }
    match requested {
        RateControl::Bitrate(_) => [rc::CBR, rc::VBR].into_iter().find(|m| supported & m != 0),
        RateControl::Quantizer(_) => (supported & rc::CQP != 0).then_some(rc::CQP),
    }
}

/// The packed headers to supply: sequence and picture headers (SPS/PPS, and the VPS with
/// the sequence) when the driver accepts them. Slice headers stay with the driver.
pub fn packed_headers(supported: u32) -> u32 {
    if supported == ATTRIB_NOT_SUPPORTED {
        return 0;
    }
    supported & (packed::SEQUENCE | packed::PICTURE)
}

/// H.264 `profile_idc` and constraint flags for a VA profile.
pub fn h264_profile_idc(va_profile: i32) -> (u8, u8) {
    match va_profile {
        profile::H264_HIGH => (100, 0),
        profile::H264_MAIN => (77, 0x40),
        _ => (66, 0xc0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed() -> Vec<(i32, Vec<i32>)> {
        vec![
            (
                profile::H264_MAIN,
                vec![entrypoint::VLD, entrypoint::ENC_SLICE],
            ),
            (
                profile::H264_HIGH,
                vec![
                    entrypoint::VLD,
                    entrypoint::ENC_SLICE,
                    entrypoint::ENC_SLICE_LP,
                ],
            ),
            (profile::HEVC_MAIN, vec![entrypoint::VLD]),
            (
                profile::JPEG_BASELINE,
                vec![entrypoint::VLD, entrypoint::ENC_PICTURE],
            ),
        ]
    }

    #[test]
    fn high_profile_low_power_comes_first() {
        let c = encode_candidates(Codec::H264, &listed());
        assert_eq!(
            c,
            [
                Candidate {
                    profile: profile::H264_HIGH,
                    entrypoint: entrypoint::ENC_SLICE_LP
                },
                Candidate {
                    profile: profile::H264_HIGH,
                    entrypoint: entrypoint::ENC_SLICE
                },
                Candidate {
                    profile: profile::H264_MAIN,
                    entrypoint: entrypoint::ENC_SLICE
                },
            ]
        );
    }

    #[test]
    fn a_decode_only_profile_gives_no_encoder() {
        assert!(encode_candidates(Codec::Hevc, &listed()).is_empty());
        assert!(encode_candidates(Codec::Vp9, &listed()).is_empty());
        assert!(lists(
            &listed(),
            profile::JPEG_BASELINE,
            entrypoint::ENC_PICTURE
        ));
    }

    #[test]
    fn rate_control_prefers_cbr_and_needs_cqp_for_quantizers() {
        let all = rc::CBR | rc::VBR | rc::CQP;
        assert_eq!(rate_control(RateControl::Bitrate(1), all), Some(rc::CBR));
        assert_eq!(
            rate_control(RateControl::Bitrate(1), rc::VBR),
            Some(rc::VBR)
        );
        assert_eq!(rate_control(RateControl::Quantizer(30), all), Some(rc::CQP));
        assert_eq!(rate_control(RateControl::Quantizer(30), rc::CBR), None);
        assert_eq!(
            rate_control(RateControl::Bitrate(1), ATTRIB_NOT_SUPPORTED),
            None
        );
    }

    #[test]
    fn only_sequence_and_picture_headers_are_packed() {
        let all = packed::SEQUENCE | packed::PICTURE | packed::SLICE | packed::MISC;
        assert_eq!(packed_headers(all), packed::SEQUENCE | packed::PICTURE);
        assert_eq!(packed_headers(ATTRIB_NOT_SUPPORTED), 0);
        assert_eq!(packed_headers(packed::RAW_DATA), 0);
    }
}
