// SPDX-License-Identifier: Apache-2.0
use media_core::{fanout::*, gate::*};
fn piece(sequence: u64, key: bool, bytes: usize) -> Piece {
    Piece {
        sequence,
        key,
        bytes,
    }
}
fn viewer(window: Window) -> Viewer {
    let mut v = Viewer::new(window);
    v.assign(Some(1), |_| {});
    v
}
#[test]
fn waiting_key_is_replaced_and_its_deltas_follow_cumulative_ack() {
    let mut v = viewer(Window {
        frames: 2,
        bytes: 10_000,
    });
    let mut sent = Vec::new();
    for (seq, key) in [(0, true), (1, false), (2, true), (3, true), (4, false)] {
        v.publish(
            1,
            piece(seq, key, 100),
            |p| {
                sent.push(p.sequence);
                true
            },
            |_| {},
        );
    }
    assert_eq!(sent, [0, 1]);
    v.acknowledge(
        1,
        |p| {
            sent.push(p.sequence);
            true
        },
        |_| {},
    );
    assert_eq!(sent, [0, 1, 3, 4]);
    assert!(!v.backlogged());
}
#[test]
fn oversized_key_goes_alone_and_a_dropped_delta_requires_a_new_key() {
    let mut v = viewer(Window {
        frames: 8,
        bytes: 1000,
    });
    let mut sent = Vec::new();
    let mut events = Vec::new();
    v.publish(
        1,
        piece(0, true, 5000),
        |p| {
            sent.push(p);
            true
        },
        |_| {},
    );
    v.publish(
        1,
        piece(1, false, 100),
        |_| panic!("full window"),
        |e| events.push(e),
    );
    assert_eq!(events, [Event::Dropped, Event::Keyframe]);
    v.acknowledge(0, |_| panic!("dropped"), |_| {});
    v.publish(1, piece(2, false, 100), |_| panic!("broken chain"), |_| {});
    v.publish(
        1,
        piece(3, true, 100),
        |p| {
            sent.push(p);
            true
        },
        |_| {},
    );
    assert_eq!(sent.iter().map(|p| p.sequence).collect::<Vec<_>>(), [0, 3]);
    assert!(!v.backlogged());
}
#[test]
fn refused_key_keeps_its_bytes_so_retries_never_widen_the_delta_allowance() {
    let mut v = viewer(Window {
        frames: 4,
        bytes: 100,
    });
    let mut events = Vec::new();
    v.publish(1, piece(0, true, 100), |_| false, |e| events.push(e));
    for _ in 0..100 {
        v.flush(|_| false, |e| events.push(e));
    }
    assert!(
        events.is_empty(),
        "refused attempts are not sends: {events:?}"
    );
    // Behind the waiting key, deltas get exactly the window's 100 bytes.
    v.publish(
        1,
        piece(1, false, 60),
        |_| panic!("waiting key"),
        |e| events.push(e),
    );
    v.publish(
        1,
        piece(2, false, 40),
        |_| panic!("waiting key"),
        |e| events.push(e),
    );
    assert!(events.is_empty());
    v.publish(
        1,
        piece(3, false, 1),
        |_| panic!("waiting key"),
        |e| events.push(e),
    );
    assert_eq!(events, [Event::Dropped, Event::Keyframe]);
    let mut sent = Vec::new();
    v.flush(
        |p| {
            sent.push(p.sequence);
            true
        },
        |_| {},
    );
    assert_eq!(sent, [0]);
    v.acknowledge(0, |_| panic!("deltas went with the drop"), |_| {});
    assert!(v.playing());
}
#[test]
fn byte_overflow_discards_queued_deltas_but_retains_the_waiting_key() {
    let mut v = viewer(Window {
        frames: 60,
        bytes: 1000,
    });
    let mut sent = Vec::new();
    for p in [
        piece(0, true, 900),
        piece(1, true, 500),
        piece(2, false, 600),
        piece(3, false, 600),
    ] {
        v.publish(
            1,
            p,
            |p| {
                sent.push(p.sequence);
                true
            },
            |_| {},
        );
    }
    v.acknowledge(
        0,
        |p| {
            sent.push(p.sequence);
            true
        },
        |_| {},
    );
    assert_eq!(sent, [0, 1]);
    v.acknowledge(1, |_| panic!("deltas dropped"), |_| {});
    v.publish(
        1,
        piece(4, false, 10),
        |_| panic!("still needs key"),
        |_| {},
    );
}
#[test]
fn slow_viewer_never_blocks_fast_viewer_and_switching_encodes_needs_key() {
    let mut slow = viewer(Window {
        frames: 3,
        bytes: 10000,
    });
    let mut fast = viewer(Window {
        frames: 3,
        bytes: 10000,
    });
    let mut slow_sent = 0;
    let mut fast_sent = 0;
    for seq in 0..21 {
        let p = piece(seq, seq == 0, 100);
        slow.publish(
            1,
            p,
            |_| {
                slow_sent += 1;
                true
            },
            |_| {},
        );
        fast.publish(
            1,
            p,
            |_| {
                fast_sent += 1;
                true
            },
            |_| {},
        );
        fast.acknowledge(seq, |_| true, |_| {});
    }
    assert_eq!((slow_sent, fast_sent), (3, 21));
    fast.assign(Some(2), |_| {});
    fast.publish(1, piece(22, true, 100), |_| panic!("wrong encode"), |_| {});
    fast.publish(2, piece(22, false, 100), |_| panic!("missing key"), |_| {});
    fast.publish(
        2,
        piece(23, true, 100),
        |_| {
            fast_sent += 1;
            true
        },
        |_| {},
    );
    assert_eq!(fast_sent, 22);
    let mut events = Vec::new();
    fast.stop(|e| events.push(e));
    assert_eq!(events, [Event::Playing(false)]);
    assert!(!fast.playing());
}
#[test]
fn decoder_key_request_keeps_waiting_key_but_discards_its_deltas() {
    let mut v = viewer(Window {
        frames: 2,
        bytes: 1000,
    });
    for p in [
        piece(0, true, 100),
        piece(1, false, 100),
        piece(2, true, 100),
        piece(3, false, 100),
    ] {
        v.publish(1, p, |_| true, |_| {});
    }
    v.keyframe(|_| {});
    let mut sent = Vec::new();
    v.acknowledge(
        1,
        |p| {
            sent.push(p.sequence);
            true
        },
        |_| {},
    );
    v.publish(
        1,
        piece(4, false, 100),
        |_| panic!("decoder needs key"),
        |_| {},
    );
    assert_eq!(sent, [2]);
}
#[test]
fn producer_gate_is_independent_per_encode_and_does_not_try_broken_deltas() {
    let mut broken = ChunkGate::default();
    let mut healthy = ChunkGate::default();
    assert!(broken.offer(false, || false).keyframe);
    assert!(!broken.offer(false, || panic!("broken delta")).sent);
    assert!(healthy.offer(false, || true).sent);
    assert!(broken.offer(true, || false).keyframe);
    assert!(broken.offer(true, || true).sent);
    assert!(broken.offer(false, || true).sent);
}
#[test]
fn picture_channel_pressure_preserves_exact_byte_and_picture_boundaries() {
    assert!(live_admitted(false, 3, 512 * 1024));
    assert!(!live_admitted(false, 4, 0));
    assert!(!live_admitted(false, 0, 512 * 1024 + 1));
    assert!(!live_admitted(true, 0, 0));
    assert!(still_admitted(false, 7, 128 * 1024));
    assert!(!still_admitted(false, 8, 0));
    assert!(!still_admitted(false, 0, 128 * 1024 + 1));
    assert!(!still_admitted(true, 0, 0));
}
