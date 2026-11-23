// SPDX-License-Identifier: Apache-2.0
//! The video half of `scrcpy-protocol` and `scrcpy-video`: the socket splits into codec,
//! session and media packets, and units carry the stream's parameter sets so a viewer can
//! join at any keyframe.
use super::*;

fn nal(first: u8, rest: &[u8]) -> Vec<u8> {
    let mut out = vec![0, 0, 0, 1, first];
    out.extend_from_slice(rest);
    out
}

fn config() -> Vec<u8> {
    [nal(0x67, &[0x42, 0xc0, 0x29, 0x8d]), nal(0x68, &[0xce])].concat()
}

fn session(width: u32, height: u32) -> Vec<u8> {
    let mut head = vec![0x80, 0, 0, 0];
    head.extend_from_slice(&width.to_be_bytes());
    head.extend_from_slice(&height.to_be_bytes());
    head
}

fn media(flags: u8, pts: u64, payload: &[u8]) -> Vec<u8> {
    let word = (u64::from(flags) << 56) | (pts & ((1 << 61) - 1));
    let mut head = word.to_be_bytes().to_vec();
    head.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    head.extend_from_slice(payload);
    head
}

fn read_all(stream: &[u8]) -> (Vec<Event>, Result<(), ScrcpyError>) {
    let mut reader = VideoStreamReader::new();
    let mut events = Vec::new();
    let result = reader.push(stream, &mut events);
    (events, result)
}

#[test]
fn the_socket_splits_into_codec_session_and_media_packets_whichever_way_bytes_arrive() {
    let stream = [
        b"h264".to_vec(),
        session(576, 1280),
        media(0x40, 0, &[0, 0, 0, 1, 0x67]),
        media(0x20, 16_666, &[1, 2, 3]),
        media(0x00, 33_333, &[4]),
    ]
    .concat();
    let (whole, result) = read_all(&stream);
    assert_eq!(result, Ok(()));
    let mut split = Vec::new();
    let mut reader = VideoStreamReader::new();
    for byte in &stream {
        let result = reader.push(std::slice::from_ref(byte), &mut split);
        assert_eq!(result, Ok(()));
    }
    assert_eq!(split, whole);
    assert_eq!(
        whole,
        vec![
            Event::Codec(0x6832_3634),
            Event::Session {
                width: 576,
                height: 1280
            },
            Event::Packet {
                config: true,
                keyframe: false,
                pts: 0,
                payload: vec![0, 0, 0, 1, 0x67],
            },
            Event::Packet {
                config: false,
                keyframe: true,
                pts: 16_666,
                payload: vec![1, 2, 3],
            },
            Event::Packet {
                config: false,
                keyframe: false,
                pts: 33_333,
                payload: vec![4],
            },
        ]
    );
}

#[test]
fn a_packet_larger_than_the_frame_budget_is_refused_before_it_is_buffered() {
    let mut reader = VideoStreamReader::new();
    let mut events = Vec::new();
    assert_eq!(reader.push(b"h264", &mut events), Ok(()));
    let mut head = vec![0u8; 12];
    head[8..12].copy_from_slice(&(9 * 1024 * 1024u32).to_be_bytes());
    assert_eq!(
        reader.push(&head, &mut events),
        Err(ScrcpyError::PacketTooLarge)
    );
}

fn units_of(events: Vec<Event>) -> (Vec<VideoUnit>, Result<(), ScrcpyError>) {
    let mut units = VideoUnits::new();
    let mut out = Vec::new();
    let mut result = Ok(());
    for event in events {
        if result.is_ok() {
            result = units.push(event, &mut out);
        }
    }
    (out, result)
}

#[test]
fn every_keyframe_carries_the_streams_parameter_sets_and_codec_so_a_viewer_can_join_there() {
    let (units, result) = units_of(vec![
        Event::Codec(0x6832_3634),
        Event::Session {
            width: 576,
            height: 1280,
        },
        Event::Packet {
            config: true,
            keyframe: false,
            pts: 0,
            payload: config(),
        },
        Event::Packet {
            config: false,
            keyframe: true,
            pts: 1,
            payload: nal(0x65, &[1]),
        },
        Event::Packet {
            config: false,
            keyframe: false,
            pts: 2,
            payload: nal(0x41, &[2]),
        },
    ]);
    assert_eq!(result, Ok(()));
    assert_eq!(
        units
            .iter()
            .map(|unit| (unit.keyframe, unit.codec.clone(), unit.width, unit.height))
            .collect::<Vec<_>>(),
        vec![
            (true, "avc1.42C029".to_owned(), 576, 1280),
            (false, "avc1.42C029".to_owned(), 576, 1280),
        ]
    );
    assert_eq!(units[0].payload, [config(), nal(0x65, &[1])].concat());
    assert_eq!(units[1].payload, nal(0x41, &[2]));
    let frame = unit_frame(&units[0]);
    let Ok(frame) = frame else {
        panic!("a keyframe makes a frame");
    };
    assert_eq!((frame.flags, frame.width, frame.height), (1, 576, 1280));
    assert_eq!(frame.codec_string, "avc1.42C029");
}

#[test]
fn after_rotation_deltas_wait_for_the_new_sessions_configuration_and_keyframe() {
    let mut units = VideoUnits::new();
    let mut out = Vec::new();
    let mut sizes = Vec::new();
    for event in [
        Event::Codec(0x6832_3634),
        Event::Session {
            width: 576,
            height: 1280,
        },
        Event::Packet {
            config: true,
            keyframe: false,
            pts: 0,
            payload: config(),
        },
        Event::Packet {
            config: false,
            keyframe: true,
            pts: 1,
            payload: nal(0x65, &[]),
        },
        Event::Session {
            width: 1280,
            height: 576,
        },
        Event::Packet {
            config: false,
            keyframe: false,
            pts: 2,
            payload: nal(0x41, &[]),
        },
        Event::Packet {
            config: true,
            keyframe: false,
            pts: 3,
            payload: config(),
        },
        Event::Packet {
            config: false,
            keyframe: true,
            pts: 4,
            payload: nal(0x65, &[]),
        },
    ] {
        let result = units.push(event, &mut out);
        assert_eq!(result, Ok(()));
        sizes.push(units.size());
    }
    assert!(sizes.contains(&(576, 1280)));
    assert!(sizes.contains(&(1280, 576)));
    assert_eq!(
        out.iter()
            .map(|unit| (unit.keyframe, unit.width))
            .collect::<Vec<_>>(),
        vec![(true, 576), (true, 1280)]
    );
}

#[test]
fn a_stream_in_any_codec_but_h264_is_refused_rather_than_shown_as_garbage() {
    let mut units = VideoUnits::new();
    let mut out = Vec::new();
    assert_eq!(
        units.push(Event::Codec(0x6832_3635), &mut out),
        Err(ScrcpyError::UnsupportedCodec)
    );
}

#[test]
fn the_device_name_runs_to_its_first_nul_decoded_as_utf8() {
    let mut bytes = [0u8; DEVICE_NAME_LEN];
    let name = "sdk_gphone64_arm64";
    bytes[..name.len()].copy_from_slice(name.as_bytes());
    assert_eq!(device_name(&bytes), name);
    // Whatever follows the first NUL is ignored.
    bytes[name.len() + 1] = b'x';
    assert_eq!(device_name(&bytes), name);
    // Invalid UTF-8 decodes as the replacement character, as `toString("utf8")` does.
    let mut broken = [0u8; DEVICE_NAME_LEN];
    broken[0] = 0xff;
    broken[1] = b'k';
    assert_eq!(device_name(&broken), "\u{fffd}k");
}
