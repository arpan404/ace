// SPDX-License-Identifier: Apache-2.0
//! `still.take` through the real binary: the JPEG comes back as `still.done`'s payload, from a
//! screencast frame the daemon passed on (base64 text) and from H.264 a producer streams on the ingest socket, and a
//! request past its deadline fails so the daemon's legacy still maker answers in time.
#![cfg(unix)]
mod support;

use media_codec::{CpuJpegCodec, CpuPicture, PixelFormat, Plane, Size, StillCodec, jpeg_size};
use media_wire::control::{ControlFrame, FromMedia, Lane, SourceStep, Step};
use serde_json::json;
use std::io::Read;
use support::*;

/// The next normal-lane message and its payload, skipping status and log lines.
fn answer(media: &mut Media) -> (FromMedia, Vec<u8>) {
    loop {
        let mut prefix = [0u8; 4];
        if let Err(error) = media.stdout.read_exact(&mut prefix) {
            panic!("no frame: {error}");
        }
        let mut bytes = prefix.to_vec();
        bytes.resize(4 + u32::from_be_bytes(prefix) as usize, 0);
        if let Err(error) = media.stdout.read_exact(&mut bytes[4..]) {
            panic!("cut-off frame: {error}");
        }
        let Ok(frame) = ControlFrame::<FromMedia>::decode(&bytes, Lane::Normal) else {
            panic!("invalid frame from ace-media");
        };
        match frame.message {
            FromMedia::SourceStatus { .. } | FromMedia::Log { .. } => continue,
            message => return (message, frame.payload.to_vec()),
        }
    }
}

fn take(media: &mut Media, request: &str, source: &str, side: u32, deadline_ms: u32) {
    media.send(
        json!({ "type": "still.take", "request": request, "source": source, "maxWidth": side,
                "maxHeight": side, "maxPixels": 4_000_000, "quality": 80,
                "deadlineMs": deadline_ms }),
        &[],
    );
}

fn done(media: &mut Media) -> (Size, Vec<SourceStep>, Vec<u8>) {
    match answer(media) {
        (
            FromMedia::StillDone {
                width,
                height,
                steps,
                ..
            },
            jpeg,
        ) => (Size { width, height }, steps, jpeg),
        other => panic!("expected still.done, got {other:?}"),
    }
}

/// Standard base64 with padding (RFC 4648 §4).
fn base64(bytes: &[u8]) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let at = |i: usize| u32::from(*chunk.get(i).unwrap_or(&0));
        let n = at(0) << 16 | at(1) << 8 | at(2);
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

fn picture(width: u32, height: u32) -> Vec<u8> {
    let data = (0..width * height * 3).map(|i| (i % 251) as u8).collect();
    let picture = CpuPicture::new(
        Size { width, height },
        PixelFormat::Rgb8,
        [Plane {
            data,
            stride: width as usize * 3,
        }],
        0,
    );
    match picture.and_then(|p| StillCodec::encode(&mut CpuJpegCodec::default(), &p, 85)) {
        Ok(jpeg) => jpeg,
        Err(error) => panic!("{error}"),
    }
}

#[test]
fn a_still_of_a_jpeg_source_comes_back_as_the_payload_at_the_requested_box() {
    let mut media = Media::spawn("stills-jpeg");
    media.start();
    open_source(&mut media, "s1", 1, 3);
    // As the daemon forwards a screencast frame: Chrome's base64 JPEG text, as received.
    media.send(
        json!({ "type": "source.picture", "source": "s1", "ageMs": 0, "epoch": 1 }),
        &base64(&picture(800, 400)),
    );
    take(&mut media, "q1", "s1", 200, 2_000);
    let (size, steps, jpeg) = done(&mut media);
    assert_eq!(
        size,
        Size {
            width: 200,
            height: 100
        }
    );
    assert_eq!(jpeg_size(&jpeg), Ok(size));
    let names: Vec<Step> = steps.iter().map(|s| s.step).collect();
    assert_eq!(names, [Step::JpegDecode, Step::Scale, Step::JpegEncode]);

    // No time left: it fails at once rather than answer after the daemon gave up.
    take(&mut media, "q2", "s1", 200, 0);
    match answer(&mut media) {
        (FromMedia::StillFailed { request, reason }, _) => {
            assert_eq!((request.get(), reason.as_str()), ("q2", "deadline"));
        }
        other => panic!("expected still.failed, got {other:?}"),
    }
}

const FIXTURE: &[u8] = include_bytes!("../../media-mp4/tests/vectors/h264.bin");

/// The fixture's avcC and its IDR pictures as length-prefixed samples (64 × 64, from
/// VideoToolbox).
fn fixture() -> (Vec<u8>, Vec<Vec<u8>>) {
    let length = |at: usize| {
        u32::from_be_bytes([
            FIXTURE[at],
            FIXTURE[at + 1],
            FIXTURE[at + 2],
            FIXTURE[at + 3],
        ]) as usize
    };
    let avcc = FIXTURE[4..4 + length(0)].to_vec();
    let mut at = 4 + length(0);
    let mut pictures = Vec::new();
    while at < FIXTURE.len() {
        let n = length(at);
        pictures.push(FIXTURE[at + 4..at + 4 + n].to_vec());
        at += 4 + n;
    }
    (avcc, pictures)
}

#[cfg(target_os = "macos")]
#[test]
fn a_still_of_an_h264_stream_is_decoded_and_encoded_by_videotoolbox() {
    use media_wire::control::Backend;
    use media_wire::frame::MediaFrame;
    use std::io::Write;
    use std::os::unix::net::UnixStream;

    let mut media = Media::spawn("stills-h264");
    let (_, ingest, _) = media.start();
    open_source(&mut media, "s1", 1, 3);
    let mut producer = match UnixStream::connect(&ingest) {
        Ok(socket) => socket,
        Err(error) => panic!("ingest socket: {error}"),
    };
    let (avcc, pictures) = fixture();
    let mut bytes = media_frame(5, 0, vec![3; 32]);
    for (index, picture) in pictures.iter().enumerate() {
        let frame = MediaFrame {
            kind: 1,
            flags: if index == 0 { 1 | 4 } else { 1 },
            age_us: 0,
            width: 64,
            height: 64,
            display_width: 64,
            display_height: 64,
            scale: 1000,
            rotation: 0,
            codec: 2,
            encode: 0,
            epoch: 1,
            codec_string: "avc1.64000b".into(),
            description: if index == 0 { avcc.clone() } else { Vec::new() },
            extension: Vec::new(),
            payload: picture.clone(),
        };
        match frame.encode() {
            Ok(encoded) => bytes.extend(encoded),
            Err(_) => panic!("frame did not encode"),
        }
    }
    assert!(producer.write_all(&bytes).is_ok());
    // The units reach the engine before the request: the source reports playing first.
    loop {
        let message = media.read();
        if matches!(
            message,
            FromMedia::SourceStatus {
                status: media_wire::control::Status::Playing,
                ..
            }
        ) {
            break;
        }
    }
    take(&mut media, "q1", "s1", 32, 5_000);
    let (size, steps, jpeg) = done(&mut media);
    assert_eq!(
        size,
        Size {
            width: 32,
            height: 32
        }
    );
    assert_eq!(jpeg_size(&jpeg), Ok(size));
    let decode = steps.iter().find(|s| s.step == Step::Decode);
    assert!(
        decode.is_some_and(|s| s.backend == Backend::Vt),
        "decoded by VideoToolbox: {steps:?}"
    );
}
