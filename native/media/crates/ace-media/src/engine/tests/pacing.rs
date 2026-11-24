// SPDX-License-Identifier: Apache-2.0
//! The link: a view's share of it, the bit-rate cuts a keyframe causes, and how a
//! local view is paced apart from a remote one.
use super::*;
use crate::engine::delivery::{VIDEO_SHARE, VIDEO_SHARE_CUT};

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
    // A remote view starts at 1.5 Mbit/s: 70 % of it over ADR 0150's time (a 1 s round trip
    // before one is measured, so 2.2 s) is about 290 KB of 20 KB units in flight, not the whole
    // 60-unit window.
    let mut calm = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let calm_bytes = sent_before_an_ack(&mut calm, 30, 20_000);
    let share = 1_500_000.0 * VIDEO_SHARE / 8.0 * 2.2;
    assert!(
        calm_bytes as f64 <= share + 20_000.0,
        "{calm_bytes} bytes in flight"
    );
    assert!(calm_bytes < 30 * 20_000 / 2, "{calm_bytes} bytes in flight");
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

/// The bit rate the producer is asked for after one 25 KB keyframe (a little over the 17.5 KB
/// cap of a 400 kbit/s link, so its cut stays clear of the floors), with `views` views (one per
/// connection, all alike) sharing its encode.
fn asked_after_an_oversized_keyframe(views: usize) -> u32 {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    let connections = ["mc_test", "mc_two", "mc_three"];
    for (n, connection) in connections.iter().enumerate().take(views) {
        let issued = 3 + 2 * n as u64;
        if n > 0 {
            let token = 20 + n as u8;
            ticket(
                &mut engine,
                connection,
                owner("phone", pairing(1)),
                issued,
                token,
            );
            assert!(engine.claim_ticket(&[token; 32], NOW).is_some());
        }
        send(
            &mut engine,
            json!({ "type": "viewer.open", "viewer": format!("v{}", n + 1),
                    "connection": connection, "owner": owner("phone", pairing(1)),
                    "issued": issued + 1, "source": "s1",
                    "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                    "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                    "local": false, "audio": false, "link": { "downlinkKbps": 400 } }),
            &[],
            NOW,
        );
    }
    ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    for connection in connections.iter().take(views) {
        engine.media_message(
            connection,
            &json!({ "type": "browser.ack", "threadId": "t1", "sequence": 1, "video": true })
                .to_string(),
            NOW,
        );
    }
    engine.effects().for_each(drop);
    let mut big = h264(true, 1, 1, Vec::new());
    big.payload.resize(25_000, 1);
    let effects = ingest(&mut engine, 1, big, NOW);
    let Some(after) = wants(&effects).pop() else {
        panic!("the producer was not asked for less");
    };
    assert_eq!(after.len(), 1, "the views share one encode");
    assert!(
        after[0].bitrate > 150_000,
        "{views} views: at the floor ({})",
        after[0].bitrate
    );
    after[0].bitrate
}

#[test]
fn a_keyframe_cuts_its_shared_encode_once_however_many_views_take_it() {
    let one = asked_after_an_oversized_keyframe(1);
    assert_eq!(asked_after_an_oversized_keyframe(2), one);
    assert_eq!(asked_after_an_oversized_keyframe(3), one);
}

/// What one view got through a renderer that keeps up, stalls, and then catches up.
struct Stalled {
    /// Its rate as `viewer.stats` last reported it.
    rate: f64,
    /// Its losses, as `viewer.stats` counted them.
    dropped: u64,
    /// The bit rate of the last encode planned for it.
    planned: u32,
    /// Frames of the burst after the stalls that reached its connection, and how many went in.
    sent: usize,
    published: usize,
}

/// Drives one view of `t1` through: a renderer a millisecond behind (so the path's round trip
/// is 1 ms), five stalls where frames go unacked past their deadline and are let go as losses,
/// then a burst of a keyframe and twenty deltas with no acks. `local`: the view is on this
/// machine, as `viewer.open` says for the desktop app.
fn stalled(local: bool) -> Stalled {
    let mut engine = watched_view(
        json!({ "kind": "browser", "threadId": "t1" }),
        json!(["avc1.42E033"]),
        local,
    );
    let first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), at(1_000));
    let Some(plan) = wants(&first).pop() else {
        panic!("the first unit plans the view");
    };
    let mut planned = plan[0].bitrate;
    let mut now = 1_100;
    for n in 1..=10_u8 {
        // The renderer keeps up: every frame acked a millisecond after it went.
        ingest(&mut engine, 1, h264(n == 1, n, 1, Vec::new()), at(now));
        shown(&mut engine, at(now + 1));
        now += 50;
    }
    let mut effects = Vec::new();
    for cycle in 0..5_u8 {
        // A stall: a keyframe and five deltas, then nothing until well past the fanout's
        // deadline (a round trip plus a second's slack), so each tick lets them go as a loss.
        effects.extend(ingest(
            &mut engine,
            1,
            h264(true, 20 + cycle, 1, Vec::new()),
            at(now),
        ));
        for n in 1..=5_u8 {
            effects.extend(ingest(
                &mut engine,
                1,
                h264(false, 30 + cycle * 5 + n, 1, Vec::new()),
                at(now),
            ));
        }
        let stall = now + 3_000;
        while now < stall {
            now += 100;
            engine.tick(at(now));
        }
        effects.extend(engine.effects());
        // The client catches up, long after every chunk was due.
        shown(&mut engine, at(now));
        now += 100;
    }
    if let Some(last) = wants(&effects).pop() {
        planned = last[0].bitrate;
    }
    // The burst: what a busy renderer's backlog costs the picture.
    let mut sent = 0;
    let published = 21_usize;
    for n in 0..published {
        let mut unit = h264(n == 0, n as u8, 1, Vec::new());
        unit.payload.resize(2_000, n as u8);
        sent += binaries(&ingest(&mut engine, 1, unit, at(now))).len();
        now += 50;
    }
    effects.extend(engine.effects());
    engine.tick(at(now + 1_000));
    effects.extend(engine.effects());
    let (rate, dropped) = reported(&effects).unwrap_or_else(|| panic!("no stats"));
    Stalled {
        rate,
        dropped,
        planned,
        sent,
        published,
    }
}

#[test]
fn a_local_views_late_acks_keep_its_rate_and_every_frame_while_a_remote_views_cut() {
    let here = stalled(true);
    let remote = stalled(false);
    // A view on this machine is paced at the local rate from the first picture, whatever its
    // renderer does: 16 Mbit/s, which plans an encode at the picture's ceiling (~10.6 Mbit/s
    // for the test's 1170 x 2532 unit).
    assert_eq!(here.rate, 16_000_000.0, "the local view's rate");
    assert!(here.dropped > 0, "the local view lost chunks");
    assert!(
        here.planned >= 10_000_000,
        "the local view's plan: {}",
        here.planned
    );
    // Its bytes in flight stay at the local rate's backlog, so every frame of the burst went.
    assert_eq!(here.sent, here.published, "the local view got every frame");
    // The same late acks on a view over a real link cut it to the floor, and the plan shrinks
    // with it: the behaviour ADR 0149 asks for.
    assert!(
        remote.rate <= 300_000.0,
        "the remote view's rate: {}",
        remote.rate
    );
    assert!(
        remote.planned <= 500_000,
        "the remote view's plan: {}",
        remote.planned
    );
    assert!(
        remote.sent < remote.published,
        "the remote view's window: {} of {}",
        remote.sent,
        remote.published
    );
}

#[test]
fn a_local_views_stats_report_the_fixed_local_rate() {
    let mut engine = watched_view(
        json!({ "kind": "browser", "threadId": "t1" }),
        json!(["avc1.42E033"]),
        true,
    );
    ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), at(1_000));
    // Ten frames go unacked, then their acks arrive seconds late: on this machine that is a
    // busy renderer, not a congested link, so the reported rate never moves.
    for n in 1..=10_u8 {
        ingest(
            &mut engine,
            1,
            h264(n == 1, n, 1, Vec::new()),
            at(1_000 + u64::from(n) * 50),
        );
    }
    engine.tick(at(5_000));
    let mut effects: Vec<Effect> = engine.effects().collect();
    shown(&mut engine, at(6_000));
    engine.tick(at(7_000));
    effects.extend(engine.effects());
    let (rate, dropped) = reported(&effects).unwrap_or_else(|| panic!("no stats"));
    assert!(dropped > 0, "the chunks went unacked past their deadline");
    assert_eq!(rate, 16_000_000.0);
}

#[test]
fn a_local_views_oversized_keyframe_leaves_its_bitrate_alone() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // A local viewer (loopback carries far more than the 8 Mbit/s estimate): the keyframe
    // cap, which protects slow links, must not cut its still picture blurry.
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v1", "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 3, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": true, "audio": false }),
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
    // A 500 KB keyframe: over half a second even of the local share (5.6 Mbit/s -> ~350 KB
    // cap), but loopback is not a slow link, so it still goes and the producer is not
    // asked for less.
    let mut big = h264(true, 1, 1, Vec::new());
    big.payload.resize(500_000, 1);
    let effects = ingest(&mut engine, 1, big, NOW);
    assert!(!binaries(&effects).is_empty(), "the keyframe still went");
    let after = wants(&effects).pop();
    assert!(
        after
            .as_ref()
            .is_none_or(|w| w[0].bitrate == before[0].bitrate),
        "a local-only encode is not cut: {after:?} vs {before:?}"
    );
}

#[test]
fn a_remote_viewer_leaving_clears_its_shared_encodes_cut_for_the_local_left() {
    let mut engine = watched(json!({ "kind": "browser", "threadId": "t1" }));
    // The local view alone: planned at its own share.
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v1", "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": 3, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": true, "audio": false }),
        &[],
        NOW,
    );
    let first = ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW);
    let Some(alone) = wants(&first).pop() else {
        panic!("no plan");
    };
    // A remote viewer of the same page shares the encode, paced by its thin link.
    ticket(&mut engine, "mc_two", owner("phone", pairing(1)), 5, 21);
    assert!(engine.claim_ticket(&[21; 32], NOW).is_some());
    send(
        &mut engine,
        json!({ "type": "viewer.open", "viewer": "v2", "connection": "mc_two",
                "owner": owner("phone", pairing(1)), "issued": 6, "source": "s1",
                "target": { "kind": "browser", "threadId": "t1" }, "codecs": ["avc1.42E033"],
                "viewport": { "width": 390, "height": 844, "dpr": 3, "scale": 1 },
                "local": false, "audio": false, "link": { "downlinkKbps": 400 } }),
        &[],
        NOW,
    );
    // One delta so the remote view takes the shared encode too; a keyframe sized only
    // against the local view would never cut.
    let mut bump = h264(false, 9, 1, Vec::new());
    bump.payload.resize(1_000, 9);
    engine.effects().for_each(drop);
    let _ = ingest(&mut engine, 1, bump, NOW);
    engine.effects().for_each(drop);
    for (connection, sequence) in [(CONNECTION, 2), ("mc_two", 1)] {
        engine.media_message(
            connection,
            &json!({ "type": "browser.ack", "threadId": "t1", "sequence": sequence, "video": true })
                .to_string(),
            NOW,
        );
    }
    engine.effects().for_each(drop);
    // A 500 KB keyframe: over half a second of the shared encode's (remote-paced) share,
    // so the producer is asked for less while the remote view shares it.
    let mut big = h264(true, 1, 1, Vec::new());
    big.payload.resize(500_000, 1);
    let cut = ingest(&mut engine, 1, big, NOW);
    let Some(shared) = wants(&cut).pop() else {
        panic!("the shared encode was not cut");
    };
    assert!(
        shared[0].bitrate < alone[0].bitrate,
        "cut while shared: {} vs local-alone {}",
        shared[0].bitrate,
        alone[0].bitrate
    );
    // The remote viewer leaves: the local survivor's encode is no longer cut.
    let after = send(
        &mut engine,
        json!({ "type": "viewer.close", "viewer": "v2" }),
        &[],
        NOW,
    );
    let Some(recovered) = wants(&after).pop() else {
        panic!("closing the remote view replans the survivor");
    };
    assert_eq!(
        recovered[0].bitrate, alone[0].bitrate,
        "local-only again: {recovered:?} vs {alone:?}"
    );
}
