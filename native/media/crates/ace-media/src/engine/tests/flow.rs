// SPDX-License-Identifier: Apache-2.0
//! The window: acks, a view that stops taking pictures, keyframe requests and the
//! bytes a view may have in flight.
use super::*;
use crate::engine::delivery::VIDEO_SHARE;
use media_core::envelope::Assembler;

fn device_ack(engine: &mut Engine, sequence: u64, keyframe: bool, mono_ms: u64) {
    let text = if keyframe {
        json!({ "type": "devices.ack", "deviceId": "ios:03DDE173", "streamId": "s1",
                "sequence": sequence, "keyframe": true })
        .to_string()
    } else {
        json!({ "type": "devices.ack", "deviceId": "ios:03DDE173", "streamId": "s1",
                "sequence": sequence })
        .to_string()
    };
    engine.media_message(CONNECTION, &text, at(mono_ms));
}

/// A device view of `s1`, acknowledged once and then quiet: its window fills and its chunks go
/// past their deadline (the last ack at 1_010 ms).
fn quiet_device_view(engine: &mut Engine) {
    let mut effects = ingest(engine, 1, h264(true, 0, 1, Vec::new()), at(1_000));
    for n in 1..5 {
        effects.extend(ingest(engine, 1, h264(false, n, 1, Vec::new()), at(1_000)));
    }
    let sent = binaries(&effects).len();
    device_ack(engine, sent as u64, false, 1_010);
    engine.effects().for_each(drop);
    for n in 5..80u8 {
        ingest(engine, 1, h264(false, n, 1, Vec::new()), at(1_100));
    }
    engine.effects().for_each(drop);
}

#[test]
fn a_device_view_that_stops_acking_parks_instead_of_asking_for_keyframes_for_ever() {
    let mut engine = watched(json!({ "kind": "device", "deviceId": "ios:03DDE173" }));
    quiet_device_view(&mut engine);
    // Past the chunks' deadline, and past the silence a live view never has: nothing asks the
    // source for a keyframe the quiet view could never take.
    engine.tick(at(6_200));
    let first = keyframes(&engine.effects().collect::<Vec<_>>());
    assert!(
        first <= 1,
        "at most the keyframe it asked for before it parked"
    );
    let mut asked = 0;
    for step in 0..6u64 {
        engine.tick(at(7_200 + step * 1_000));
        asked += keyframes(&engine.effects().collect::<Vec<_>>());
    }
    assert_eq!(asked, 0, "a parked view asks for no keyframes");
    assert_eq!(engine.counts().viewers, 1, "parked, not closed");
    // And its drops stop with it: the window is not refilled only to expire again.
    let mut stats: Vec<u64> = Vec::new();
    for step in 0..6u64 {
        engine.tick(at(13_000 + step * 1_000));
        for effect in engine.effects() {
            if let Effect::Normal(FromMedia::ViewerStats { dropped, .. }) = effect {
                stats.push(dropped.get());
            }
        }
    }
    assert!(stats.len() >= 5, "{stats:?}");
    assert_eq!(
        stats.first(),
        stats.last(),
        "a parked view drops nothing more"
    );
    // And nothing more goes to it, not even a keyframe.
    let mut later = ingest(&mut engine, 1, h264(true, 100, 1, Vec::new()), at(19_500));
    later.extend(engine.effects());
    assert!(binaries(&later).is_empty(), "a parked view is sent nothing");
}

#[test]
fn an_ack_resumes_a_parked_device_view_at_a_fresh_keyframe() {
    let mut engine = watched(json!({ "kind": "device", "deviceId": "ios:03DDE173" }));
    quiet_device_view(&mut engine);
    engine.tick(at(6_200));
    engine.effects().for_each(drop);
    // The view came back (its page shown again, a decoder asking for a keyframe): it is owed one.
    device_ack(&mut engine, 40, true, 6_500);
    let resumed = engine.effects().collect::<Vec<_>>();
    assert_eq!(keyframes(&resumed), 1, "a resumed view is owed a keyframe");
    let mut after = ingest(&mut engine, 1, h264(true, 120, 1, Vec::new()), at(6_600));
    after.extend(engine.effects());
    assert_eq!(binaries(&after).len(), 1, "the keyframe reaches it");
}

#[test]
fn a_device_view_that_never_acks_is_asked_for_a_few_keyframes_then_left_to_the_source() {
    let mut engine = watched(json!({ "kind": "device", "deviceId": "ios:03DDE173" }));
    // It takes pictures and acks none of them: its window fills and its chunks go past their
    // deadline. Its source is asked a few times, then left to its own cadence.
    for n in 0..80u8 {
        ingest(&mut engine, 1, h264(n == 0, n, 1, Vec::new()), at(1_000));
    }
    engine.effects().for_each(drop);
    for step in 0..3u64 {
        engine.tick(at(6_200 + step * 1_000));
        engine.effects().for_each(drop);
    }
    let mut asked = 0;
    for step in 0..6u64 {
        engine.tick(at(9_200 + step * 1_000));
        asked += keyframes(&engine.effects().collect::<Vec<_>>());
    }
    assert_eq!(
        asked, 0,
        "a view that takes nothing is asked for nothing more"
    );
    assert_eq!(engine.counts().viewers, 1, "not closed either");
    // A keyframe the source makes on its own still reaches it.
    let mut later = ingest(&mut engine, 1, h264(true, 200, 1, Vec::new()), at(15_000));
    later.extend(engine.effects());
    assert_eq!(binaries(&later).len(), 1, "the source's own keyframe goes");
}

#[test]
fn a_parked_view_does_not_hold_another_view_of_its_source_back() {
    // Two devices are shown on one connection: one stops acking, the other keeps up.
    let mut engine = watched(json!({ "kind": "device", "deviceId": "ios:03DDE173" }));
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v2", "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 3, "source": "s1",
                "target": { "kind": "device", "deviceId": "android:emulator-5554" },
                "codecs": ["avc1.42E033"],
                "viewport": { "width": 402, "height": 874, "dpr": 3, "scale": 1 },
                "local": true, "audio": false }),
        &[],
        NOW,
    );
    assert_eq!(engine.counts().viewers, 2);
    engine.effects().for_each(drop);
    quiet_device_view(&mut engine);
    engine.tick(at(6_200));
    engine.effects().for_each(drop);
    // The quiet view is parked; the other asks for a keyframe and acks each picture after it.
    engine.media_message(
        CONNECTION,
        &json!({ "type": "devices.ack", "deviceId": "android:emulator-5554",
                 "streamId": "s1", "sequence": 1, "keyframe": true })
        .to_string(),
        at(6_400),
    );
    engine.effects().for_each(drop);
    let mut got = 0;
    for n in 80..140u8 {
        let effects = ingest(&mut engine, 1, h264(n == 80, n, 1, Vec::new()), at(6_500));
        got += binaries(&effects).len();
        engine.media_message(
            CONNECTION,
            &json!({ "type": "devices.ack", "deviceId": "android:emulator-5554",
                     "streamId": "s1", "sequence": n })
            .to_string(),
            at(6_500),
        );
        engine.effects().for_each(drop);
    }
    assert_eq!(got, 60, "the acking view gets every picture");
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

#[test]
fn a_views_bytes_in_flight_cover_its_round_trip_and_one_tail_loss_stall() {
    // ADR 0150 on the ace-media path: on a 300 ms path a tail-loss stall holds acks for about
    // 800 ms, so a view's share of the link over RTT + max(300 ms, RTT + 200 ms) stays in
    // flight, not over RTT + 300 ms (which would drop the next delta and break the chain).
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let mut acks: std::collections::VecDeque<(u64, u64)> = std::collections::VecDeque::new();
    let mut now = 1_000;
    for n in 0..30_u64 {
        while acks.front().is_some_and(|(due, _)| *due <= now) {
            let Some((due, sequence)) = acks.pop_front() else {
                break;
            };
            engine.media_message(
                CONNECTION,
                &json!({ "type": "browser.ack", "threadId": "t1", "sequence": sequence,
                         "video": true })
                .to_string(),
                at(due),
            );
        }
        let mut unit = h264(n == 0, n as u8, 1, Vec::new());
        unit.payload.resize(1_000, 0);
        engine.ingest(1, unit, at(now));
        acks.push_back((now + 300, n + 1));
        now += 66;
    }
    for (due, sequence) in acks.drain(..) {
        engine.media_message(
            CONNECTION,
            &json!({ "type": "browser.ack", "threadId": "t1", "sequence": sequence, "video": true })
                .to_string(),
            at(due),
        );
        now = now.max(due);
    }
    engine.effects().for_each(drop);
    engine.tick(at(now));
    let (rate, rtt) = engine
        .effects()
        .find_map(|e| match e {
            Effect::Normal(FromMedia::ViewerStats { rate, rtt_ms, .. }) => {
                Some((f64::from(rate), rtt_ms.get()))
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("no stats"));
    // Now the acks stop: everything the view may have in flight goes out.
    let mut sent = 0;
    for n in 0..55_u8 {
        let mut unit = h264(false, n, 1, Vec::new());
        unit.payload.resize(2_000, n);
        sent += binaries(&ingest(&mut engine, 1, unit, at(now)))
            .iter()
            .map(Vec::len)
            .sum::<usize>();
    }
    let share = rate * VIDEO_SHARE / 8.0 / 1000.0;
    let old = share * (rtt + 300.0);
    let adr_0150 = share * (rtt + (rtt + 200.0).max(300.0));
    assert!(
        sent as f64 > old + 2_000.0,
        "{sent} bytes vs RTT + 300 ms: {old}"
    );
    assert!(
        sent as f64 <= adr_0150 + 4_000.0,
        "{sent} bytes vs ADR 0150: {adr_0150}"
    );
}

/// `v1`'s view of `t1` opened again on the same connection, as a subscribe again does.
fn open_again(engine: &mut Engine, viewer: &str, now: Now) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "viewer.open", "viewer": viewer, "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 3, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": false, "audio": false }),
        &[],
        now,
    )
}

#[test]
fn a_view_opened_again_soon_after_on_a_still_source_has_its_keyframe_asked_for_once_the_spacing_ends()
 {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // The producer's keyframe, which the first view plays; nothing moves on screen after it.
    ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    // The viewer subscribes again 50 ms later: its new view needs a keyframe, inside the spacing.
    let soon = open_again(&mut engine, "v2", at(NOW.mono_ms + 50));
    assert_eq!(keyframes(&soon), 0, "spaced");
    engine.tick(at(NOW.mono_ms + 150));
    assert_eq!(keyframes(&engine.effects().collect::<Vec<_>>()), 0);
    // Once the spacing ends it is asked for, and only once.
    engine.tick(at(NOW.mono_ms + 300));
    assert_eq!(keyframes(&engine.effects().collect::<Vec<_>>()), 1);
    engine.tick(at(NOW.mono_ms + 600));
    assert_eq!(keyframes(&engine.effects().collect::<Vec<_>>()), 0);
}

#[test]
fn a_spaced_keyframe_request_goes_unasked_when_the_producers_own_keyframe_comes_first() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    engine.effects().for_each(drop);
    ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    open_again(&mut engine, "v2", at(NOW.mono_ms + 50));
    // A moving source's next keyframe came before the spacing ended: nothing is owed.
    ingest(
        &mut engine,
        1,
        h264(true, 1, 1, Vec::new()),
        at(NOW.mono_ms + 100),
    );
    engine.tick(at(NOW.mono_ms + 300));
    assert_eq!(keyframes(&engine.effects().collect::<Vec<_>>()), 0);
}
