// SPDX-License-Identifier: Apache-2.0
//! Arbitrary bytes through every media-bitstream reader. The first byte picks how the rest
//! is read. Nothing may panic, and whatever a reader accepts must write back to bytes it
//! reads the same way.
#![no_main]
use libfuzzer_sys::fuzz_target;
use media_bitstream::{avcc::AvcConfig, h264, hevc, hvcc::HevcConfig, nal};

fuzz_target!(|data: &[u8]| {
    let Some((&mode, rest)) = data.split_first() else {
        return;
    };
    match mode % 4 {
        0 => {
            if let Ok(s) = h264::Sps::parse(rest) {
                assert_eq!(h264::Sps::parse(&s.to_nal()).ok(), Some(s.clone()));
                let pps = h264::Pps::simple(true, true, 26);
                let _ = h264::SliceHeader::parse(rest, &s, &pps);
            }
            if let Ok(p) = h264::Pps::parse(rest) {
                assert_eq!(h264::Pps::parse(&p.to_nal()).ok(), Some(p));
            }
        }
        1 => {
            if let Ok(v) = hevc::Vps::parse(rest) {
                assert_eq!(hevc::Vps::parse(&v.to_nal()).ok(), Some(v));
            }
            if let Ok(s) = hevc::Sps::parse(rest) {
                assert_eq!(hevc::Sps::parse(&s.to_nal()).ok(), Some(s.clone()));
                let pps = hevc::Pps::simple(26);
                let _ = hevc::SliceSegmentHeader::parse(rest, &s, &pps);
            }
            if let Ok(p) = hevc::Pps::parse(rest) {
                assert_eq!(hevc::Pps::parse(&p.to_nal()).ok(), Some(p));
            }
        }
        2 => {
            if let Ok(r) = AvcConfig::parse(rest) {
                let _ = r.to_bytes();
            }
            if let Ok(r) = HevcConfig::parse(rest) {
                let _ = (r.to_bytes(), r.codec_string());
            }
        }
        _ => {
            let _ = nal::annex_b_units(rest).count();
            let _ = nal::length_prefixed_units(rest, 4);
            let mut out = Vec::new();
            let _ = nal::annex_b_to_length_prefixed(rest, 4, &mut out);
            let _ = nal::unescape(rest);
        }
    }
});
