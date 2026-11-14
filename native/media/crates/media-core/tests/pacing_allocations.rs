// SPDX-License-Identifier: Apache-2.0
//! Isolated binary: the allocator counter cannot include other policy tests running in parallel.
use media_core::{
    fanout::*, gate::ChunkGate, keyframes::EncodePacer, link_rate::*, quantizer::QuantizerControl,
    scale::PictureScale,
};
use stats_alloc::{INSTRUMENTED_SYSTEM, Region, StatsAlloc};
use std::{alloc::System, hint::black_box};
#[global_allocator]
static GLOBAL: &StatsAlloc<System> = &INSTRUMENTED_SYSTEM;
#[test]
fn sixty_fps_pacing_allocates_nothing_after_viewer_construction() {
    let mut viewer = Viewer::new(Window::default());
    viewer.assign(Some(1), |_| {});
    let mut rate = LinkRate::new(Limits::default());
    let mut scale = PictureScale::default();
    let mut pacer = EncodePacer::new(60.0);
    let mut gate = ChunkGate::default();
    let mut quantizer = QuantizerControl::new(1_500_000.0, 60.0);
    let region = Region::new(GLOBAL);
    // Cross both the ten-second RTT floor and thirty-second proven-rate windows repeatedly.
    for sequence in 0..6000 {
        let now = sequence as f64 * 1000.0 / 60.0;
        let p = Piece {
            sequence,
            key: sequence % 120 == 0,
            bytes: 10_000,
        };
        viewer.publish(
            1,
            p,
            |_| true,
            |e| {
                if let Event::Sent(p) = e {
                    rate.sent(p.sequence, p.bytes, now);
                }
            },
        );
        rate.acknowledged(sequence, now + 20.0 + (sequence % 7) as f64);
        viewer.acknowledge(sequence, |_| true, |_| {});
        black_box(scale.update(rate.rate(), 2_073_600.0, 60.0, now));
        black_box(pacer.frame(now, false));
        black_box(gate.offer(p.key, || true));
        black_box(quantizer.next(p.key));
        quantizer.observe(p.bytes, p.key);
    }
    let stats = region.change();
    assert_eq!(stats.allocations, 0);
    assert_eq!(stats.reallocations, 0);
}
