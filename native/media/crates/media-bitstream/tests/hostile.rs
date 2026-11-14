// SPDX-License-Identifier: Apache-2.0
//! Hostile input: crafted parameter sets that would overflow size arithmetic, and a seeded
//! mutation sweep over every vector. Readers must refuse or accept without panicking, and
//! whatever they accept must write back to something they read the same way.
#![allow(clippy::unwrap_used)]
use media_bitstream::{BitstreamError, avcc::AvcConfig, h264, hevc, hvcc::HevcConfig, nal};
use serde_json::Value;

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn crop_offsets_past_the_picture_are_refused_not_wrapped() {
    let base = h264::Sps::progressive(h264::profile::HIGH, 0, 40, 16, 16, 1, None);
    let table: [(u32, u32, u32, u32, bool); 6] = [
        // left, right, top, bottom (crop units of 2 samples), accepted
        (u32::MAX - 1, u32::MAX - 1, 0, 0, false),
        (0, 0, 0x8000_0000, 0x8000_0000, false),
        (0x7fff_ffff, 1, 0, 0, false),
        (4, 4, 0, 0, false), // 16 samples cropped from 16
        (4, 3, 0, 0, true),  // 2 left
        (0, 0, 7, 0, true),
    ];
    for (left, right, top, bottom, ok) in table {
        let mut sps = base.clone();
        sps.crop = Some(h264::Crop {
            left,
            right,
            top,
            bottom,
        });
        let parsed = h264::Sps::parse(&sps.to_nal());
        assert_eq!(
            parsed.is_ok(),
            ok,
            "{left} {right} {top} {bottom}: {parsed:?}"
        );
        if !ok {
            assert!(matches!(parsed, Err(BitstreamError::Invalid(_))));
        }
    }
    let mut sps = base;
    sps.crop = Some(h264::Crop {
        left: u32::MAX - 1,
        right: u32::MAX - 1,
        top: 0,
        bottom: 0,
    });
    assert_eq!(sps.frame_size(), (0, 16), "a hand-built struct saturates");
}

#[test]
fn conformance_windows_past_the_picture_and_odd_sizes_are_refused() {
    let ptl = hevc::ProfileTierLevel::progressive(hevc::profile::MAIN, 90);
    let base = hevc::Sps::progressive(ptl, 64, 64, 16, 6, 1, vec![], None);
    let windows: [(u32, u32, bool); 4] = [
        (u32::MAX - 1, u32::MAX - 1, false),
        (16, 16, false),
        (16, 15, true),
        (0x8000_0000, 0, false),
    ];
    for (left, right, ok) in windows {
        let mut sps = base.clone();
        sps.conformance = Some(hevc::Conformance {
            left,
            right,
            top: 0,
            bottom: 0,
        });
        assert_eq!(
            hevc::Sps::parse(&sps.to_nal()).is_ok(),
            ok,
            "{left} {right}"
        );
    }
    for (w, h) in [(0, 64), (64, 0), (60, 64)] {
        let mut sps = base.clone();
        sps.pic_width_in_luma_samples = w;
        sps.pic_height_in_luma_samples = h;
        assert!(hevc::Sps::parse(&sps.to_nal()).is_err(), "{w}x{h}");
    }
}

/// xorshift64*, seeded: the sweep is the same on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }
}

fn mutate(rng: &mut Rng, input: &[u8]) -> Vec<u8> {
    let mut out = input.to_vec();
    match rng.below(4) {
        0 => out.truncate(rng.below(out.len() + 1)),
        1 => {
            let i = rng.below(out.len());
            out.insert(i, rng.next() as u8);
        }
        _ => {
            for _ in 0..=rng.below(3) {
                if out.len() > 1 {
                    // Keep the NAL header byte(s) mostly intact so the deep paths run.
                    let i = 1 + rng.below(out.len() - 1);
                    out[i] ^= 1 << rng.below(8);
                }
            }
        }
    }
    out
}

/// Parses `bytes` as every kind; anything accepted must survive write → read unchanged.
fn exercise(
    bytes: &[u8],
    h264_ctx: Option<(&h264::Sps, &h264::Pps)>,
    hevc_ctx: Option<(&hevc::Sps, &hevc::Pps)>,
) {
    if let Ok(s) = h264::Sps::parse(bytes) {
        assert_eq!(h264::Sps::parse(&s.to_nal()).unwrap(), s);
        let _ = s.frame_size();
    }
    if let Ok(p) = h264::Pps::parse(bytes) {
        assert_eq!(h264::Pps::parse(&p.to_nal()).unwrap(), p);
    }
    if let Ok(v) = hevc::Vps::parse(bytes) {
        assert_eq!(hevc::Vps::parse(&v.to_nal()).unwrap(), v);
    }
    if let Ok(s) = hevc::Sps::parse(bytes) {
        assert_eq!(hevc::Sps::parse(&s.to_nal()).unwrap(), s);
        let _ = (s.frame_size(), s.ctb_count());
    }
    if let Ok(p) = hevc::Pps::parse(bytes) {
        assert_eq!(hevc::Pps::parse(&p.to_nal()).unwrap(), p);
    }
    if let Some((sps, pps)) = h264_ctx {
        let _ = h264::SliceHeader::parse(bytes, sps, pps).map(|(h, _)| h.write(sps, pps));
    }
    if let Some((sps, pps)) = hevc_ctx {
        let _ = hevc::SliceSegmentHeader::parse(bytes, sps, pps).map(|(h, _)| h.write(sps, pps));
    }
    if let Ok(r) = AvcConfig::parse(bytes) {
        let _ = r.to_bytes();
    }
    if let Ok(r) = HevcConfig::parse(bytes) {
        let _ = (r.to_bytes(), r.codec_string());
    }
    let _ = nal::annex_b_units(bytes).count();
    let _ = nal::length_prefixed_units(bytes, 4);
    let _ = nal::unescape(bytes);
}

#[test]
fn mutated_vectors_never_panic_and_accepted_ones_round_trip() {
    let all: Value =
        serde_json::from_str(include_str!("../../../vectors/bitstream/videotoolbox.json")).unwrap();
    let mut rng = Rng(0x00ac_e0b3_5eed);
    for codec in ["h264", "hevc"] {
        for v in all[codec].as_array().unwrap() {
            let mut units: Vec<Vec<u8>> = v["parameterSets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|s| hex(s.as_str().unwrap()))
                .collect();
            let sets = units.clone();
            units.push(hex(v["record"].as_str().unwrap()));
            units.extend(
                v["slices"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|s| hex(s.as_str().unwrap())),
            );
            let h = (codec == "h264").then(|| {
                (
                    h264::Sps::parse(&sets[0]).unwrap(),
                    h264::Pps::parse(&sets[1]).unwrap(),
                )
            });
            let e = (codec == "hevc").then(|| {
                (
                    hevc::Sps::parse(&sets[1]).unwrap(),
                    hevc::Pps::parse(&sets[2]).unwrap(),
                )
            });
            for unit in &units {
                for _ in 0..400 {
                    let mutated = mutate(&mut rng, unit);
                    exercise(
                        &mutated,
                        h.as_ref().map(|(s, p)| (s, p)),
                        e.as_ref().map(|(s, p)| (s, p)),
                    );
                }
            }
        }
    }
}
