// SPDX-License-Identifier: Apache-2.0
//! Parameter sets, slice headers and configuration records from VideoToolbox: each parses,
//! and writing what was parsed gives back the platform encoder's exact bits.
#![allow(clippy::unwrap_used)]
use media_bitstream::{BitReader, avcc::AvcConfig, h264, hevc, hvcc::HevcConfig, nal};
use serde_json::Value;

struct Vector {
    name: String,
    width: u32,
    height: u32,
    sets: Vec<Vec<u8>>,
    record: Vec<u8>,
    slices: Vec<Vec<u8>>,
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn vectors(codec: &str) -> Vec<Vector> {
    let all: Value =
        serde_json::from_str(include_str!("../../../vectors/bitstream/videotoolbox.json")).unwrap();
    let hexes = |v: &Value| -> Vec<Vec<u8>> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|s| hex(s.as_str().unwrap()))
            .collect()
    };
    all[codec]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| Vector {
            name: v["name"].as_str().unwrap().into(),
            width: v["width"].as_u64().unwrap() as u32,
            height: v["height"].as_u64().unwrap() as u32,
            sets: hexes(&v["parameterSets"]),
            record: hex(v["record"].as_str().unwrap()),
            slices: hexes(&v["slices"]),
        })
        .collect()
}

/// The first `bits` bits of `a` and `b` agree.
fn same_bits(a: &[u8], b: &[u8], bits: usize) -> bool {
    let (mut ra, mut rb) = (BitReader::new(a), BitReader::new(b));
    (0..bits).all(|_| {
        ra.bit()
            .ok()
            .zip(rb.bit().ok())
            .is_some_and(|(x, y)| x == y)
    })
}

fn rbsp(nal: &[u8]) -> Vec<u8> {
    nal::unescape(nal)
}

#[test]
fn h264_parameter_sets_round_trip_bit_for_bit() {
    for v in vectors("h264") {
        let sps = h264::Sps::parse(&v.sets[0]).unwrap();
        assert_eq!(sps.frame_size(), (v.width, v.height), "{}", v.name);
        // VideoToolbox codes nal_ref_idc 1; the writer uses 3. The payload must match.
        assert_eq!(sps.to_nal()[1..], v.sets[0][1..], "{} SPS", v.name);
        let pps = h264::Pps::parse(&v.sets[1]).unwrap();
        assert_eq!(pps.to_nal()[1..], v.sets[1][1..], "{} PPS", v.name);
    }
}

#[test]
fn h264_slice_headers_round_trip_bit_for_bit() {
    for v in vectors("h264") {
        let sps = h264::Sps::parse(&v.sets[0]).unwrap();
        let pps = h264::Pps::parse(&v.sets[1]).unwrap();
        for (frame, slice) in v.slices.iter().enumerate() {
            let (header, bits) = h264::SliceHeader::parse(slice, &sps, &pps).unwrap();
            assert_eq!(header.idr, frame == 0, "{} frame {frame}", v.name);
            assert_eq!(header.frame_num, frame as u32, "{} frame {frame}", v.name);
            let written = header.write(&sps, &pps);
            assert_eq!(written.bit_len(), bits, "{} frame {frame}", v.name);
            assert!(
                same_bits(&written.into_bytes(), &rbsp(slice), bits),
                "{} frame {frame}",
                v.name
            );
        }
    }
}

#[test]
fn avcc_records_round_trip_and_match_their_parameter_sets() {
    for v in vectors("h264") {
        let record = AvcConfig::parse(&v.record).unwrap();
        assert_eq!(record.to_bytes().unwrap(), v.record, "{}", v.name);
        let built = AvcConfig::from_parameter_sets(&v.sets[0], &v.sets[1]).unwrap();
        assert_eq!(built, record, "{}", v.name);
    }
}

#[test]
fn hevc_parameter_sets_round_trip_bit_for_bit() {
    for v in vectors("hevc") {
        let vps = hevc::Vps::parse(&v.sets[0]).unwrap();
        assert_eq!(vps.to_nal(), v.sets[0], "{} VPS", v.name);
        let sps = hevc::Sps::parse(&v.sets[1]).unwrap();
        assert_eq!(sps.frame_size(), (v.width, v.height), "{}", v.name);
        assert_eq!(sps.to_nal(), v.sets[1], "{} SPS", v.name);
        let pps = hevc::Pps::parse(&v.sets[2]).unwrap();
        assert_eq!(pps.to_nal(), v.sets[2], "{} PPS", v.name);
    }
}

#[test]
fn hevc_slice_headers_round_trip_bit_for_bit() {
    for v in vectors("hevc") {
        let sps = hevc::Sps::parse(&v.sets[1]).unwrap();
        let pps = hevc::Pps::parse(&v.sets[2]).unwrap();
        for (frame, slice) in v.slices.iter().enumerate() {
            let (header, bits) = hevc::SliceSegmentHeader::parse(slice, &sps, &pps)
                .unwrap_or_else(|e| panic!("{} frame {frame}: {e} {sps:?} {pps:?}", v.name));
            assert_eq!(
                nal::hevc::is_key(slice),
                frame == 0,
                "{} frame {frame}",
                v.name
            );
            let written = header.write(&sps, &pps);
            assert_eq!(written.bit_len(), bits, "{} frame {frame}", v.name);
            assert!(
                same_bits(&written.into_bytes(), &rbsp(slice), bits),
                "{} frame {frame}",
                v.name
            );
        }
    }
}

#[test]
fn hvcc_records_round_trip_and_match_their_parameter_sets() {
    for v in vectors("hevc") {
        let record = HevcConfig::parse(&v.record).unwrap();
        assert_eq!(record.to_bytes().unwrap(), v.record, "{}", v.name);
        let built = HevcConfig::from_parameter_sets(&v.sets[0], &v.sets[1], &v.sets[2]).unwrap();
        assert_eq!(built.general, record.general, "{}", v.name);
        assert_eq!(built.arrays, record.arrays, "{}", v.name);
        assert_eq!(built.length_size, record.length_size, "{}", v.name);
        assert_eq!(built.chroma_format, record.chroma_format, "{}", v.name);
    }
}
