// SPDX-License-Identifier: Apache-2.0
//! Untrusted JPEG input: structural damage must fail, never decode as data.
use libjpeg_turbo_rs::{Encoder, PixelFormat as Pf, Subsampling};
use media_codec::*;
use std::time::{Duration, Instant};

const W: usize = 64;
const H: usize = 48;

fn pixels(w: usize, h: usize) -> Vec<u8> {
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            data.extend_from_slice(&[
                (x * 255 / w) as u8,
                (y * 255 / h) as u8,
                ((x ^ y) * 4) as u8,
            ]);
        }
    }
    data
}
fn jpeg(subsampling: Subsampling, restart: u16) -> Vec<u8> {
    Encoder::new(&pixels(W, H), W, H, Pf::Rgb)
        .quality(90)
        .subsampling(subsampling)
        .restart_blocks(restart)
        .encode()
        .unwrap_or_else(|e| panic!("{e}"))
}
/// (marker, offset of the segment body) for every segment up to SOS.
fn segments(jpeg: &[u8]) -> Vec<(u8, usize)> {
    let mut out = Vec::new();
    let mut pos = 2;
    while pos + 4 <= jpeg.len() {
        let marker = jpeg[pos + 1];
        let len = usize::from(u16::from_be_bytes([jpeg[pos + 2], jpeg[pos + 3]]));
        out.push((marker, pos + 4));
        pos += 2 + len;
        if marker == 0xDA {
            break;
        }
    }
    out
}
fn body(jpeg: &[u8], marker: u8) -> usize {
    segments(jpeg)
        .into_iter()
        .find(|(m, _)| *m == marker)
        .map(|(_, at)| at)
        .unwrap_or_else(|| panic!("no marker {marker:x}"))
}
/// First entropy-coded byte.
fn scan_start(jpeg: &[u8]) -> usize {
    let sos = body(jpeg, 0xDA);
    sos + usize::from(u16::from_be_bytes([jpeg[sos - 2], jpeg[sos - 1]])) - 2
}
fn transcode(codec: &mut CpuJpegCodec, jpeg: &[u8], target: Size) -> Result<Vec<u8>, CodecError> {
    let mut out = Vec::new();
    codec
        .transcode_into(jpeg, target, 85, &mut out)
        .map(|()| out)
}
const FULL: Size = Size {
    width: W as u32,
    height: H as u32,
};
const EIGHTH: Size = Size {
    width: 8,
    height: 6,
};

#[test]
fn intact_streams_decode_and_every_truncation_fails() {
    let mut codec = CpuJpegCodec::default();
    for source in [jpeg(Subsampling::S420, 0), jpeg(Subsampling::S420, 1)] {
        assert!(transcode(&mut codec, &source, FULL).is_ok());
        for len in 0..source.len() {
            assert!(
                transcode(&mut codec, &source[..len], FULL).is_err(),
                "accepted {len} of {} bytes",
                source.len()
            );
        }
    }
}

#[test]
fn missing_or_early_eoi_fails() {
    let mut codec = CpuJpegCodec::default();
    let source = jpeg(Subsampling::S420, 0);
    let without_eoi = &source[..source.len() - 2];
    assert!(transcode(&mut codec, without_eoi, FULL).is_err());
    let start = scan_start(&source);
    let mut early = source[..start + (source.len() - start) / 2].to_vec();
    early.extend_from_slice(&[0xFF, 0xD9]);
    assert!(transcode(&mut codec, &early, FULL).is_err());
    // A header with EOI straight after SOS: nothing was coded.
    let mut empty = source[..start].to_vec();
    empty.extend_from_slice(&[0xFF, 0xD9]);
    assert!(transcode(&mut codec, &empty, FULL).is_err());
}

#[test]
fn missing_or_reordered_restart_markers_fail() {
    let mut codec = CpuJpegCodec::default();
    let source = jpeg(Subsampling::S420, 1);
    let start = scan_start(&source);
    let rst: Vec<usize> = (start..source.len() - 1)
        .filter(|&i| source[i] == 0xFF && (0xD0..=0xD7).contains(&source[i + 1]))
        .collect();
    assert!(rst.len() >= 3, "fixture has restart markers");
    let mut missing = source.clone();
    missing.drain(rst[0]..rst[0] + 2);
    assert!(transcode(&mut codec, &missing, FULL).is_err());
    let mut swapped = source.clone();
    swapped.swap(rst[0] + 1, rst[1] + 1);
    assert!(transcode(&mut codec, &swapped, FULL).is_err());
    let mut wrong = source.clone();
    wrong[rst[2] + 1] = 0xD7;
    assert!(transcode(&mut codec, &wrong, FULL).is_err());
}

#[test]
fn a_huge_frame_with_a_tiny_payload_fails_fast() {
    let mut codec = CpuJpegCodec::default();
    let mut source = jpeg(Subsampling::S420, 0);
    let sof = body(&source, 0xC0);
    source[sof + 1..sof + 5].copy_from_slice(&[0x10, 0x00, 0x20, 0x00]); // 8192 × 4096
    let started = Instant::now();
    for target in [FULL, EIGHTH] {
        assert!(transcode(&mut codec, &source, target).is_err());
    }
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn coefficient_categories_runs_and_quantisers_are_validated() {
    let mut codec = CpuJpegCodec::default();
    let source = jpeg(Subsampling::S420, 0);
    let dht = |source: &[u8], class: u8| -> usize {
        segments(source)
            .into_iter()
            .filter(|(m, _)| *m == 0xC4)
            .map(|(_, at)| at)
            .find(|at| source[*at] >> 4 == class)
            .unwrap_or_else(|| panic!("no DHT class {class}"))
    };
    // Rewrite every symbol of a table: the first code read decodes to `symbol`.
    let with_symbols = |class: u8, symbol: u8| {
        let mut damaged = source.clone();
        let at = dht(&damaged, class);
        let total: usize = damaged[at + 1..at + 17]
            .iter()
            .map(|c| usize::from(*c))
            .sum();
        damaged[at + 17..at + 17 + total].fill(symbol);
        damaged
    };
    for (class, symbol, what) in [
        (0, 12, "DC category 12"),
        (1, 0x0B, "AC category 11"),
        (1, 0x50, "run without size"),
        (1, 0xF0, "zero run past the block"),
    ] {
        assert!(
            transcode(&mut codec, &with_symbols(class, symbol), FULL).is_err(),
            "{what}"
        );
    }
    let mut zero_quant = source.clone();
    zero_quant[body(&source, 0xDB) + 5] = 0;
    assert!(transcode(&mut codec, &zero_quant, FULL).is_err());
}

#[test]
fn duplicate_component_ids_and_selectors_fail() {
    let mut codec = CpuJpegCodec::default();
    let source = jpeg(Subsampling::S444, 0);
    let mut sof_ids = source.clone();
    let sof = body(&source, 0xC0);
    sof_ids[sof + 9] = sof_ids[sof + 6];
    assert!(transcode(&mut codec, &sof_ids, FULL).is_err());
    let mut sos_ids = source.clone();
    let sos = body(&source, 0xDA);
    sos_ids[sos + 3] = sos_ids[sos + 1];
    assert!(transcode(&mut codec, &sos_ids, FULL).is_err());
}

#[test]
fn extreme_dequantised_coefficients_decode_at_every_dct_scale() -> Result<(), CodecError> {
    // A one-pixel checkerboard at q100 codes near-maximal AC magnitudes;
    // raising every quantiser to 255 then multiplies them far past 8 bits.
    let board: Vec<u8> = (0..W * H)
        .flat_map(|i| {
            let v = if (i % W + i / W) % 2 == 0 { 0 } else { 255 };
            [v, 255 - v, v]
        })
        .collect();
    for subsampling in [Subsampling::S444, Subsampling::S420] {
        let mut source = Encoder::new(&board, W, H, Pf::Rgb)
            .quality(100)
            .subsampling(subsampling)
            .encode()
            .unwrap_or_else(|e| panic!("{e}"));
        for (marker, at) in segments(&source.clone()) {
            if marker == 0xDB {
                let len = usize::from(u16::from_be_bytes([source[at - 2], source[at - 1]])) - 2;
                for table in source[at..at + len].chunks_exact_mut(65) {
                    table[1..].fill(255);
                }
            }
        }
        let mut codec = CpuJpegCodec::default();
        for target in [
            FULL,
            Size {
                width: 32,
                height: 24,
            },
            Size {
                width: 16,
                height: 12,
            },
            EIGHTH,
        ] {
            let out = transcode(&mut codec, &source, target)?;
            assert_eq!(codec.decode(&out)?.size(), target);
        }
    }
    Ok(())
}

fn mean_and_worst(a: &CpuPicture, b: &CpuPicture) -> (f64, u8) {
    let (mut total, mut worst) = (0_u64, 0_u8);
    for (x, y) in a.planes()[0].data.iter().zip(&b.planes()[0].data) {
        total += u64::from(x.abs_diff(*y));
        worst = worst.max(x.abs_diff(*y));
    }
    (total as f64 / a.planes()[0].data.len() as f64, worst)
}
/// Rotate the SOF component list: SOF order becomes (2, 3, 1) while the scan
/// still lists 1, 2, 3, so plane order and block order disagree.
fn rotated(subsampling: Subsampling) -> (Vec<u8>, Vec<u8>) {
    let source = jpeg(subsampling, 0);
    let mut rotated = source.clone();
    let sof = body(&source, 0xC0);
    rotated[sof + 6..sof + 15].rotate_left(3);
    (source, rotated)
}
fn assert_matches(ours: &CpuPicture, reference: &CpuPicture, plain: &CpuPicture) {
    // Two lossy encodes and different chroma filters: a wrong plane order
    // shows as a mean error above 50.
    let (mean, worst) = mean_and_worst(ours, reference);
    assert!(mean < 5.0 && worst < 100, "mean {mean:.2}, worst {worst}");
    // The rotation really changes the picture, so scan order was exercised.
    let (moved, _) = mean_and_worst(plain, reference);
    assert!(
        moved > 30.0,
        "rotation left the picture unchanged ({moved:.1})"
    );
}

#[test]
fn interleaved_scans_decode_in_sos_order_like_zune_jpeg() -> Result<(), CodecError> {
    let mut codec = CpuJpegCodec::default();
    let (source, rotated) = rotated(Subsampling::S444);
    let reference = codec.decode(&rotated)?; // zune-jpeg
    let out = transcode(&mut codec, &rotated, FULL)?;
    let ours = codec.decode(&out)?;
    let plain = codec.decode(&source)?;
    assert_matches(&ours, &reference, &plain);
    Ok(())
}

/// zune-jpeg 0.5 misreads subsampled frames whose first SOF component is not
/// the most finely sampled one, so ImageIO is the reference for 4:2:0.
#[cfg(target_os = "macos")]
#[test]
fn subsampled_scans_decode_in_sos_order_like_imageio() -> Result<(), CodecError> {
    let mut codec = CpuJpegCodec::default();
    let mut imageio = MacJpegCodec::default();
    let (source, rotated) = rotated(Subsampling::S420);
    let reference = codec.decode(&StillCodec::transcode(&mut imageio, &rotated, FULL, 100)?)?;
    let out = transcode(&mut codec, &rotated, FULL)?;
    let ours = codec.decode(&out)?;
    let plain = codec.decode(&source)?;
    assert_matches(&ours, &reference, &plain);
    Ok(())
}
