// SPDX-License-Identifier: Apache-2.0
//! Isolated binary: the allocator counter cannot include other policy tests running in parallel.
use media_core::link_rate::*;
use stats_alloc::{INSTRUMENTED_SYSTEM, Region, StatsAlloc};
use std::alloc::System;
#[global_allocator]
static GLOBAL: &StatsAlloc<System> = &INSTRUMENTED_SYSTEM;
#[test]
fn a_burst_of_cumulative_and_single_acks_allocates_nothing() {
    let mut rate = LinkRate::new(Limits::default());
    // Warm up: a steady second, so every queue has its working size.
    for sequence in 0..60_u64 {
        let at = sequence as f64 * 1000.0 / 60.0;
        rate.sent(sequence, 1_000, at);
        rate.acknowledged(sequence, at + 20.0);
    }
    let region = Region::new(GLOBAL);
    // A recovery: 60 chunks in flight acked one by one, 60 queued ones flushed and acked the
    // same way, then a stream of new frames each acked at once, all inside two seconds and
    // between the estimator's 200 ms prunes. Many more acks than a steady second holds.
    let mut sequence = 60_u64;
    let mut at = 1_000.0;
    for _ in 0..120 {
        rate.sent(sequence, 1_000, at);
        sequence += 1;
    }
    for ack in 60..sequence {
        at += 0.5;
        rate.acknowledged(ack, at);
    }
    for _ in 0..400 {
        at += 2.0;
        rate.sent(sequence, 500, at);
        rate.acknowledged(sequence, at + 0.1);
        sequence += 1;
    }
    let stats = region.change();
    assert_eq!(stats.allocations, 0);
    assert_eq!(stats.reallocations, 0);
}
