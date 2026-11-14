// SPDX-License-Identifier: Apache-2.0
//! The parameter sets and slice headers ace's encoders write: hand-derived bits for a minimal
//! case, and read-back of every size class the encoders use.
#![allow(clippy::unwrap_used)]
use media_bitstream::{
    VideoSignal,
    avcc::AvcConfig,
    h264, hevc,
    hvcc::HevcConfig,
    nal::{self, annex_b_units},
};

const SIZES: [(u32, u32); 5] = [
    (16, 16),
    (1206, 2622),
    (1920, 1080),
    (1366, 768),
    (3840, 2160),
];

/// A NAL unit from writer bits: header and payload, aligned and escaped.
fn finish(mut w: media_bitstream::BitWriter, header_len: usize) -> Vec<u8> {
    w.trailing();
    let bytes = w.into_bytes();
    let mut out = bytes[..header_len].to_vec();
    nal::escape_into(&bytes[header_len..], &mut out);
    out
}

#[test]
fn a_minimal_baseline_sps_has_the_bits_the_syntax_table_gives() {
    // profile 66, constraint_set0/1, level 1.0; then ue(0) id, ue(4) log2_max_frame_num_minus4,
    // ue(2) POC type, ue(1) refs, gaps 0, ue(0) width, ue(0) height, frame_mbs_only 1,
    // direct_8x8 1, no crop, no VUI, stop bit: 1 00101 011 010 0 1 1 1 1 0 0 1.
    let sps = h264::Sps::progressive(h264::profile::BASELINE, 0xc0, 10, 16, 16, 1, None);
    assert_eq!(sps.to_nal(), [0x67, 0x42, 0xc0, 0x0a, 0x95, 0xa7, 0x90]);
}

#[test]
fn h264_parameter_sets_read_back_at_every_encode_size() {
    for (w, h) in SIZES {
        let vui = h264::Vui {
            signal: Some(VideoSignal::bt709_limited()),
            timing: Some(h264::Timing {
                num_units_in_tick: 1,
                time_scale: 120,
                fixed_frame_rate: false,
            }),
            restriction: Some(h264::Restriction::low_delay(1)),
            ..Default::default()
        };
        let sps = h264::Sps::progressive(h264::profile::HIGH, 0, 51, w, h, 1, Some(vui));
        let parsed = h264::Sps::parse(&sps.to_nal()).unwrap();
        assert_eq!(parsed, sps, "{w}x{h}");
        assert_eq!(parsed.frame_size(), (w, h));
        let pps = h264::Pps::simple(true, true, 26);
        assert_eq!(h264::Pps::parse(&pps.to_nal()).unwrap(), pps);
        let record = AvcConfig::from_parameter_sets(&sps.to_nal(), &pps.to_nal()).unwrap();
        assert_eq!(
            AvcConfig::parse(&record.to_bytes().unwrap()).unwrap(),
            record
        );
        assert_eq!(record.profile, 100);
        assert_eq!(record.level, 51);
    }
}

#[test]
fn h264_ippp_slice_headers_read_back() {
    let sps = h264::Sps::progressive(h264::profile::MAIN, 0x40, 40, 1920, 1080, 1, None);
    for cabac in [false, true] {
        let pps = h264::Pps::simple(cabac, false, 30);
        for (idr, frame_num, qp_delta) in [(true, 0, 0), (false, 1, -4), (false, 15, 6)] {
            let header = h264::SliceHeader::simple(idr, frame_num, 3, qp_delta);
            let bits = header.write(&sps, &pps);
            let len = bits.bit_len();
            let (parsed, parsed_len) =
                h264::SliceHeader::parse(&finish(bits, 1), &sps, &pps).unwrap();
            assert_eq!(parsed, header, "idr {idr} frame {frame_num} cabac {cabac}");
            assert_eq!(parsed_len, len);
        }
    }
}

fn hevc_sets(w: u32, h: u32) -> (hevc::Vps, hevc::Sps, hevc::Pps) {
    let ptl = hevc::ProfileTierLevel::progressive(hevc::profile::MAIN, 120);
    let vui = hevc::Vui {
        signal: Some(VideoSignal::bt709_limited()),
        ..Default::default()
    };
    let sps = hevc::Sps::progressive(
        ptl.clone(),
        w,
        h,
        16,
        6,
        1,
        vec![hevc::ShortTermRps::previous_only()],
        Some(vui),
    );
    (hevc::Vps::single_layer(ptl, 1), sps, hevc::Pps::simple(26))
}

#[test]
fn hevc_parameter_sets_read_back_at_every_encode_size() {
    for (w, h) in SIZES {
        let (vps, sps, pps) = hevc_sets(w, h);
        assert_eq!(hevc::Vps::parse(&vps.to_nal()).unwrap(), vps);
        let parsed = hevc::Sps::parse(&sps.to_nal()).unwrap();
        assert_eq!(parsed, sps, "{w}x{h}");
        assert_eq!(parsed.frame_size(), (w, h));
        assert_eq!(parsed.pic_width_in_luma_samples % 16, 0);
        assert_eq!(hevc::Pps::parse(&pps.to_nal()).unwrap(), pps);
        let record =
            HevcConfig::from_parameter_sets(&vps.to_nal(), &sps.to_nal(), &pps.to_nal()).unwrap();
        assert_eq!(
            HevcConfig::parse(&record.to_bytes().unwrap()).unwrap(),
            record
        );
        // Main profile, Main 10 compatible, progressive frame-only, level 4.
        assert_eq!(record.general[..5], [0x01, 0x60, 0, 0, 0]);
        assert_eq!(record.general[11], 120);
    }
}

#[test]
fn hevc_ippp_slice_headers_read_back() {
    let (_, sps, pps) = hevc_sets(1206, 2622);
    for (idr, poc, qp_delta) in [(true, 0, 0), (false, 1, 3), (false, 255, -2)] {
        let header = hevc::SliceSegmentHeader::simple(idr, poc, qp_delta, &sps);
        let bits = header.write(&sps, &pps);
        let len = bits.bit_len();
        let (parsed, parsed_len) =
            hevc::SliceSegmentHeader::parse(&finish(bits, 2), &sps, &pps).unwrap();
        assert_eq!(parsed, header, "idr {idr} poc {poc}");
        assert_eq!(parsed_len, len);
    }
}

#[test]
fn an_annex_b_access_unit_carries_each_parameter_set_once() {
    let (vps, sps, pps) = hevc_sets(1920, 1080);
    let mut stream = Vec::new();
    for unit in [vps.to_nal(), sps.to_nal(), pps.to_nal()] {
        stream.extend_from_slice(&[0, 0, 0, 1]);
        stream.extend_from_slice(&unit);
    }
    let types: Vec<u8> = annex_b_units(&stream)
        .filter_map(nal::hevc::unit_type)
        .collect();
    assert_eq!(types, [nal::hevc::VPS, nal::hevc::SPS, nal::hevc::PPS]);
}
