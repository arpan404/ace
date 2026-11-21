// SPDX-License-Identifier: Apache-2.0
//! A JPEG source on the real binary (E4): screencast pictures in as `source.picture`, encoded on
//! VideoToolbox, and out on the egress lane as H.264 under the source's handle.
#![cfg(target_os = "macos")]
mod support;

use media_codec::{CpuJpegCodec, CpuPicture, PixelFormat, Plane, Size, StillCodec};
use media_wire::capability::{Backend, Capability, Step, TrialState};
use media_wire::control::{FromMedia, Status};
use media_wire::frame::Egress;
use serde_json::json;
use std::io::Read;
use std::time::Duration;
use support::*;

const WIDTH: u32 = 640;
const HEIGHT: u32 = 400;

fn base64(bytes: &[u8]) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        for i in 0..4 {
            out.push(if i <= chunk.len() {
                ALPHABET[(n >> (18 - 6 * i) & 63) as usize]
            } else {
                b'='
            });
        }
    }
    out
}

/// A screencast-like picture: a bar that moves with `step`, as quality-80 JPEG in base64.
fn picture(step: u32) -> Vec<u8> {
    let mut data = vec![40u8; (WIDTH * HEIGHT * 3) as usize];
    for y in 0..HEIGHT {
        for x in (step * 8 % WIDTH)..((step * 8 % WIDTH) + 32).min(WIDTH) {
            let at = ((y * WIDTH + x) * 3) as usize;
            data[at..at + 3].copy_from_slice(&[230, 120, 20]);
        }
    }
    let size = Size {
        width: WIDTH,
        height: HEIGHT,
    };
    let plane = Plane {
        data,
        stride: (WIDTH * 3) as usize,
    };
    let Ok(cpu) = CpuPicture::new(size, PixelFormat::Rgb8, [plane], 0) else {
        panic!("picture");
    };
    match StillCodec::encode(&mut CpuJpegCodec::default(), &cpu, 80) {
        Ok(jpeg) => base64(&jpeg),
        Err(error) => panic!("jpeg: {error}"),
    }
}

fn read_egress(lane: &mut support::SealedLane) -> Egress {
    let mut head = [0u8; 24];
    if let Err(e) = lane.read_exact(&mut head) {
        panic!("egress lane: {e}");
    }
    let header = u16::from_be_bytes([head[18], head[19]]) as usize;
    let payload = u32::from_be_bytes([head[20], head[21], head[22], head[23]]) as usize;
    let mut bytes = head.to_vec();
    bytes.resize(12 + header + payload, 0);
    if let Err(e) = lane.read_exact(&mut bytes[24..]) {
        panic!("egress lane: {e}");
    }
    match Egress::decode(&bytes) {
        Ok(egress) => egress,
        Err(_) => panic!("invalid egress frame"),
    }
}

fn observed_hardware_jpeg(capabilities: &[Capability]) -> bool {
    capabilities.iter().any(|c| {
        c.step == Step::JpegDecode
            && c.backend == Backend::Vt
            && c.hardware
            && c.state == TrialState::Ok
    })
}

#[test]
fn a_jpeg_source_is_encoded_on_videotoolbox_and_returned_on_egress_under_its_handle() {
    jpeg_source_round_trip("pictures", json!({ "kind": "tab-pictures" }));
}

/// A screen whose helper makes only JPEG (no Media Foundation H.264, no VA-API or NVENC) is
/// encoded here like a private tab's screencast, so it still has live video (X2).
#[test]
fn a_jpeg_only_screen_is_encoded_and_returned_on_egress_under_its_handle() {
    jpeg_source_round_trip(
        "screen-pictures",
        json!({ "kind": "screen-pictures", "platform": "windows" }),
    );
}

fn jpeg_source_round_trip(name: &str, origin: serde_json::Value) {
    let mut media = Media::spawn(name);
    let init = json!({ "type": "init", "protocol": 1, "version": "0.0.0-test",
        "runtimeDir": media.dir.to_string_lossy(), "dataDir": media.dir.to_string_lossy(),
        "settings": { "recordings": "legacy", "stills": "legacy", "encode": "auto", "delivery": "legacy" } });
    media.send(init, &SECRET);
    let FromMedia::Ready {
        capabilities,
        control,
        ..
    } = media.read()
    else {
        panic!("expected ready");
    };
    let _ = capabilities;
    // Decide from what the probe finally found: on a busy machine VideoToolbox's encode may
    // only arrive after `ready`, and a source opened before it couldn't take it.
    media.settle_probe();
    let hardware_jpeg = observed_hardware_jpeg(&media.capabilities);
    let Some(_priority) = lane(&control.socket, 1, SECRET) else {
        panic!("priority lane refused");
    };
    let Some(mut egress) = lane(&control.socket, 2, SECRET) else {
        panic!("egress lane refused");
    };
    let _ = egress.set_read_timeout(Some(Duration::from_secs(10)));

    media.send(
        json!({ "type": "source.open", "source": "private", "handle": 9, "epoch": 1,
                "origin": origin }),
        &[3; 32],
    );
    media.send(
        json!({ "type": "source.egress", "source": "private", "on": true }),
        &[],
    );
    media.send(
        json!({ "type": "source.encodes", "source": "private", "encodes": [
            { "id": 4, "codec": "avc1.42E01F", "width": WIDTH, "height": HEIGHT, "fps": 30, "bitrate": 2_000_000 }
        ] }),
        &[],
    );
    for step in 0..30 {
        media.send(
            json!({ "type": "source.picture", "source": "private", "ageMs": 0, "epoch": 1 }),
            &picture(step),
        );
        std::thread::sleep(Duration::from_millis(33));
    }

    let mut units = Vec::new();
    while units.len() < 10 {
        units.push(read_egress(&mut egress));
    }
    let first = &units[0];
    assert_eq!(first.handle, 9);
    assert_eq!(first.frame.kind, 1, "video, not the JPEG");
    assert_eq!(first.frame.codec, 2, "H.264 with length prefixes");
    assert_eq!(first.frame.flags & 1, 1, "the first unit is a keyframe");
    assert!(!first.frame.description.is_empty(), "with its avcC");
    assert!(first.frame.codec_string.starts_with("avc1."));
    assert_eq!(
        (first.frame.width, first.frame.height),
        (WIDTH as u16, HEIGHT as u16)
    );
    assert!(
        units
            .iter()
            .all(|u| u.frame.encode == 4 && u.frame.epoch == 1)
    );
    let sequences: Vec<u32> = units.iter().map(|u| u.sequence).collect();
    assert_eq!(
        sequences,
        (0..10).collect::<Vec<_>>(),
        "no unit lost or repeated"
    );

    // Its status names the steps: the encode on VideoToolbox's hardware, and the JPEG decode
    // on hardware exactly where the probe observed a hardware JPEG decoder.
    let mut playing = false;
    let acceleration = loop {
        match media.read() {
            FromMedia::SourceStatus {
                status: Status::Playing,
                acceleration: Some(acceleration),
                ..
            } => break acceleration,
            FromMedia::SourceStatus {
                status: Status::Playing,
                ..
            } => playing = true,
            FromMedia::SourceStatus {
                status: Status::Ended,
                reason,
                ..
            } => panic!("the source ended: {reason:?}"),
            _ => {}
        }
    };
    let _ = playing;
    let step = |wanted: Step| acceleration.steps.iter().find(|s| s.step == wanted);
    let encode = step(Step::Encode).map(|s| (s.backend, s.hardware));
    assert_eq!(encode, Some((Backend::Vt, true)));
    let decode = step(Step::JpegDecode).map(|s| (s.hardware, s.uploads));
    if hardware_jpeg {
        assert_eq!(decode, Some((true, 0)));
    } else {
        assert_eq!(decode, Some((false, 1)), "the CPU path with one upload");
    }
    assert!(!acceleration.degraded);
}
