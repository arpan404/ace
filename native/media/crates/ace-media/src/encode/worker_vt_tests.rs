// SPDX-License-Identifier: Apache-2.0
//! The picture worker on this Mac's VideoToolbox: what only the real encoder shows. Its rate
//! control spends by presentation time, so a picture's timestamp must say when it is shown.
use super::*;
use crate::encode::platform::Platform;
use media_codec::{CpuJpegCodec, CpuPicture, PixelFormat, Plane, StillCodec};
use media_wire::capability::{Capability, TrialState};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn vt_worker() -> Worker<Platform> {
    let capabilities = vec![Capability {
        step: Step::Encode,
        codec: Some("avc1.640020".into()),
        backend: Backend::Vt,
        hardware: true,
        zero_copy: true,
        state: TrialState::Ok,
        max_width: 4096,
        max_height: 2304,
    }];
    Worker::new(Platform::new(Arc::new(Mutex::new(capabilities)), None))
}

/// A phone-sized screen: a gradient, so a keyframe of it costs real bits.
fn screen() -> Vec<u8> {
    let (width, height) = (390u32, 844u32);
    let data = (0..width * height)
        .flat_map(|i| {
            let (x, y) = (i % width, i / width);
            [(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8]
        })
        .collect();
    let picture = CpuPicture::new(
        Size { width, height },
        PixelFormat::Rgb8,
        [Plane {
            data,
            stride: (width * 3) as usize,
        }],
        0,
    );
    let Ok(picture) = picture else {
        panic!("picture");
    };
    match StillCodec::encode(&mut CpuJpegCodec::default(), &picture, 80) {
        Ok(jpeg) => jpeg,
        Err(error) => panic!("jpeg: {error}"),
    }
}

fn keys(out: &[Output]) -> usize {
    out.iter()
        .filter(|o| matches!(o, Output::Unit(frame) if frame.flags & 1 == 1))
        .count()
}

/// Polls as the shell does between commands, for `ms` of real time.
fn run(worker: &mut Worker<Platform>, clock: Instant, ms: u64, out: &mut Vec<Output>) {
    let end = Instant::now() + Duration::from_millis(ms);
    while Instant::now() < end {
        worker.poll(clock.elapsed().as_micros() as u64, out);
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_still_screens_keyframe_asked_for_later_comes_out_of_videotoolbox_at_a_low_bitrate() {
    let mut worker = vt_worker();
    let clock = Instant::now();
    let now = || clock.elapsed().as_micros() as u64;
    let mut out = Vec::new();
    worker.command(
        Command::Configure(vec![EncodeSpec {
            id: 1,
            codec: "avc1.42E033".into(),
            width: 390,
            height: 844,
            fps: 30,
            bitrate: 300_000,
            quantizer: None,
        }]),
        now(),
        &mut out,
    );
    // The screen's one picture, as its stream is configured; then it doesn't change.
    worker.command(
        Command::Picture {
            jpeg: screen(),
            epoch: 1,
            age_us: 0,
        },
        now(),
        &mut out,
    );
    run(&mut worker, clock, 300, &mut out);
    assert_eq!(keys(&out), 1, "the first picture is a keyframe");
    // A viewer subscribes again: no picture follows, so the keyframe is of the last one.
    worker.command(Command::Key(1), now(), &mut out);
    run(&mut worker, clock, 600, &mut out);
    assert_eq!(keys(&out), 2, "the keyframe asked for came out");
}
