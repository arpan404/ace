// SPDX-License-Identifier: Apache-2.0
//! Delivery through the engine: what a view's connection gets, what the producer is asked
//! for, and what pausing and the main session's round trip change.
use super::*;
use crate::engine::delivery::{MediaOut, VIDEO_SHARE, VIDEO_SHARE_CUT, next_media_id};
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
    assert_eq!((plan[0].width, plan[0].height), (1170, 2532));
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

#[test]
fn a_keyframe_queued_behind_a_full_window_keeps_its_bytes_however_many_deltas_follow() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let video = |effects: &[Effect]| {
        let mut assembler = Assembler::new();
        binaries(effects)
            .iter()
            .filter_map(|p| {
                let envelope = assembler.push(p).ok().flatten()?;
                let v = media_core::headers::decode_video(envelope.meta, envelope.payload).ok()?;
                Some((v.sequence as u64, v.key, envelope.payload[5]))
            })
            .collect::<Vec<_>>()
    };
    let mut first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    for n in 1..60 {
        first.extend(ingest(&mut engine, 1, h264(false, n, 1, Vec::new()), NOW));
    }
    let sent = video(&first);
    assert_eq!(sent.len(), 60, "the window is full");
    // A keyframe now waits in the queue, then far more deltas than any fixed holding area.
    let mut later = ingest(&mut engine, 1, h264(true, 100, 1, Vec::new()), NOW);
    for n in 101..200u8 {
        later.extend(ingest(&mut engine, 1, h264(false, n, 1, Vec::new()), NOW));
    }
    assert!(video(&later).is_empty(), "nothing fits until an ack");
    let last = sent.last().map_or(0, |s| s.0);
    engine.media_message(
        CONNECTION,
        &json!({ "type": "browser.ack", "threadId": "t1", "sequence": last, "video": true })
            .to_string(),
        NOW,
    );
    let after = video(&engine.effects().collect::<Vec<_>>());
    // The first thing sent is the queued keyframe, with its own bytes.
    assert_eq!(
        after.first().map(|s| (s.1, s.2)),
        Some((true, 100)),
        "{after:?}"
    );
}

/// Bytes a view gets of `units` deltas of `size` bytes after a keyframe, with no ack.
fn sent_before_an_ack(engine: &mut Engine, units: u8, size: usize) -> usize {
    let mut key = h264(true, 0, 1, Vec::new());
    key.payload.resize(size, 0);
    let mut effects = ingest(engine, 1, key, NOW);
    for n in 1..units {
        let mut delta = h264(false, n, 1, Vec::new());
        delta.payload.resize(size, n);
        effects.extend(ingest(engine, 1, delta, NOW));
    }
    binaries(&effects).iter().map(Vec::len).sum()
}

fn inflate(engine: &mut Engine) -> Vec<Effect> {
    for (n, rtt) in [(0, 300), (1, 300)] {
        send(
            engine,
            json!({ "type": "session.link", "session": "s1", "rttMs": rtt, "backlogBytes": 0 }),
            &[],
            at(2_000 + n * 500),
        );
    }
    send(
        engine,
        json!({ "type": "session.link", "session": "s1", "rttMs": 900, "backlogBytes": 400_000 }),
        &[],
        at(3_000),
    )
}

#[test]
fn delivery_holds_a_view_to_its_share_of_the_link_and_less_while_its_session_inflates() {
    // A remote view starts at 1.5 Mbit/s: 70 % of it over the round trip and slack is a few
    // 20 KB units in flight, not the whole 60-unit window.
    let mut calm = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let calm_bytes = sent_before_an_ack(&mut calm, 30, 20_000);
    assert!(calm_bytes < 30 * 20_000 / 3, "{calm_bytes} bytes in flight");
    // The same view while its main session's round trip inflates gets about half that.
    let mut busy = watched(json!({ "kind": "browser", "threadId": "t1" }));
    inflate(&mut busy);
    let busy_bytes = sent_before_an_ack(&mut busy, 30, 20_000);
    assert!(busy_bytes < calm_bytes, "{busy_bytes} vs {calm_bytes}");
}

#[test]
fn the_wanted_bit_rate_follows_the_share_below_the_planners_floor_down_to_150_kbits() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // A 3G hint: 400 kbit/s, so 70 % of it is 280 kbit/s, under the planner's 500 kbit/s.
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v1", "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 3, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": false, "audio": false, "link": { "downlinkKbps": 400 } }),
        &[],
        NOW,
    );
    let first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    let Some(plan) = wants(&first).pop() else {
        panic!("no plan");
    };
    assert_eq!(plan[0].bitrate, 280_000);
    let cut = wants(&inflate(&mut engine)).pop();
    // 35 % of 400 kbit/s is 140 kbit/s: held at the 150 kbit/s floor.
    assert_eq!(cut.map(|w| w[0].bitrate), Some(150_000));
}

#[test]
fn one_connection_holds_one_view_of_a_target_and_acks_reach_it() {
    // A client can't tell two views of one thread on one connection apart (their pieces name the
    // same thread), so a second grant for the same connection and target replaces the first.
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v2", "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 3, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": false, "audio": false }),
        &[],
        NOW,
    );
    assert_eq!(engine.counts().viewers, 1);
    let mut effects = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    for n in 1..80 {
        effects.extend(ingest(&mut engine, 1, h264(false, n, 1, Vec::new()), NOW));
    }
    let first = binaries(&effects).len();
    // Each unit goes once: never twice for two views of the same thread.
    assert!(first <= 60, "{first} pieces");
    // An ack frees the one view's window.
    engine.media_message(
        CONNECTION,
        &json!({ "type": "browser.ack", "threadId": "t1", "sequence": first, "video": true })
            .to_string(),
        NOW,
    );
    let mut later = ingest(&mut engine, 1, h264(true, 90, 1, Vec::new()), NOW);
    later.extend(engine.effects());
    assert!(
        !binaries(&later).is_empty(),
        "the acked view takes the next keyframe"
    );
}

#[test]
fn a_keyframe_past_the_coupled_cap_still_goes_once_and_the_producer_is_asked_for_less() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // A 400 kbit/s link: video's share is 280 kbit/s, so a keyframe should be at most about
    // half a second of it, 17.5 KB.
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v1", "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 3, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": false, "audio": false, "link": { "downlinkKbps": 400 } }),
        &[],
        NOW,
    );
    let first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    let Some(before) = wants(&first).pop() else {
        panic!("no plan");
    };
    // The first is acked: the window is empty.
    engine.media_message(
        CONNECTION,
        &json!({ "type": "browser.ack", "threadId": "t1", "sequence": 1, "video": true })
            .to_string(),
        NOW,
    );
    engine.effects().for_each(drop);
    // The producer sends a 500 KB keyframe all the same.
    let mut big = h264(true, 1, 1, Vec::new());
    big.payload.resize(500_000, 1);
    let effects = ingest(&mut engine, 1, big, NOW);
    // An empty window takes it, so nothing deadlocks...
    assert!(
        !binaries(&effects).is_empty(),
        "the oversized keyframe still went"
    );
    // ...and the producer is reconfigured to make smaller ones.
    let Some(after) = wants(&effects).pop() else {
        panic!("the producer was not asked for less");
    };
    assert!(
        after[0].bitrate < before[0].bitrate,
        "{} vs {}",
        after[0].bitrate,
        before[0].bitrate
    );
    assert!(after[0].bitrate >= 150_000, "never below the floor");
}

#[test]
fn a_late_ack_from_a_replaced_view_releases_nothing_of_its_successor() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let mut first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    for n in 1..5 {
        first.extend(ingest(&mut engine, 1, h264(false, n, 1, Vec::new()), NOW));
    }
    // The client resubscribes: a new view of the same target on the same connection.
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v2", "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 3, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": true, "audio": false }),
        &[],
        NOW,
    );
    // Exactly a full window: 60 units in flight, none dropped.
    let mut fill = ingest(&mut engine, 1, h264(true, 10, 1, Vec::new()), NOW);
    for n in 11..70 {
        fill.extend(ingest(&mut engine, 1, h264(false, n, 1, Vec::new()), NOW));
    }
    let sent = binaries(&fill).len();
    assert_eq!(sent, 60, "a full window");
    // The old view's last ack arrives late: sequences 1 to 5 were its own, never the new view's.
    engine.media_message(
        CONNECTION,
        &json!({ "type": "browser.ack", "threadId": "t1", "sequence": 5, "video": true })
            .to_string(),
        NOW,
    );
    let mut after: Vec<Effect> = engine.effects().collect();
    // The next unit still finds the window full: it waits for the new view's own acks.
    after.extend(ingest(&mut engine, 1, h264(false, 70, 1, Vec::new()), NOW));
    assert!(
        binaries(&after).is_empty(),
        "a stale ack opened the new view's window"
    );
}

/// A `viewer.open` of the browser tab `t1` on the test connection, as the daemon sends it.
fn open_view(engine: &mut Engine, viewer: &str, issued: u64) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "viewer.open", "viewer": viewer, "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": issued, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": false, "audio": false }),
        &[],
        NOW,
    )
}

#[test]
fn a_view_its_successor_replaced_opens_again_under_its_id_and_delivers_from_a_keyframe() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    assert!(!binaries(&ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW)).is_empty());
    // A resubscribe's view replaces v1, then its setup fails in the daemon: it closes, and the
    // daemon regrants v1.
    open_view(&mut engine, "v2", 3);
    send(
        &mut engine,
        json!({ "type": "viewer.close", "viewer": "v2" }),
        &[],
        NOW,
    );
    let reopened = open_view(&mut engine, "v1", 4);
    assert_eq!(
        keyframes(&reopened),
        1,
        "the regranted view asks for a keyframe"
    );
    // It waits for that keyframe, then delivers.
    assert!(binaries(&ingest(&mut engine, 1, h264(false, 1, 1, Vec::new()), NOW)).is_empty());
    assert!(!binaries(&ingest(&mut engine, 1, h264(true, 2, 1, Vec::new()), NOW)).is_empty());
}

#[test]
fn a_new_encode_never_takes_an_id_whose_units_may_still_be_on_the_way() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    let Some(before) = wants(&first).pop() else {
        panic!("no plan");
    };
    // The pane changes size: a new encode replaces the old one at once.
    let resized = send(
        &mut engine,
        json!({ "type": "viewer.configure", "viewer": "v1",
                "viewport": { "width": 200, "height": 300, "dpr": 1, "scale": 1 },
                "audio": false }),
        &[],
        at(1_100),
    );
    let Some(after) = wants(&resized).pop() else {
        panic!("no new plan");
    };
    // Units of the old encode may still be queued at the producer: its successor gets another.
    assert_ne!(after[0].id, before[0].id);
}

#[test]
fn ace_medias_encode_ids_stay_in_1_to_2_pow_20_never_the_daemons() {
    let end = 1 << 20;
    // Every id a plan gives, from a source's first: 0 stays unplanned (a producer that ignores
    // the plan stamps it), and 2^20 up are the daemon's.
    let mut engine = engine();
    open_tab(&mut engine, "s1", 1, 3);
    hello(&mut engine, 1, 3);
    ticket(&mut engine, CONNECTION, owner("phone", pairing(1)), 1, 9);
    assert!(engine.claim_ticket(&[9; 32], NOW).is_some());
    let mut effects = open_view(&mut engine, "v1", 2);
    effects.extend(ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW));
    let ids: Vec<u32> = wants(&effects).iter().flatten().map(|e| e.id).collect();
    assert!(!ids.is_empty());
    assert!(ids.iter().all(|id| (1..end).contains(id)), "{ids:?}");
    // The last id in range, then back to the first, past the ones in use.
    assert_eq!(next_media_id(end - 1, |_| false), (end - 1, 1));
    assert_eq!(next_media_id(1, |id| id < 4), (4, 5));
    // A next id outside the range starts it over.
    assert_eq!(next_media_id(0, |_| false), (1, 2));
    assert_eq!(next_media_id(end, |_| false), (1, 2));
    assert_eq!(next_media_id(u32::MAX, |id| id == 1), (2, 3));
}
