// SPDX-License-Identifier: Apache-2.0
//! A view that stops acknowledging is parked: nothing in flight, nothing queued, and no keyframe
//! owed to a client that would not take it. Its ack starts it again at a fresh keyframe.
use media_core::fanout::*;

fn piece(sequence: u64, key: bool, bytes: usize) -> Piece {
    Piece {
        sequence,
        key,
        bytes,
    }
}

fn viewer() -> Viewer {
    let mut viewer = Viewer::new(Window {
        frames: 8,
        bytes: 1_000_000,
    });
    viewer.assign(Some(1), |_| {});
    viewer
}

fn publish(viewer: &mut Viewer, sequence: u64, key: bool, at: f64, sent: &mut Vec<u64>) {
    viewer.publish(
        1,
        piece(sequence, key, 100),
        at,
        |piece| {
            sent.push(piece.sequence);
            true
        },
        |_| {},
    );
}

#[test]
fn a_view_that_stops_acknowledging_parks_without_asking_for_a_keyframe() {
    let mut viewer = viewer();
    let mut sent = Vec::new();
    // A keyframe and its deltas, acknowledged: the view is live.
    publish(&mut viewer, 0, true, 0.0, &mut sent);
    viewer.acknowledge_through(0, 5.0, |_| true, |_| {});
    publish(&mut viewer, 1, false, 5.0, &mut sent);
    assert_eq!(sent, [0, 1]);
    // Then it goes quiet: the chunk on the wire runs past its deadline with no ack in two seconds.
    let mut events = Vec::new();
    let parked_at = 10_000.0;
    viewer.flush(parked_at, |_| true, |event| events.push(event));
    assert!(viewer.parked(), "a view that acks nothing is parked");
    assert!(events.contains(&Event::Lost), "{events:?}");
    assert!(
        !events.contains(&Event::Keyframe),
        "nothing is asked of its source: {events:?}"
    );
    // Nothing more goes to it, not even a keyframe.
    publish(&mut viewer, 2, true, parked_at + 1.0, &mut sent);
    assert_eq!(sent, [0, 1], "a parked view is sent nothing");
}

#[test]
fn an_acknowledgement_resumes_a_parked_view_at_a_fresh_keyframe() {
    let mut viewer = viewer();
    let mut sent = Vec::new();
    publish(&mut viewer, 0, true, 0.0, &mut sent);
    viewer.acknowledge_through(0, 1.0, |_| true, |_| {});
    publish(&mut viewer, 1, false, 1.0, &mut sent);
    viewer.flush(10_000.0, |_| true, |_| {});
    assert!(viewer.parked());
    let mut events = Vec::new();
    viewer.acknowledge_through(
        0,
        10_100.0,
        |piece| {
            sent.push(piece.sequence);
            true
        },
        |event| events.push(event),
    );
    assert!(!viewer.parked(), "its ack starts it again");
    assert!(events.contains(&Event::Keyframe), "{events:?}");
    // The picture it missed is not sent: only a keyframe starts it.
    publish(&mut viewer, 2, false, 10_200.0, &mut sent);
    assert_eq!(sent, [0, 1], "deltas wait for the keyframe");
    publish(&mut viewer, 3, true, 10_300.0, &mut sent);
    assert_eq!(sent, [0, 1, 3], "the keyframe goes");
}

#[test]
fn a_view_that_never_acks_is_asked_for_a_few_keyframes_then_left_to_the_source() {
    let mut viewer = viewer();
    let mut sent = Vec::new();
    let mut events = Vec::new();
    // Each round its source makes a keyframe, it takes it and a delta, and both expire unacked.
    let mut sequence = 0;
    let mut round = |viewer: &mut Viewer, sequence: &mut u64, events: &mut Vec<Event>| {
        publish(viewer, *sequence, true, 0.0, &mut sent);
        *sequence += 1;
        publish(viewer, *sequence, false, 0.0, &mut sent);
        *sequence += 1;
        viewer.flush(
            10_000.0 + *sequence as f64 * 100.0,
            |_| true,
            |event| events.push(event),
        );
    };
    for _ in 0..6 {
        round(&mut viewer, &mut sequence, &mut events);
    }
    let asked = events.iter().filter(|e| **e == Event::Keyframe).count();
    assert_eq!(asked, 3, "asked a few times, never for ever: {events:?}");
    assert!(
        !viewer.parked(),
        "a client that never acked may still be starting"
    );
    // An ack starts the count over.
    viewer.acknowledge_through(sequence - 1, 20_100.0, |_| true, |_| {});
    let mut after = Vec::new();
    viewer.flush(30_000.0, |_| true, |event| after.push(event));
    assert!(
        !after.contains(&Event::Keyframe),
        "nothing is in flight: {after:?}"
    );
    round(&mut viewer, &mut sequence, &mut after);
    assert!(after.contains(&Event::Keyframe), "live again: {after:?}");
}

#[test]
fn a_live_view_is_never_parked() {
    let mut viewer = viewer();
    let mut sent = Vec::new();
    for step in 0..20u64 {
        let at = step as f64 * 1_000.0;
        publish(&mut viewer, step, step == 0, at, &mut sent);
        viewer.acknowledge_through(step, at + 5.0, |_| true, |_| {});
        viewer.flush(at + 6.0, |_| true, |_| {});
        assert!(!viewer.parked(), "acked at every picture: still live");
    }
}
