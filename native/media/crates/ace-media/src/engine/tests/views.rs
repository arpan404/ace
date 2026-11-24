// SPDX-License-Identifier: Apache-2.0
//! Connections, the one view a connection holds of a target, and the encode ids a
//! source hands out.
use super::*;
use crate::engine::delivery::{MediaOut, next_media_id};

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

/// A `viewer.open` of the browser tab `t1` on the test connection, as the daemon sends it.
fn open_view(engine: &mut Engine, viewer: &str, issued: u64) -> Vec<Effect> {
    open_view_of(engine, "s1", viewer, issued)
}

fn open_view_of(engine: &mut Engine, source: &str, viewer: &str, issued: u64) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "viewer.open", "viewer": viewer, "connection": CONNECTION,
                "owner": owner("phone", pairing(1)), "issued": issued, "source": source,
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
    // The last id in range, then none: ids never wrap in place.
    assert_eq!(
        next_media_id(&(1..end), end - 1, |_| false),
        Some((end - 1, end))
    );
    assert_eq!(next_media_id(&(1..end), end, |_| false), None);
    assert_eq!(next_media_id(&(1..end), u32::MAX, |_| false), None);
    assert_eq!(
        next_media_id(&(1..end), end - 2, |id| id == end - 2),
        Some((end - 1, end))
    );
    assert_eq!(next_media_id(&(1..end), end - 1, |id| id == end - 1), None);
    // 0 is never given.
    assert_eq!(next_media_id(&(1..end), 0, |_| false), Some((1, 2)));
}

/// A pane resize: the plan changes, and its new encode takes a new id.
fn resize(engine: &mut Engine, n: u32) -> Vec<Effect> {
    send(
        engine,
        json!({ "type": "viewer.configure", "viewer": "v1",
                "viewport": { "width": 100 + 20 * n, "height": 200 + 40 * n, "dpr": 1, "scale": 1 },
                "audio": false }),
        &[],
        NOW,
    )
}

#[test]
fn a_source_whose_ids_run_out_is_opened_again_never_given_an_id_twice() {
    let mut engine = engine();
    engine.delivery.with_media_ids(1..9);
    open_tab(&mut engine, "s1", 1, 3);
    hello(&mut engine, 1, 3);
    ticket(&mut engine, CONNECTION, owner("phone", pairing(1)), 1, 9);
    assert!(engine.claim_ticket(&[9; 32], NOW).is_some());
    let mut effects = open_view(&mut engine, "v1", 2);
    effects.extend(ingest(&mut engine, 1, h264(true, 0, 1, Vec::new()), NOW));
    for n in 0..12 {
        effects.extend(resize(&mut engine, n));
    }
    let ids: Vec<u32> = wants(&effects).iter().flatten().map(|e| e.id).collect();
    // Every id once, in order, within the range: none wraps back in place.
    assert!(ids.windows(2).all(|w| w[0] < w[1]), "{ids:?}");
    assert!(ids.iter().all(|id| (1..9).contains(id)), "{ids:?}");
    assert_eq!(ids.last(), Some(&8));
    // Out of ids, the source asks once to be opened again: `ended` with no reason.
    let ended: Vec<_> = statuses(&effects)
        .into_iter()
        .filter(|(source, status, reason)| {
            source == "s1" && matches!(status, Status::Ended) && reason.is_none()
        })
        .collect();
    assert_eq!(ended.len(), 1);
    // The daemon opens it again with a fresh handle; the view moves there.
    open_tab(&mut engine, "s2", 2, 4);
    hello(&mut engine, 2, 4);
    send(
        &mut engine,
        json!({ "type": "viewer.close", "viewer": "v1" }),
        &[],
        NOW,
    );
    let mut renewed = open_view_of(&mut engine, "s2", "v1", 3);
    renewed.extend(ingest(&mut engine, 2, h264(true, 1, 1, Vec::new()), NOW));
    let fresh: Vec<u32> = wants(&renewed).iter().flatten().map(|e| e.id).collect();
    assert_eq!(fresh.first(), Some(&1), "its ids start over");
    let Some(&planned) = fresh.last() else {
        panic!("no plan");
    };
    // A late unit of the old source, stamped with an id the new one gives too, reaches nobody.
    let mut late = h264(true, 2, 1, Vec::new());
    late.encode = planned;
    assert!(binaries(&ingest(&mut engine, 1, late, NOW)).is_empty());
    // Delivery goes on from the new source.
    let mut unit = h264(true, 3, 1, Vec::new());
    unit.encode = planned;
    assert!(!binaries(&ingest(&mut engine, 2, unit, NOW)).is_empty());
}
