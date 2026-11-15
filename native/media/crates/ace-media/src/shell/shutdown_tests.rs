// SPDX-License-Identifier: Apache-2.0
//! Shutdown keeps to one budget across its phases (relay closes, then both lanes), however each
//! of them is held up.
use super::relay::RelayEvent;
use super::relay_sockets::RelaySockets;
use super::relay_tests::{frame, listen, relay};
use super::shutdown::shutdown_within;
use super::writer::Writer;
use crate::engine::relay::{CloseMode, FRAME_CAPACITY, Pool};
use std::time::{Duration, Instant};
use tokio::sync::mpsc;

/// A lane whose reader never reads: its writer stays blocked on a full pipe.
fn blocked_lane() -> (Writer, tokio::io::DuplexStream) {
    let (sink, held) = tokio::io::duplex(64);
    let lane = Writer::spawn(sink, 1 << 20);
    assert!(lane.send(vec![0; 64 * 1024]).is_ok());
    (lane, held)
}

#[tokio::test]
async fn shutdown_with_a_relay_close_pending_and_blocked_lanes_keeps_to_its_budget() {
    // A relay close that can't finish on its own: the relay reads nothing.
    let (listener, url) = listen().await;
    let accepted = tokio::spawn(relay(listener));
    let (events, mut rx) = mpsc::channel(16);
    let pool = Pool::default();
    let mut sockets = RelaySockets::new(events, pool.clone());
    sockets.dial("st".into(), url);
    assert!(matches!(rx.recv().await, Some(RelayEvent::Dialed { .. })));
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    let _relay = accepted.await.unwrap_or_else(|_| panic!("relay"));
    for _ in 0..200 {
        assert!(sockets.send("st", frame(&pool, FRAME_CAPACITY - 16)));
    }
    let _close = sockets.close("st", CloseMode::Graceful);
    let (priority, _held_priority) = blocked_lane();
    let (stdout, _held_stdout) = blocked_lane();

    let budget = Duration::from_millis(60);
    let started = Instant::now();
    shutdown_within(budget, &mut sockets, Some(priority), stdout).await;
    let took = started.elapsed();
    assert!(
        took < budget + Duration::from_millis(30),
        "shutdown took {took:?} of a {budget:?} budget"
    );
}
