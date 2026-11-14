// SPDX-License-Identifier: Apache-2.0
use media_codec::*;
const INPUT: &[u8] = include_bytes!("../bench/data/still-1206x2622.jpg");

#[test]
fn dct_reduction_never_requires_upscaling_to_the_requested_size() {
    let size = |(width, height)| Size { width, height };
    for (target, decoded) in [
        ((722, 1568), (1206, 2622)),
        ((600, 1300), (603, 1311)),
        ((300, 650), (302, 656)),
        ((150, 327), (151, 328)),
        ((151, 328), (302, 656)),
    ] {
        assert_eq!(
            dct_scaled_size(size((1206, 2622)), size(target)),
            size(decoded)
        );
    }
}
#[test]
fn size_helpers_widen_instead_of_overflowing() {
    let huge = Size {
        width: u32::MAX,
        height: u32::MAX,
    };
    let tiny = Size {
        width: 1,
        height: 1,
    };
    assert_eq!(
        dct_scaled_size(huge, tiny),
        Size {
            width: u32::MAX.div_ceil(8),
            height: u32::MAX.div_ceil(8)
        }
    );
    assert_eq!(dct_scaled_size(tiny, huge), tiny);
    assert!(
        jpeg_capacity(Size {
            width: 8192,
            height: 4096
        }) >= 8192 * 4096 * 3
    );
}

/// JPEG, its colour and the transcode target.
type Frame<'a> = (&'a [u8], [u8; 3], (u32, u32));

/// A solid frame: `colour` everywhere, at an odd size so planes carry padding.
fn solid(width: usize, height: usize, colour: [u8; 3]) -> Vec<u8> {
    libjpeg_turbo_rs::Encoder::new(
        &colour.repeat(width * height),
        width,
        height,
        libjpeg_turbo_rs::PixelFormat::Rgb,
    )
    .quality(95)
    .subsampling(libjpeg_turbo_rs::Subsampling::S420)
    .encode()
    .unwrap_or_else(|e| panic!("{e}"))
}

#[test]
fn alternating_frames_never_show_the_previous_frame_at_edges_or_padding() -> Result<(), CodecError>
{
    let mut codec = CpuJpegCodec::default();
    let mut output = Vec::new();
    let red = [220, 20, 20];
    let blue = [20, 20, 220];
    // Large frames fill more padded storage than the small odd ones use, so
    // a stale sample would surface along the small frames' last row/column.
    let large = solid(96, 80, red);
    let small = solid(37, 23, blue);
    let frames: [Frame<'_>; 4] = [
        (&large, red, (96, 80)),
        (&small, blue, (37, 23)),
        (&large, red, (48, 40)),
        (&small, blue, (17, 11)),
    ];
    for round in 0..3 {
        for (jpeg, colour, (width, height)) in frames {
            let target = Size { width, height };
            codec.transcode_into(jpeg, target, 90, &mut output)?;
            let picture = codec.decode(&output)?;
            assert_eq!(picture.size(), target);
            let plane = &picture.planes()[0];
            let (w, h) = (width as usize, height as usize);
            let edges = (0..w)
                .map(|x| (x, h - 1))
                .chain((0..h).map(|y| (w - 1, y)))
                .chain([(0, 0), (w / 2, h / 2)]);
            for (x, y) in edges {
                let px = &plane.data[y * plane.stride + x * 3..][..3];
                for (actual, expected) in px.iter().zip(colour) {
                    assert!(
                        actual.abs_diff(expected) <= 12,
                        "round {round}, {width}x{height} at ({x}, {y}): {px:?}"
                    );
                }
            }
            // A failed frame in between must leave nothing behind either.
            let cut = &jpeg[..jpeg.len() - 40];
            assert!(codec.transcode_into(cut, target, 90, &mut output).is_err());
            assert!(
                codec
                    .transcode_into(b"bad jpeg", target, 90, &mut output)
                    .is_err()
            );
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
#[test]
fn native_stills_round_trip_through_the_portable_decoder_at_the_requested_size()
-> Result<(), CodecError> {
    let mut native: Box<dyn StillCodec> = Box::<MacJpegCodec>::default();
    let mut cpu = CpuJpegCodec::default();
    for target in [
        Size {
            width: 722,
            height: 1568,
        },
        Size {
            width: 302,
            height: 656,
        },
    ] {
        let result = native.transcode(INPUT, target, 80)?;
        let picture = cpu.decode(&result)?;
        assert_eq!(picture.size(), target);
        // The frozen fixture has B = (R + G) modulo 256. Compare a smooth
        // central patch well away from the gradient's wrap boundaries.
        let x = (target.width as f64 * 100.0 / 1206.0) as usize;
        let y = (target.height as f64 * 100.0 / 2622.0) as usize;
        let pixel = &picture.planes()[0].data[y * picture.planes()[0].stride + x * 3..][..3];
        for (actual, expected) in pixel.iter().zip([100_u8, 100, 200]) {
            assert!(actual.abs_diff(expected) < 15, "{pixel:?}");
        }
        let reencoded = native.encode(&picture, 80)?;
        assert_eq!(cpu.decode(&reencoded)?.size(), target);
    }
    assert!(
        native
            .transcode(
                b"bad jpeg",
                Size {
                    width: 722,
                    height: 1568
                },
                80
            )
            .is_err()
    );
    assert!(
        native
            .transcode(
                INPUT,
                Size {
                    width: 722,
                    height: 1568
                },
                0
            )
            .is_err()
    );
    Ok(())
}
