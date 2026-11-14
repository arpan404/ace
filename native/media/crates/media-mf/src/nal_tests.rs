// SPDX-License-Identifier: Apache-2.0
//! Vectors: one-frame 64×64 streams from a hardware encoder, and the `avcC`/`hvcC` records
//! an MP4 muxer wrote for the same streams.
use super::*;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap_or(0))
        .collect()
}

const H264_SPS: &str = "2764000bac562c30de041845";
const H264_PPS: &str = "28ee3cb0";
const H264_AVCC: &str = "0164000bffe1000c2764000bac562c30de04184501000428ee3cb0fdf8f800";
const HEVC_VPS: &str = "40010c01ffff016000000300b0000003000003001e0bc090";
const HEVC_SPS: &str =
    "420101016000000300b0000003000003001ea0142041c18f880bee45914bff2e7f13fac05a8101010040";
const HEVC_PPS: &str = "4401c072f05324";
const HEVC_HVCC: &str = "010160000000b000000000001ef000fcfdf8f800000f03a00001001840010c01ffff016000000300b0000003000003001e0bc090a10001002a420101016000000300b0000003000003001ea0142041c18f880bee45914bff2e7f13fac05a8101010040a2000100074401c072f05324";

fn annexb(units: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for (i, unit) in units.iter().enumerate() {
        // Mixed 4- and 3-byte start codes, as encoders write them.
        if i % 2 == 0 {
            out.push(0);
        }
        out.extend_from_slice(&[0, 0, 1]);
        out.extend_from_slice(unit);
    }
    out
}

#[test]
fn an_h264_keyframe_becomes_a_length_prefixed_sample_with_the_muxers_avcc_record() {
    let idr = vec![0x65, 0x88, 0x84, 0x21, 0x7f];
    let stream = annexb(&[
        vec![0x09, 0xf0],
        hex(H264_SPS),
        hex(H264_PPS),
        vec![0x06, 0x05, 0x01, 0x80],
        idr.clone(),
    ]);
    let mut sets = ParameterSets::default();
    let mut out = Vec::new();
    let sample = annexb_to_sample(Codec::H264, &stream, &mut sets, &mut out);
    assert_eq!(
        sample,
        Sample {
            key: true,
            sets_changed: true
        }
    );
    assert_eq!(sets.record(Codec::H264), Some(hex(H264_AVCC)));
    assert_eq!(sets.sps, hex(H264_SPS));
    // Delimiter and parameter sets are gone; SEI and the slice stay, each length-prefixed.
    let mut expected = vec![0, 0, 0, 4, 0x06, 0x05, 0x01, 0x80, 0, 0, 0, 5];
    expected.extend_from_slice(&idr);
    assert_eq!(out, expected);
    assert_eq!(
        codec_string(Codec::H264, &hex(H264_AVCC)).as_deref(),
        Some("avc1.64000B")
    );
}

#[test]
fn a_delta_frame_is_not_key_and_unchanged_sets_are_not_reported_again() {
    let mut sets = ParameterSets::default();
    let mut out = Vec::new();
    let header = annexb(&[hex(H264_SPS), hex(H264_PPS)]);
    assert!(sets.absorb(Codec::H264, &header));
    let delta = annexb(&[vec![0x41, 0x9a, 0x02]]);
    let sample = annexb_to_sample(Codec::H264, &delta, &mut sets, &mut out);
    assert_eq!(
        sample,
        Sample {
            key: false,
            sets_changed: false
        }
    );
    assert_eq!(out, vec![0, 0, 0, 3, 0x41, 0x9a, 0x02]);
    assert!(!sets.absorb(Codec::H264, &header));
}

#[test]
fn an_hevc_keyframe_yields_the_muxers_hvcc_record_and_codec_string() {
    let stream = annexb(&[
        hex(HEVC_VPS),
        hex(HEVC_SPS),
        hex(HEVC_PPS),
        vec![0x26, 0x01, 0xaf, 0x32],
    ]);
    let mut sets = ParameterSets::default();
    let mut out = Vec::new();
    let sample = annexb_to_sample(Codec::Hevc, &stream, &mut sets, &mut out);
    assert!(sample.key);
    let record = sets.record(Codec::Hevc);
    assert_eq!(record, Some(hex(HEVC_HVCC)));
    assert_eq!(
        codec_string(Codec::Hevc, &hex(HEVC_HVCC)).as_deref(),
        Some("hvc1.1.6.L30.B0")
    );
    assert_eq!(out, vec![0, 0, 0, 4, 0x26, 0x01, 0xaf, 0x32]);
}

#[test]
fn records_without_every_parameter_set_are_not_written() {
    let mut sets = ParameterSets::default();
    sets.absorb(Codec::Hevc, &annexb(&[hex(HEVC_SPS), hex(HEVC_PPS)]));
    assert_eq!(sets.record(Codec::Hevc), None);
    let mut sps_only = ParameterSets::default();
    sps_only.absorb(Codec::H264, &annexb(&[hex(H264_SPS)]));
    assert_eq!(sps_only.record(Codec::H264), None);
}

#[test]
fn a_sample_and_its_record_become_annexb_with_the_sets_first() {
    for (codec, record) in [(Codec::H264, H264_AVCC), (Codec::Hevc, HEVC_HVCC)] {
        let sets = sets_from_record(codec, &hex(record));
        let Some(sets) = sets else {
            panic!("record did not parse for {codec:?}");
        };
        let mut out = Vec::new();
        let sample = [0, 0, 0, 2, 0x26, 0x01, 0, 0, 0, 1, 0x02];
        assert_eq!(sample_to_annexb(&sample, Some(&sets), &mut out), Some(()));
        let units: Vec<&[u8]> = annexb_units(&out).collect();
        let mut expected: Vec<&[u8]> = Vec::new();
        if codec == Codec::Hevc {
            expected.push(&sets.vps);
        }
        expected.extend([
            sets.sps.as_slice(),
            sets.pps.as_slice(),
            &[0x26, 0x01],
            &[0x02],
        ]);
        assert_eq!(units, expected);
        // Re-encoding the parsed sets reproduces the record.
        assert_eq!(sets.record(codec), Some(hex(record)));
    }
}

#[test]
fn malformed_lengths_and_records_are_refused() {
    let mut out = Vec::new();
    assert_eq!(sample_to_annexb(&[0, 0, 0, 9, 1, 2], None, &mut out), None);
    assert_eq!(sample_to_annexb(&[0, 0, 0, 0], None, &mut out), None);
    assert_eq!(sample_to_annexb(&[0, 0, 1], None, &mut out), None);
    assert_eq!(
        sets_from_record(Codec::H264, &[1, 0x64, 0, 0x0b, 0xff, 0xe1, 0, 40]),
        None
    );
    assert_eq!(sets_from_record(Codec::Hevc, &hex(&HEVC_HVCC[..60])), None);
}

#[test]
fn a_keyframe_without_parameter_sets_gets_them_for_the_decoder() {
    let sets = sets_from_record(Codec::H264, &hex(H264_AVCC));
    let Some(sets) = sets else {
        panic!("avcC did not parse");
    };
    let idr = annexb(&[vec![0x65, 0x88]]);
    let mut out = Vec::new();
    annexb_with_sets(Codec::H264, &idr, &sets, true, &mut out);
    let units: Vec<&[u8]> = annexb_units(&out).collect();
    assert_eq!(
        units,
        vec![sets.sps.as_slice(), sets.pps.as_slice(), &[0x65, 0x88]]
    );
    // Already carrying them, or not a keyframe: unchanged.
    let full = annexb(&[hex(H264_SPS), hex(H264_PPS), vec![0x65, 0x88]]);
    annexb_with_sets(Codec::H264, &full, &sets, true, &mut out);
    assert_eq!(out, full);
    annexb_with_sets(Codec::H264, &idr, &sets, false, &mut out);
    assert_eq!(out, idr);
}
