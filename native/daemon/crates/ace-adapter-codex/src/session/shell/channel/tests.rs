// SPDX-License-Identifier: Apache-2.0
//! The channel's lock order, its gate and its terminal barrier.

use std::sync::mpsc;
use std::time::Duration;

use ace_adapter_api::bridge::SessionEvent;
use ace_adapter_api::bridge::queue::QUEUE_EVENTS;
use ace_json::json;

use super::super::ShellConfig;
use super::*;
use crate::session::host::{Host, HostConfig};
use crate::session::pool::initialize;

fn channel() -> Arc<SessionChannel> {
    let host = Host::new(HostConfig::shared(initialize(), 600_000.0));
    let shared = Arc::new(SharedHost::new(1, "bench".to_owned(), host));
    SessionChannel::new(
        shared,
        1,
        ShellConfig {
            scope: "scope".to_owned(),
            started: 0.0,
            cwd: "/work".to_owned(),
            bearer: None,
            workspace: "/work".to_owned(),
            home: None,
            hostname: None,
            env: Vec::new(),
        },
        Arc::new(|_| {}),
    )
}

/// The host asks for admission while it holds its own lock. The session used
/// to answer from under its core lock, so a core task that called back into the
/// host (the `foreign` check) deadlocked the two.
#[test]
fn admission_does_not_wait_on_the_core_lock() {
    let channel = channel();
    let guard = channel.core.lock().expect("core");
    let (sender, receiver) = mpsc::channel();
    let asking = Arc::clone(&channel);
    std::thread::spawn(move || {
        let verdict = asking.admit(
            Direction::Recv,
            &json!({"jsonrpc":"2.0","id":7,"method":"thread/read","params":{}}),
        );
        let _ = sender.send(matches!(verdict, Admission::Taken));
    });
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(1)),
        Ok(true),
        "admission waited on the core lock"
    );
    drop(guard);
}

#[test]
fn a_paused_or_failed_session_stops_the_hosts_pumps() {
    let channel = channel();
    assert!(!channel.shared.host.paused());
    channel.set_paused(true);
    assert!(channel.shared.host.paused());
    channel.set_paused(false);
    assert!(!channel.shared.host.paused());
    channel.fail_intake();
    assert!(
        channel.shared.host.paused(),
        "a failed commit never resumes"
    );
}

#[test]
fn a_full_session_queue_pauses_the_host_until_a_batch_is_taken() {
    let channel = channel();
    for _ in 0..QUEUE_EVENTS {
        channel.publish(vec![SessionEvent::CancelTimer {
            key: "t".to_owned(),
        }]);
    }
    assert!(channel.queue.at_bound());
    assert!(channel.shared.host.paused());
    let taken = channel.queue.take_batch(64, 64 * 1024);
    assert!(!taken.is_empty());
    channel.queue_consumed();
    assert!(!channel.shared.host.paused());
}

#[test]
fn the_terminal_barrier_is_published_once_and_last() {
    let channel = channel();
    channel.finish_drained();
    channel.finish_drained();
    let batch = channel.queue.take_batch(64, 64 * 1024);
    let drained = batch
        .iter()
        .filter(|event| matches!(event, SessionEvent::Drained))
        .count();
    assert_eq!(drained, 1);
}
