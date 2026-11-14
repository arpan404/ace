// SPDX-License-Identifier: Apache-2.0
//! Stills on each path this Mac has (docs/media/plan.md, F2 and "Acceleration"): VideoToolbox
//! decode at the still's size and JPEG on hardware where the probe found it, one readback
//! when JPEG encode isn't hardware, and M5's CPU path for JPEG sources. Every still is decoded
//! again with the independent CPU decoder to check its size.
#![cfg(target_os = "macos")]
#[path = "../bench/screen.rs"]
mod screen;

use ace_media::engine::stills::{Made, StillInput, StillJob, StillUnit};
use ace_media::stills::cpu::CpuStills;
use ace_media::stills::poster::{POSTER_MAX_BYTES, POSTER_MIN_BYTES, poster};
use ace_media::stills::vt::{VtOptions, VtStills};
use ace_media::stills::{StillBackend, make};
use media_codec::*;
use media_vt::{ProbeOptions, VtEncoder};
use media_wire::control::{Backend, Capability, Id, SourceStep, Step, TrialState};
use std::sync::Arc;

const SCREEN: Size = Size {
    width: 1206,
    height: 2622,
};
const BOX: Size = Size {
    width: 1568,
    height: 1568,
};

fn probed() -> Vec<Capability> {
    media_vt::probe(&ProbeOptions::default()).capabilities
}

fn hardware(capabilities: &[Capability], step: Step) -> bool {
    capabilities
        .iter()
        .any(|c| c.step == step && c.state == TrialState::Ok && c.hardware)
}

/// An encoded stream of the screen scrolling: a keyframe, then deltas.
fn stream(codec: Codec, frames: u32) -> Vec<StillUnit> {
    let mut encoder = VtEncoder::new();
    let configured = encoder.configure(&EncodeSpec {
        codec,
        size: SCREEN,
        fps: 60,
        rate: RateControl::Bitrate(12_000_000),
    });
    assert!(configured.is_ok(), "configure: {configured:?}");
    let mut units = Vec::new();
    for frame in 0..frames {
        let picture = Picture::Cpu(screen::screen(SCREEN, frame));
        assert!(encoder.encode(picture, frame == 0).is_ok());
        while let Ok(Some(unit)) = encoder.poll_result() {
            units.push(unit);
        }
    }
    assert!(encoder.flush().is_ok());
    while let Ok(Some(unit)) = encoder.poll_result() {
        units.push(unit);
    }
    assert!(
        units.first().is_some_and(|u| u.key),
        "the stream starts at a keyframe"
    );
    units
        .into_iter()
        .map(|unit| StillUnit {
            codec: match (unit.codec, unit.format) {
                (Codec::H264, BitstreamFormat::AnnexB) => 1,
                (Codec::H264, _) => 2,
                (_, BitstreamFormat::AnnexB) => 3,
                _ => 4,
            },
            key: unit.key,
            size: SCREEN,
            description: unit.description.unwrap_or_default(),
            payload: unit.data,
        })
        .collect()
}

fn job(input: StillInput, target: Size) -> StillJob {
    StillJob {
        request: Id::new("q".to_owned()).unwrap_or_else(|_| unreachable!()),
        token: 1,
        stream: 1,
        input,
        target,
        quality: 80,
        deadline_us: u64::MAX,
    }
}

fn video(group: u64, units: Vec<StillUnit>) -> StillInput {
    StillInput::Video {
        group,
        size: SCREEN,
        units,
    }
}

fn still(backend: &mut dyn StillBackend, input: StillInput, target: Size) -> Made {
    match make(backend, job(input, target), &|| 0).result {
        Ok(made) => made,
        Err(reason) => panic!("still failed: {reason}"),
    }
}

/// The independent CPU decoder agrees on the size.
fn decoded_size(jpeg: &[u8]) -> Size {
    match StillCodec::decode(&mut CpuJpegCodec::default(), jpeg) {
        Ok(picture) => picture.size(),
        Err(error) => panic!("the still is not a JPEG: {error}"),
    }
}

fn of(steps: &[SourceStep], step: Step) -> SourceStep {
    match steps.iter().find(|s| s.step == step) {
        Some(found) => found.clone(),
        None => panic!("no {step:?} step in {steps:?}"),
    }
}

fn copies(step: &SourceStep) -> (u32, u32) {
    (step.readbacks, step.uploads)
}

#[test]
fn a_still_of_an_h264_and_an_hevc_stream_takes_the_hardware_path_this_mac_probed() {
    let capabilities = probed();
    let decode_hardware = hardware(&capabilities, Step::Decode);
    let jpeg_hardware = hardware(&capabilities, Step::JpegEncode);
    let target = match fit_size(SCREEN, BOX) {
        Ok(size) => size,
        Err(error) => panic!("{error}"),
    };
    for codec in [Codec::H264, Codec::Hevc] {
        let mut backend = VtStills::new(VtOptions {
            jpeg_encode: jpeg_hardware,
            jpeg_decode: hardware(&capabilities, Step::JpegDecode),
        });
        let made = still(&mut backend, video(1, stream(codec, 4)), target);
        assert_eq!(made.size, target);
        assert_eq!(decoded_size(&made.jpeg), target);
        let decode = of(&made.steps, Step::Decode);
        let scale = of(&made.steps, Step::Scale);
        let encode = of(&made.steps, Step::JpegEncode);
        println!("{codec:?}: {:?}", made.steps);
        assert_eq!(decode.backend, Backend::Vt);
        assert_eq!(
            decode.hardware, decode_hardware,
            "what the decode session reports"
        );
        // The decoder's own destination size scales it, so no copy happens before the JPEG.
        assert_eq!(
            (scale.backend, scale.hardware),
            (Backend::Vt, decode_hardware)
        );
        assert_eq!((copies(&decode), copies(&scale)), ((0, 0), (0, 0)));
        // Hardware JPEG: H → H → H, 0 / 0. Otherwise one readback and the CPU encoder.
        if jpeg_hardware {
            assert_eq!((encode.backend, encode.hardware), (Backend::Vt, true));
            assert_eq!(copies(&encode), (0, 0));
        } else {
            assert_eq!((encode.backend, encode.hardware), (Backend::Cpu, false));
            assert_eq!(copies(&encode), (1, 0));
        }
    }
}

#[test]
fn a_later_still_continues_the_group_and_another_size_is_scaled_without_hardware() {
    let capabilities = probed();
    let mut backend = VtStills::new(VtOptions {
        jpeg_encode: hardware(&capabilities, Step::JpegEncode),
        jpeg_decode: false,
    });
    let mut units = stream(Codec::Hevc, 6);
    let rest = units.split_off(3);
    let first = Size {
        width: 720,
        height: 1564,
    };
    let made = still(&mut backend, video(1, units), first);
    assert_eq!(decoded_size(&made.jpeg), first);
    // The next job carries only the units since: the decoder continues where it stopped.
    let made = still(&mut backend, video(1, rest), first);
    assert_eq!(decoded_size(&made.jpeg), first);
    // A different box in the same group: VTPixelTransferSession, which reports nothing.
    let smaller = Size {
        width: 360,
        height: 782,
    };
    let made = still(&mut backend, video(1, Vec::new()), smaller);
    assert_eq!(decoded_size(&made.jpeg), smaller);
    let scale = of(&made.steps, Step::Scale);
    assert_eq!(
        (scale.backend, scale.hardware, copies(&scale)),
        (Backend::Vt, false, (0, 0))
    );
    // A larger box can't be scaled up from this group's pictures.
    let larger = make(&mut backend, job(video(1, Vec::new()), SCREEN), &|| 0).result;
    assert!(matches!(larger, Err(reason) if reason == "needs-keyframe"));
    // A group this decoder never saw the keyframe of can start only at the next one.
    let delta = stream(Codec::Hevc, 2).split_off(1);
    let refused = make(&mut backend, job(video(2, delta), first), &|| 0).result;
    assert!(matches!(refused, Err(reason) if reason == "needs-keyframe"));
}

#[test]
fn without_hardware_jpeg_the_still_reads_back_once_and_encodes_on_the_cpu() {
    let mut backend = VtStills::new(VtOptions {
        jpeg_encode: false,
        jpeg_decode: false,
    });
    let target = Size {
        width: 720,
        height: 1564,
    };
    let made = still(&mut backend, video(1, stream(Codec::H264, 2)), target);
    assert_eq!(decoded_size(&made.jpeg), target);
    let encode = of(&made.steps, Step::JpegEncode);
    assert_eq!((encode.backend, encode.hardware), (Backend::Cpu, false));
    assert_eq!(copies(&encode), (1, 0));
}

fn jpeg_source() -> StillInput {
    let jpeg = StillCodec::encode(&mut CpuJpegCodec::default(), &screen::screen(SCREEN, 0), 90);
    let Ok(jpeg) = jpeg else {
        panic!("source JPEG")
    };
    StillInput::Jpeg {
        data: Arc::from(jpeg),
        size: SCREEN,
    }
}

#[test]
fn the_cpu_path_makes_a_still_of_a_jpeg_source_with_no_copies() {
    let target = match fit_size(SCREEN, BOX) {
        Ok(size) => size,
        Err(error) => panic!("{error}"),
    };
    let made = still(&mut CpuStills::default(), jpeg_source(), target);
    assert_eq!(decoded_size(&made.jpeg), target);
    let steps: Vec<_> = made
        .steps
        .iter()
        .map(|s| (s.step, s.backend, s.hardware, copies(s)))
        .collect();
    assert_eq!(
        steps,
        [
            (Step::JpegDecode, Backend::Cpu, false, (0, 0)),
            (Step::Scale, Backend::Cpu, false, (0, 0)),
            (Step::JpegEncode, Backend::Cpu, false, (0, 0)),
        ]
    );
    // A video source has no CPU decoder: the daemon's legacy path answers instead.
    let refused = make(
        &mut CpuStills::default(),
        job(video(1, stream(Codec::H264, 1)), target),
        &|| 0,
    );
    assert!(matches!(refused.result, Err(reason) if reason == "decode-unavailable"));
}

#[test]
fn a_still_past_its_deadline_is_not_encoded_but_its_units_are_decoded() {
    let mut backend = VtStills::new(VtOptions {
        jpeg_encode: true,
        jpeg_decode: false,
    });
    let mut units = stream(Codec::H264, 4);
    let rest = units.split_off(2);
    let target = Size {
        width: 360,
        height: 782,
    };
    let mut late = job(video(1, units), target);
    late.deadline_us = 10;
    assert!(matches!(make(&mut backend, late, &|| 10).result, Err(reason) if reason == "deadline"));
    // The decoder kept its place, so the next job's deltas still decode.
    let made = still(&mut backend, video(1, rest), target);
    assert_eq!(decoded_size(&made.jpeg), target);
}

const VIEWPORTS: [Size; 4] = [
    Size {
        width: 390,
        height: 844,
    },
    Size {
        width: 768,
        height: 1024,
    },
    Size {
        width: 1280,
        height: 800,
    },
    Size {
        width: 1920,
        height: 1080,
    },
];

fn check_poster(made: &Made, viewport: Size) {
    let bytes = made.jpeg.len();
    println!(
        "poster {}x{} → {}x{}: {bytes} bytes",
        viewport.width, viewport.height, made.size.width, made.size.height
    );
    assert!(
        (POSTER_MIN_BYTES..=POSTER_MAX_BYTES).contains(&bytes),
        "poster for {viewport:?} is {bytes} bytes"
    );
    assert!(made.size.width <= viewport.width && made.size.height <= viewport.height);
    assert_eq!(decoded_size(&made.jpeg), made.size);
}

#[test]
fn a_poster_is_ten_to_twenty_kilobytes_at_each_viewport_on_the_gpu_and_the_cpu() {
    let capabilities = probed();
    let mut gpu = VtStills::new(VtOptions {
        jpeg_encode: hardware(&capabilities, Step::JpegEncode),
        jpeg_decode: false,
    });
    let units = stream(Codec::Hevc, 1);
    let mut cpu = CpuStills::default();
    for (group, viewport) in (1..).zip(VIEWPORTS) {
        // Each viewer's poster from its own keyframe, as when a stream starts.
        let key = StillUnit {
            codec: units[0].codec,
            key: true,
            size: SCREEN,
            description: units[0].description.clone(),
            payload: units[0].payload.clone(),
        };
        match poster(&mut gpu, 1, video(group, vec![key]), viewport) {
            Ok(made) => {
                check_poster(&made, viewport);
                // One readback per size tried, however many qualities the search took.
                let encode = of(&made.steps, Step::JpegEncode);
                assert!((1..=4).contains(&encode.readbacks), "{encode:?}");
                assert_eq!(encode.uploads, 0);
            }
            Err(reason) => panic!("GPU poster for {viewport:?}: {reason}"),
        }
        match poster(&mut cpu, 1, jpeg_source(), viewport) {
            Ok(made) => {
                check_poster(&made, viewport);
                assert_eq!(copies(&of(&made.steps, Step::JpegEncode)), (0, 0));
            }
            Err(reason) => panic!("CPU poster for {viewport:?}: {reason}"),
        }
    }
}
