// SPDX-License-Identifier: Apache-2.0
//! Run via native/media/bench/fanout. Wall time is an upper bound on single-thread CPU time.
use media_core::{
    fanout::*, gate::ChunkGate, keyframes::EncodePacer, link_rate::*, scale::PictureScale,
};
use serde_json::json;
use stats_alloc::{INSTRUMENTED_SYSTEM, Region, StatsAlloc};
#[global_allocator]
static GLOBAL: &StatsAlloc<std::alloc::System> = &INSTRUMENTED_SYSTEM;
use std::{hint::black_box, time::Instant};
fn load_average() -> Option<f64> {
    if let Ok(load) = std::fs::read_to_string("/proc/loadavg") {
        return load.split_whitespace().next()?.parse().ok();
    }
    let output = std::process::Command::new("sysctl")
        .args(["-n", "vm.loadavg"])
        .output()
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    text.split_whitespace().find_map(|v| v.parse().ok())
}
/// Feeds a viewer's sends and drops into its link estimator, counting both.
fn track<'a>(
    rate: &'a mut LinkRate,
    at: f64,
    sent: &'a mut u64,
    dropped: &'a mut u64,
) -> impl FnMut(Event) + 'a {
    move |e| match e {
        Event::Sent(p) => {
            *sent += 1;
            rate.sent(p.sequence, p.bytes, at);
        }
        Event::Dropped => {
            *dropped += 1;
            rate.dropped(at);
        }
        _ => {}
    }
}
fn main() {
    let load = load_average();
    let cores = std::thread::available_parallelism().map_or(1, usize::from);
    let enforce = std::env::var("ACE_MEDIA_BENCH_REPORT_ONLY").as_deref() != Ok("1")
        && load.is_some_and(|load| load <= 2.0 * cores as f64);
    let mut viewers: Vec<_> = (0..100)
        .map(|_| {
            let mut v = Viewer::new(Window::default());
            v.assign(Some(1), |_| {});
            (
                v,
                LinkRate::new(Limits::default()),
                PictureScale::default(),
                EncodePacer::new(60.0),
                ChunkGate::default(),
            )
        })
        .collect();
    let frames = 60_000_u64;
    let region = Region::new(GLOBAL);
    let start = Instant::now();
    let mut sent = 0_u64;
    let mut dropped = 0_u64;
    for sequence in 0..frames {
        let now = sequence as f64 * 1000.0 / 60.0;
        let piece = Piece {
            sequence,
            key: sequence % 120 == 0,
            bytes: if sequence % 120 == 0 { 100_000 } else { 10_000 },
        };
        for (id, (viewer, rate, scale, pacer, gate)) in viewers.iter_mut().enumerate() {
            // 80 immediate-ack viewers, 10 with a 30-frame RTT, 10 stalled/refusing.
            let accepts = id < 90 || sequence % 90 >= 60;
            let at = black_box(now);
            // Publication and ack-triggered flushes both send; the estimator sees every send.
            viewer.publish(
                1,
                black_box(piece),
                |_| black_box(accepts),
                track(rate, at, &mut sent, &mut dropped),
            );
            let ack = if id < 80 {
                Some(sequence)
            } else if id < 90 {
                sequence.checked_sub(30)
            } else if sequence % 90 >= 60 {
                Some(sequence)
            } else {
                None
            };
            if let Some(ack) = ack {
                rate.acknowledged(ack, at);
                viewer.acknowledge(ack, |_| accepts, track(rate, at, &mut sent, &mut dropped));
            }
            black_box(scale.update(rate.rate(), 1920.0 * 1080.0, 60.0, at));
            black_box(pacer.frame(at, false));
            black_box(gate.offer(piece.key, || accepts));
            black_box(viewer.backlogged());
        }
    }
    let elapsed = start.elapsed().as_secs_f64();
    let allocations = region.change();
    let seconds = frames as f64 / 60.0;
    let percent = elapsed / seconds * 100.0;
    println!(
        "{}",
        json!({"path":"fanout: 100 viewers x 60 fps (80 immediate, 10 delayed, 10 congested)",
        "decisions":frames*100,"seconds":seconds,"elapsedMs":elapsed*1000.0,"nsPerDecision":elapsed*1e9/(frames*100) as f64,
        "corePercentUpperBound":percent,"limitCorePercent":1,"loadAverage":load,"cores":cores,"enforced":enforce,
        "sent":sent,"dropped":dropped,"allocations":allocations.allocations,"reallocations":allocations.reallocations,"passed":percent<=1.0 && allocations.allocations == 0 && allocations.reallocations == 0})
    );
    if enforce && (percent > 1.0 || allocations.allocations != 0 || allocations.reallocations != 0)
    {
        std::process::exit(1);
    }
}
