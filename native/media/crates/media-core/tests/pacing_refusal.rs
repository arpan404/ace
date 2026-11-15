// SPDX-License-Identifier: Apache-2.0
//! Isolated binary: the allocator counter cannot include other policy tests running in parallel.
use media_core::{fanout::*, link_rate::*};
use stats_alloc::{INSTRUMENTED_SYSTEM, Region, StatsAlloc};
use std::alloc::System;
#[global_allocator]
static GLOBAL: &StatsAlloc<System> = &INSTRUMENTED_SYSTEM;
#[test]
fn a_long_refusal_then_recovery_allocates_nothing_and_credits_only_delivered_bytes() {
    let mut viewer = Viewer::new(Window::default());
    viewer.assign(Some(1), |_| {});
    let limits = Limits::default();
    let mut rate = LinkRate::new(limits);
    let region = Region::new(GLOBAL);
    // Half a second of a blocked transport, retried twenty times a frame, then four seconds
    // of a link that takes everything and acks after 20 ms.
    for sequence in 0..270_u64 {
        let now = sequence as f64 * 1000.0 / 60.0;
        let accepts = sequence >= 30;
        let piece = Piece {
            sequence,
            key: sequence == 0,
            bytes: if sequence == 0 { 20_000 } else { 1_000 },
        };
        let mut track = |e| match e {
            Event::Sent(p) => rate.sent(p.sequence, p.bytes, now),
            Event::Dropped => panic!("the window holds half a second"),
            _ => {}
        };
        viewer.publish(1, piece, |_| accepts, &mut track);
        if !accepts {
            for _ in 0..20 {
                viewer.flush(|_| false, &mut track);
            }
            continue;
        }
        rate.acknowledged(sequence, now + 20.0);
        viewer.acknowledge(
            sequence,
            |_| true,
            |e| {
                if let Event::Sent(p) = e {
                    rate.sent(p.sequence, p.bytes, now);
                }
            },
        );
    }
    let stats = region.change();
    assert_eq!(stats.allocations, 0);
    assert_eq!(stats.reallocations, 0);
    // About 0.5 Mbit/s was delivered: with headroom that is still below where the rate
    // started, so it never climbs. Counting the 600 refused key retries would lift it.
    assert_eq!(rate.rate(), limits.initial);
    assert!(!viewer.backlogged());
}
