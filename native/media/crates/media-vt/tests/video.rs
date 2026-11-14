// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "macos")]
mod support;
use media_codec::*;
use media_vt::{DecodeOutput, VtDecoder, VtEncoder, VtFormat, VtSurface, VtTranscoder};
use support::*;

fn spec(codec: Codec, width: u32, height: u32, bits: u32) -> EncodeSpec {
    EncodeSpec {
        codec,
        size: Size { width, height },
        fps: 60,
        rate: RateControl::Bitrate(bits),
    }
}

fn round_trip(codec: Codec, size: Size) -> TestResult {
    let frames = Frames::new(size, 8)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&spec(codec, size.width, size.height, 20_000_000))?;
    let units = encode_all(&mut encoder, &frames, 0..30, &[])?;
    assert_eq!(units.len(), 30, "every picture comes out as one unit");
    assert!(
        units[0].key && units[0].description.is_some(),
        "the stream starts at a described keyframe"
    );
    let expected = if codec == Codec::Hevc {
        BitstreamFormat::Hvcc
    } else {
        BitstreamFormat::Avcc
    };
    assert!(units.iter().all(|u| u.format == expected && u.size == size));
    let mut decoder = VtDecoder::new(DecodeOutput::default());
    let mut last = None;
    for unit in &units {
        if let Some(picture) = decoder.decode(unit)? {
            last = Some(picture);
        }
    }
    let last = last.ok_or("nothing decoded")?;
    assert_eq!(last.size(), size);
    let psnr = luma_psnr(&frames.sources[29 % 8], &last)?;
    assert!(psnr >= 32.0, "{codec:?} {size:?} luma PSNR {psnr:.1} dB");
    #[cfg(target_arch = "aarch64")]
    assert!(
        encoder.hardware() && decoder.hardware(),
        "Apple silicon encodes and decodes in hardware"
    );
    Ok(())
}

#[test]
fn h264_round_trips_at_1280x800_and_2560x1600() -> TestResult {
    round_trip(
        Codec::H264,
        Size {
            width: 1280,
            height: 800,
        },
    )?;
    round_trip(
        Codec::H264,
        Size {
            width: 2560,
            height: 1600,
        },
    )
}

#[test]
fn hevc_round_trips_at_1280x800_and_2560x1600() -> TestResult {
    round_trip(
        Codec::Hevc,
        Size {
            width: 1280,
            height: 800,
        },
    )?;
    round_trip(
        Codec::Hevc,
        Size {
            width: 2560,
            height: 1600,
        },
    )
}

#[test]
fn a_keyframe_comes_exactly_where_one_is_requested() -> TestResult {
    let size = Size {
        width: 1280,
        height: 800,
    };
    let frames = Frames::new(size, 8)?;
    for codec in [Codec::H264, Codec::Hevc] {
        let mut encoder = VtEncoder::new();
        encoder.configure(&spec(codec, 1280, 800, 6_000_000))?;
        let units = encode_all(&mut encoder, &frames, 0..40, &[17, 31])?;
        let keys: Vec<usize> = units
            .iter()
            .enumerate()
            .filter(|(_, u)| u.key)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(keys, [0, 17, 31], "{codec:?}");
        assert!(
            units[17].description.is_some(),
            "a forced key carries the configuration record"
        );
    }
    Ok(())
}

#[test]
fn a_bitrate_change_takes_effect_in_place() -> TestResult {
    let size = Size {
        width: 1280,
        height: 800,
    };
    let frames = Frames::new(size, 8)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&spec(Codec::H264, 1280, 800, 12_000_000))?;
    let high = encode_all(&mut encoder, &frames, 0..120, &[])?;
    encoder.configure(&spec(Codec::H264, 1280, 800, 400_000))?;
    let low = encode_all(&mut encoder, &frames, 120..240, &[])?;
    // Bytes over the last second of each half; low-latency rate control may
    // drop frames to hold the rate, so compare bytes per second, not per frame.
    let last_second = |units: &[EncodedUnit], end: u64| {
        units
            .iter()
            .filter(|u| u.pts_us + 1_000_000 > end)
            .map(|u| u.data.len())
            .sum::<usize>()
    };
    let before = last_second(&high, 120 * 16_667);
    let after = last_second(&low, 240 * 16_667);
    assert!(
        after * 8 < before,
        "{before} B/s at 12 Mbit/s, {after} B/s at 400 kbit/s"
    );
    assert!(
        after * 8 < 800_000,
        "{after} B/s is within twice 400 kbit/s"
    );
    assert!(
        !low[0].key,
        "a rate change keeps the stream: no new keyframe"
    );
    Ok(())
}

#[test]
fn a_size_change_starts_a_new_stream_at_a_keyframe() -> TestResult {
    let small = Frames::new(
        Size {
            width: 640,
            height: 400,
        },
        2,
    )?;
    let large = Frames::new(
        Size {
            width: 1280,
            height: 800,
        },
        2,
    )?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&spec(Codec::Hevc, 640, 400, 2_000_000))?;
    let first = encode_all(&mut encoder, &small, 0..5, &[])?;
    encoder.configure(&spec(Codec::Hevc, 1280, 800, 4_000_000))?;
    let second = encode_all(&mut encoder, &large, 0..5, &[])?;
    assert_eq!(first.len() + second.len(), 10);
    assert!(
        second[0].key
            && second[0].size
                == Size {
                    width: 1280,
                    height: 800
                }
    );
    assert_ne!(first[0].description, second[0].description);
    Ok(())
}

#[test]
fn the_decoder_outputs_its_destination_size() -> TestResult {
    let size = Size {
        width: 2560,
        height: 1600,
    };
    let frames = Frames::new(size, 2)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&spec(Codec::Hevc, 2560, 1600, 10_000_000))?;
    let units = encode_all(&mut encoder, &frames, 0..3, &[])?;
    let target = Size {
        width: 1280,
        height: 800,
    };
    for format in [VtFormat::Nv12, VtFormat::Bgra] {
        let mut decoder = VtDecoder::new(DecodeOutput {
            size: Some(target),
            format,
        });
        let picture = decoder.decode(&units[0])?.ok_or("nothing decoded")?;
        let surface = VtSurface::of(&picture).ok_or("not a surface")?;
        assert_eq!((surface.size(), surface.format()), (target, Some(format)));
        assert!(surface.is_io_surface());
    }
    Ok(())
}

#[test]
fn a_new_destination_size_applies_mid_stream_without_a_keyframe() -> TestResult {
    let size = Size {
        width: 1280,
        height: 800,
    };
    let frames = Frames::new(size, 4)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&spec(Codec::H264, 1280, 800, 6_000_000))?;
    let units = encode_all(&mut encoder, &frames, 0..4, &[])?;
    let mut decoder = VtDecoder::new(DecodeOutput::default());
    assert_eq!(
        decoder.decode(&units[0])?.ok_or("nothing decoded")?.size(),
        size
    );
    let half = Size {
        width: 640,
        height: 400,
    };
    decoder.set_output(DecodeOutput {
        size: Some(half),
        format: VtFormat::Nv12,
    });
    assert!(!units[1].key);
    assert_eq!(
        decoder.decode(&units[1])?.ok_or("nothing decoded")?.size(),
        half
    );
    let units = encode_all(&mut encoder, &frames, 4..6, &[4])?;
    assert_eq!(
        decoder.decode(&units[0])?.ok_or("nothing decoded")?.size(),
        half,
        "reopened at the keyframe"
    );
    assert_eq!(
        decoder.decode(&units[1])?.ok_or("nothing decoded")?.size(),
        half
    );
    Ok(())
}

#[test]
fn surface_input_costs_no_copy_and_cpu_input_costs_one_upload() -> TestResult {
    let size = Size {
        width: 1280,
        height: 800,
    };
    let frames = Frames::new(size, 1)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&spec(Codec::H264, 1280, 800, 4_000_000))?;
    encoder.encode(frames.picture(0, 0)?, false)?;
    assert_eq!(encoder.last_copies(), media_vt::Copies::default());
    encoder.encode(Picture::Cpu(pattern(size, 1)?), false)?;
    assert_eq!(
        encoder.last_copies(),
        media_vt::Copies {
            readbacks: 0,
            uploads: 1
        }
    );
    encoder.flush()?;
    let mut count = 0;
    while encoder.poll_result()?.is_some() {
        count += 1;
    }
    assert_eq!(count, 2);
    Ok(())
}

#[test]
fn transcode_decodes_at_the_target_size_and_encodes_without_a_cpu_copy() -> TestResult {
    let source = Size {
        width: 1206,
        height: 2622,
    };
    let frames = Frames::new(source, 4)?;
    let mut encoder = VtEncoder::new();
    encoder.configure(&spec(Codec::Hevc, 1206, 2622, 12_000_000))?;
    let units = encode_all(&mut encoder, &frames, 0..10, &[])?;
    // 1280 px tall at the source's aspect, even sides.
    let target = spec(Codec::H264, 588, 1280, 6_000_000);
    let mut transcoder = VtTranscoder::new(&target)?;
    let mut out = Vec::new();
    let mut backpressure = 0;
    for unit in units.iter().chain(&units) {
        while let Err(error) = transcoder.push(unit, false) {
            assert_eq!(error, CodecError::Backpressure);
            backpressure += 1;
            transcoder.encoder().flush()?;
            while let Some(unit) = transcoder.encoder().poll_result()? {
                out.push(unit);
            }
        }
        assert_eq!(transcoder.last_copies(), media_vt::Copies::default());
    }
    transcoder.encoder().flush()?;
    while let Some(unit) = transcoder.encoder().poll_result()? {
        out.push(unit);
    }
    assert!(
        backpressure > 0,
        "twenty unpolled pictures hit the bounded queue"
    );
    let units = [units.as_slice(), units.as_slice()].concat();
    assert_eq!(out.len(), units.len());
    assert!(
        out.iter()
            .all(|u| u.size == target.size && u.codec == Codec::H264)
    );
    #[cfg(target_arch = "aarch64")]
    assert!(transcoder.hardware());
    Ok(())
}

#[test]
fn an_unsupported_codec_is_refused_and_keeps_the_previous_stream() -> TestResult {
    let mut encoder = VtEncoder::new();
    encoder.configure(&spec(Codec::H264, 640, 400, 1_000_000))?;
    let refused = encoder.configure(&spec(Codec::Vp9, 640, 400, 1_000_000));
    assert!(matches!(refused, Err(CodecError::Unsupported(_))));
    let frames = Frames::new(
        Size {
            width: 640,
            height: 400,
        },
        1,
    )?;
    let units = encode_all(&mut encoder, &frames, 0..2, &[])?;
    assert_eq!(
        units.iter().map(|u| u.codec).collect::<Vec<_>>(),
        [Codec::H264, Codec::H264]
    );
    Ok(())
}
