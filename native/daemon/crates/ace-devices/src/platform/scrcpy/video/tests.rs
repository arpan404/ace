// SPDX-License-Identifier: Apache-2.0
//! The moved `scrcpy-video.test.ts` cases and the reader framing, beside the code they name.

use super::*;

use super::*;

fn nal(bytes: &[u8]) -> Vec<u8> {
    let mut out = vec![0, 0, 0, 1];
    out.extend_from_slice(bytes);
    out
}

fn config() -> Vec<u8> {
    let mut out = nal(&[0x67, 0x42, 0xc0, 0x29, 0x8d]);
    out.extend(nal(&[0x68, 0xce]));
    out
}

fn packet(first: u8, pts: u64, payload: &[u8]) -> Vec<u8> {
    let mut out = ((first as u64) << 56 | pts).to_be_bytes().to_vec();
    out.extend((payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out
}

#[test]
fn every_keyframe_carries_the_streams_parameter_sets_and_codec() {
    let mut reader = VideoStreamReader::new(MAX_PACKET);
    let mut units = ScrcpyVideoUnits::new();
    let mut emitted = Vec::new();
    let mut resized = Vec::new();
    let mut feed = |bytes: &[u8]| {
        for event in reader.push(bytes).expect("reads") {
            for event in units.push(event).expect("units") {
                match event {
                    UnitsEvent::Unit(unit) => emitted.push(unit),
                    UnitsEvent::Resized { width, height } => resized.push((width, height)),
                }
            }
        }
    };
    feed(&H264.to_be_bytes());
    let mut session = 0x8000_0000u32.to_be_bytes().to_vec();
    session.extend(576u32.to_be_bytes());
    session.extend(1280u32.to_be_bytes());
    feed(&session);
    feed(&packet(0x40, 0, &config()));
    feed(&packet(0x20, 1, &nal(&[0x65, 1])));
    feed(&packet(0, 2, &nal(&[0x41, 2])));
    assert_eq!(resized, vec![(576, 1280)]);
    assert_eq!(
        emitted
            .iter()
            .map(|unit| (
                unit.keyframe,
                unit.video_codec.clone(),
                unit.width,
                unit.height
            ))
            .collect::<Vec<_>>(),
        vec![
            (true, "avc1.42C029".to_string(), 576, 1280),
            (false, "avc1.42C029".to_string(), 576, 1280)
        ]
    );
    let mut expected = config();
    expected.extend(nal(&[0x65, 1]));
    assert_eq!(emitted[0].payload, expected);
    assert_eq!(emitted[1].payload, nal(&[0x41, 2]));
}

#[test]
fn after_rotation_deltas_wait_for_the_new_sessions_configuration_and_keyframe() {
    let mut units = ScrcpyVideoUnits::new();
    let mut emitted = Vec::new();
    let mut sessions = Vec::new();
    for event in [
        VideoEvent::Codec { id: H264 },
        VideoEvent::Session {
            width: 576,
            height: 1280,
        },
        VideoEvent::Packet {
            config: true,
            keyframe: false,
            pts: 0,
            payload: config(),
        },
        VideoEvent::Packet {
            config: false,
            keyframe: true,
            pts: 1,
            payload: nal(&[0x65]),
        },
        VideoEvent::Session {
            width: 1280,
            height: 576,
        },
        VideoEvent::Packet {
            config: false,
            keyframe: false,
            pts: 2,
            payload: nal(&[0x41]),
        },
        VideoEvent::Packet {
            config: true,
            keyframe: false,
            pts: 3,
            payload: config(),
        },
        VideoEvent::Packet {
            config: false,
            keyframe: true,
            pts: 4,
            payload: nal(&[0x65]),
        },
    ] {
        for out in units.push(event).expect("units") {
            match out {
                UnitsEvent::Unit(unit) => emitted.push(unit),
                UnitsEvent::Resized { width, height } => sessions.push((width, height)),
            }
        }
    }
    assert_eq!(sessions, vec![(576, 1280), (1280, 576)]);
    assert_eq!(
        emitted
            .iter()
            .map(|unit| (unit.keyframe, unit.width))
            .collect::<Vec<_>>(),
        vec![(true, 576), (true, 1280)]
    );
}

#[test]
fn a_stream_in_any_codec_other_than_h264_is_refused() {
    assert!(
        ScrcpyVideoUnits::new()
            .push(VideoEvent::Codec { id: 0x6832_3635 })
            .expect_err("refused")
            .to_string()
            .contains("unsupported video codec")
    );
}

#[test]
fn the_reader_splits_packets_however_the_socket_chunks_arrive_and_keeps_their_flags() {
    let mut stream = H264.to_be_bytes().to_vec();
    stream.extend(0x8000_0000u32.to_be_bytes());
    stream.extend(576u32.to_be_bytes());
    stream.extend(1280u32.to_be_bytes());
    stream.extend(packet(0x20, 41, &[1, 2, 3]));
    for split in 1..stream.len() {
        let mut reader = VideoStreamReader::new(MAX_PACKET);
        let mut events = reader.push(&stream[..split]).expect("reads");
        events.extend(reader.push(&stream[split..]).expect("reads"));
        assert_eq!(events.len(), 3, "split at {split}");
        assert_eq!(
            events[2],
            VideoEvent::Packet {
                config: false,
                keyframe: true,
                pts: 41,
                payload: vec![1, 2, 3]
            },
            "split at {split}"
        );
    }
}

#[test]
fn a_packet_over_the_limit_is_refused_before_it_is_buffered() {
    let mut stream = H264.to_be_bytes().to_vec();
    stream.extend(packet(0, 0, &[]));
    let mut header = stream.clone();
    let at = header.len() - 4;
    header[at..].copy_from_slice(&((MAX_PACKET + 1) as u32).to_be_bytes());
    assert!(
        VideoStreamReader::new(MAX_PACKET)
            .push(&header)
            .expect_err("refused")
            .to_string()
            .contains("exceeds limit")
    );
}
