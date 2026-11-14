// SPDX-License-Identifier: Apache-2.0
use libjpeg_turbo_rs::{Encoder, PixelFormat as Pf, Subsampling};
use media_codec::*;

const W: usize = 97;
const H: usize = 65;

fn gradient(w: usize, h: usize) -> Vec<u8> {
    let mut data = Vec::with_capacity(w * h * 3);
    for y in 0..h {
        for x in 0..w {
            data.extend_from_slice(&[(x * 200 / w) as u8, (y * 200 / h) as u8, 80]);
        }
    }
    data
}
fn luma(rgb: &[u8]) -> Vec<u8> {
    rgb.chunks_exact(3)
        .map(|p| {
            (0.299 * f64::from(p[0]) + 0.587 * f64::from(p[1]) + 0.114 * f64::from(p[2])).round()
                as u8
        })
        .collect()
}
fn source(subsampling: Subsampling, restart: u16) -> Vec<u8> {
    let pixels = gradient(W, H);
    Encoder::new(&pixels, W, H, Pf::Rgb)
        .quality(95)
        .subsampling(subsampling)
        .restart_blocks(restart)
        .encode()
        .unwrap_or_else(|e| panic!("{e}"))
}
fn sources() -> Vec<(&'static str, Vec<u8>, bool)> {
    let gray = Encoder::new(&luma(&gradient(W, H)), W, H, Pf::Grayscale)
        .quality(95)
        .encode()
        .unwrap_or_else(|e| panic!("{e}"));
    let progressive = libjpeg_turbo_rs::compress_progressive(
        &gradient(W, H),
        W,
        H,
        Pf::Rgb,
        95,
        Subsampling::S420,
    )
    .unwrap_or_else(|e| panic!("{e}"));
    vec![
        ("4:4:4", source(Subsampling::S444, 0), false),
        ("4:2:2", source(Subsampling::S422, 0), false),
        ("4:2:0", source(Subsampling::S420, 0), false),
        ("4:4:0", source(Subsampling::S440, 0), false),
        ("4:1:1", source(Subsampling::S411, 0), false),
        (
            "4:2:0 restart every MCU",
            source(Subsampling::S420, 1),
            false,
        ),
        ("progressive", progressive, false),
        ("grayscale", gray, true),
    ]
}

#[test]
fn every_sampling_layout_transcodes_to_the_requested_size_and_colour() -> Result<(), CodecError> {
    let mut codec = CpuJpegCodec::default();
    let mut output = Vec::new();
    // Full size, then the 1/2 and 1/8 DCT-scaled decodes, then an odd size.
    for (name, jpeg, gray) in sources() {
        for (tw, th) in [(97, 65), (48, 32), (12, 8), (31, 21)] {
            codec.transcode_into(
                &jpeg,
                Size {
                    width: tw,
                    height: th,
                },
                90,
                &mut output,
            )?;
            let picture = codec.decode(&output)?;
            assert_eq!(picture.size().width, tw, "{name}");
            assert_eq!(picture.size().height, th, "{name}");
            let expected = gradient(tw as usize, th as usize);
            let expected = if gray {
                luma(&expected).iter().flat_map(|v| [*v; 3]).collect()
            } else {
                expected
            };
            let error = picture.planes()[0]
                .data
                .iter()
                .zip(&expected)
                .map(|(a, b)| f64::from(a.abs_diff(*b)))
                .sum::<f64>()
                / expected.len() as f64;
            assert!(error < 12.0, "{name} at {tw}x{th}: mean error {error:.2}");
        }
    }
    Ok(())
}

#[test]
fn truncated_or_corrupted_streams_fail_or_finish_without_panicking() {
    let mut codec = CpuJpegCodec::default();
    let mut output = Vec::new();
    let target = Size {
        width: 48,
        height: 32,
    };
    for jpeg in [source(Subsampling::S420, 0), source(Subsampling::S420, 2)] {
        for len in (0..jpeg.len()).step_by(5) {
            let result = codec.transcode_into(&jpeg[..len], target, 80, &mut output);
            // Headers end before the scan; a cut there can never produce output.
            if len < 200 {
                assert!(result.is_err(), "accepted {len} header bytes");
            }
        }
        for position in (2..jpeg.len()).step_by(3) {
            let mut damaged = jpeg.clone();
            damaged[position] ^= 0x5A;
            let _ = codec.transcode_into(&damaged, target, 80, &mut output);
        }
        // The codec is still sound after every failure.
        codec
            .transcode_into(&jpeg, target, 80, &mut output)
            .unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(codec.decode(&output).map(|p| p.size()), Ok(target));
    }
}
