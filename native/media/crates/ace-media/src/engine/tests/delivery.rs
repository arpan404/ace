// SPDX-License-Identifier: Apache-2.0
//! Delivery through the engine: what a view's connection gets, what the producer is asked
//! for, and what pausing and the main session's round trip change.
use super::*;
use crate::engine::delivery::{MediaOut, VIDEO_SHARE, VIDEO_SHARE_CUT};
use media_core::envelope::Assembler;
use media_core::headers::decode_picture;
use media_wire::control::EncodeSpec;

const CONNECTION: &str = "mc_test";

/// An engine with source `s1` (handle 1, producer connection 1) and an open media connection.
fn watched(target: Value) -> Engine {
    let mut engine = engine();
    open_tab(&mut engine, "s1", 1, 3);
    hello(&mut engine, 1, 3);
    ticket(&mut engine, CONNECTION, owner("phone", pairing(1)), 1, 9);
    assert!(engine.claim_ticket(&[9; 32], NOW).is_some());
    engine.effects().for_each(drop);
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v1", "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 2, "source": "s1",
                "target": target, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": false, "audio": false }),
        &[],
        NOW,
    );
    engine
}

fn binaries(effects: &[Effect]) -> Vec<Vec<u8>> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Media {
                out: MediaOut::Binary(bytes),
                ..
            } => Some(bytes.clone()),
            _ => None,
        })
        .collect()
}

fn wants(effects: &[Effect]) -> Vec<Vec<EncodeSpec>> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::Normal(FromMedia::SourceWant { encodes, .. }) => Some(encodes.clone()),
            _ => None,
        })
        .collect()
}

fn keyframes(effects: &[Effect]) -> usize {
    effects
        .iter()
        .filter(|e| matches!(e, Effect::Normal(FromMedia::SourceKeyframe { .. })))
        .count()
}

fn h264(key: bool, n: u8, codec: u8, description: Vec<u8>) -> MediaFrame {
    let mut unit = frame(1, u32::from(key), 1, Vec::new());
    unit.encode = 0;
    unit.width = 1170;
    unit.height = 2532;
    unit.display_width = 390;
    unit.display_height = 844;
    unit.scale = 3000;
    unit.codec = codec;
    unit.codec_string = "avc1.42E033".into();
    unit.description = description;
    unit.payload = if codec == 2 {
        vec![0, 0, 0, 2, if key { 0x65 } else { 0x41 }, n]
    } else {
        vec![0, 0, 0, 1, if key { 0x65 } else { 0x41 }, n]
    };
    unit
}

#[test]
fn a_device_view_gets_annex_b_pictures_with_parameter_sets_on_keyframes() {
    let mut engine = watched(json!({ "kind": "device", "deviceId": "android:emulator-5554" }));
    // A length-prefixed unit, as the Simulator's reader gives one, with its avcC.
    let sps = vec![0x67, 0x42, 0xc0, 0x1f, 0xaa];
    let pps = vec![0x68, 0xce, 0x3c, 0x80];
    let mut avcc = vec![1, 0x42, 0xc0, 0x1f, 0xff, 0xe1];
    avcc.extend_from_slice(&(sps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&sps);
    avcc.push(1);
    avcc.extend_from_slice(&(pps.len() as u16).to_be_bytes());
    avcc.extend_from_slice(&pps);
    let effects = ingest(&mut engine, 1, h264(true, 7, 2, avcc), NOW);
    let pieces = binaries(&effects);
    let mut assembler = Assembler::new();
    let envelope = pieces.iter().find_map(|p| {
        assembler
            .push(p)
            .ok()
            .flatten()
            .map(|e| (e.kind, e.meta.to_vec(), e.payload.to_vec()))
    });
    let Some((kind, meta, payload)) = envelope else {
        panic!("no picture reached the device view");
    };
    assert_eq!(kind, 4);
    let Ok(picture) = decode_picture(4, &meta, &payload) else {
        panic!("a header the client can't read");
    };
    assert_eq!(picture.source_id, "android:emulator-5554");
    assert!(picture.key);
    let mut expected = vec![0, 0, 0, 1];
    expected.extend_from_slice(&sps);
    expected.extend_from_slice(&[0, 0, 0, 1]);
    expected.extend_from_slice(&pps);
    expected.extend_from_slice(&[0, 0, 0, 1, 0x65, 7]);
    assert_eq!(payload, expected);
}

#[test]
fn a_paused_view_gets_no_bytes_and_starts_again_at_a_keyframe() {
    let mut engine = watched(json!({ "kind": "screen", "sessionId": "screen-1" }));
    assert_eq!(
        binaries(&ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW)).len(),
        1
    );
    send(
        &mut engine,
        json!({ "type": "viewer.pause", "viewer": "v1" }),
        &[],
        at(1_100),
    );
    assert!(
        binaries(&ingest(
            &mut engine,
            1,
            h264(false, 1, 1, Vec::new()),
            at(1_200)
        ))
        .is_empty()
    );
    assert!(
        binaries(&ingest(
            &mut engine,
            1,
            h264(true, 2, 1, Vec::new()),
            at(1_300)
        ))
        .is_empty()
    );
    let resumed = send(
        &mut engine,
        json!({ "type": "viewer.resume", "viewer": "v1" }),
        &[],
        at(1_400),
    );
    assert_eq!(keyframes(&resumed), 1, "a resume asks for a keyframe");
    // Deltas before that keyframe are of no use to a decoder that skipped the pause.
    assert!(
        binaries(&ingest(
            &mut engine,
            1,
            h264(false, 3, 1, Vec::new()),
            at(1_500)
        ))
        .is_empty()
    );
    assert_eq!(
        binaries(&ingest(
            &mut engine,
            1,
            h264(true, 4, 1, Vec::new()),
            at(1_600)
        ))
        .len(),
        1
    );
}

#[test]
fn the_plan_is_the_viewers_size_and_its_bit_rate_halves_while_the_session_round_trip_inflates() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    let Some(plan) = wants(&first).pop() else {
        panic!("the first unit's size plans the view");
    };
    assert_eq!(plan.len(), 1);
    assert_eq!((plan[0].id, plan[0].width, plan[0].height), (0, 1170, 2532));
    let calm = plan[0].bitrate;
    for (n, rtt) in [(0, 300), (1, 310), (2, 305)] {
        let quiet = send(
            &mut engine,
            json!({ "type": "session.link", "session": "s1", "rttMs": rtt, "backlogBytes": 0 }),
            &[],
            at(2_000 + n * 500),
        );
        assert!(
            wants(&quiet).is_empty(),
            "a steady round trip changes nothing"
        );
    }
    let inflated = send(
        &mut engine,
        json!({ "type": "session.link", "session": "s1", "rttMs": 900, "backlogBytes": 400_000 }),
        &[],
        at(4_000),
    );
    let Some(cut) = wants(&inflated).pop() else {
        panic!("an inflating round trip cuts video's share");
    };
    let ratio = f64::from(cut[0].bitrate) / f64::from(calm);
    let expected = VIDEO_SHARE_CUT / VIDEO_SHARE;
    assert!(
        (ratio - expected).abs() < 0.05 || cut[0].bitrate == 500_000,
        "{ratio}"
    );
    let settled = send(
        &mut engine,
        json!({ "type": "session.link", "session": "s1", "rttMs": 310, "backlogBytes": 0 }),
        &[],
        at(4_500),
    );
    assert_eq!(
        wants(&settled).pop().map(|w| w[0].bitrate),
        Some(calm),
        "climbs back"
    );
}

#[test]
fn a_closed_connection_closes_its_socket_with_its_reason_and_its_views_go() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let effects = send(
        &mut engine,
        json!({ "type": "connection.close", "id": "c1", "connection": CONNECTION,
                "reason": "session-closed" }),
        &[],
        NOW,
    );
    assert!(effects.iter().any(|e| matches!(
        e,
        Effect::Media {
            out: MediaOut::Close(4410),
            ..
        }
    )));
    assert!(binaries(&ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW)).is_empty());
    assert_eq!(engine.counts().viewers, 0);
}

#[test]
fn a_view_takes_the_nearest_encode_a_producer_sends_when_it_doesnt_follow_the_plan() {
    let mut engine = watched(json!({ "kind": "screen", "sessionId": "screen-1" }));
    // The producer still runs the daemon's own encodes: ids 3 and 4, at two sizes.
    let mut small = h264(true, 1, 1, Vec::new());
    small.encode = 3;
    small.width = 390;
    small.height = 844;
    let mut large = h264(true, 2, 1, Vec::new());
    large.encode = 4;
    large.codec_string = "avc1.640033".into();
    ingest(&mut engine, 1, small.clone(), NOW);
    let first = ingest(&mut engine, 1, large.clone(), NOW);
    // The plan wants 1170 × 2532 for a 390-point-wide phone at 3×: the large one, whose
    // profile differs from the one the viewer named but whose family it decodes.
    assert_eq!(binaries(&first).len(), 1);
    small.flags = 0;
    assert!(binaries(&ingest(&mut engine, 1, small, at(1_100))).is_empty());
    large.flags = 0;
    assert_eq!(binaries(&ingest(&mut engine, 1, large, at(1_100))).len(), 1);
}

#[test]
fn a_piece_carries_the_units_capture_time_on_the_wall_clock() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let stamped = |unit: &mut MediaFrame, at: f64| {
        let mut extension = vec![0, 1, 0, 24];
        extension.extend_from_slice(&7u64.to_be_bytes());
        extension.extend_from_slice(&at.to_be_bytes());
        extension.extend_from_slice(&1.0f64.to_be_bytes());
        unit.extension = extension;
    };
    let timestamp = |effects: &[Effect]| {
        let mut assembler = Assembler::new();
        binaries(effects).iter().find_map(|p| {
            let envelope = assembler.push(p).ok().flatten()?;
            media_core::headers::decode_video(envelope.meta, envelope.payload)
                .ok()
                .map(|v| v.timestamp)
        })
    };
    let mut key = h264(true, 0, 1, Vec::new());
    stamped(&mut key, 1_700_000_000_123.5);
    assert_eq!(
        timestamp(&ingest(&mut engine, 1, key, NOW)),
        Some(1_700_000_000_123.5)
    );
    // Without a stamp: the wall clock less the unit's age.
    let mut delta = h264(false, 1, 1, Vec::new());
    delta.age_us = 20_000;
    assert_eq!(
        timestamp(&ingest(&mut engine, 1, delta, NOW)),
        Some(NOW.wall_ms as f64 - 20.0)
    );
}
