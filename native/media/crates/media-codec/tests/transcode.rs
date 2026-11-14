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
fn repeated_transcodes_reuse_storage_without_leaking_the_previous_picture() -> Result<(), CodecError>
{
    let mut codec = CpuJpegCodec::default();
    let mut output = Vec::new();
    for target in [
        Size {
            width: 300,
            height: 650,
        },
        Size {
            width: 150,
            height: 326,
        },
        Size {
            width: 300,
            height: 650,
        },
    ] {
        codec.transcode_into(INPUT, target, 80, &mut output)?;
        assert_eq!(codec.decode(&output)?.size(), target);
    }
    assert!(
        codec
            .transcode_into(
                b"bad jpeg",
                Size {
                    width: 300,
                    height: 650
                },
                80,
                &mut output
            )
            .is_err()
    );
    codec.transcode_into(
        INPUT,
        Size {
            width: 300,
            height: 650,
        },
        80,
        &mut output,
    )?;
    assert_eq!(
        codec.decode(&output)?.size(),
        Size {
            width: 300,
            height: 650
        }
    );
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
