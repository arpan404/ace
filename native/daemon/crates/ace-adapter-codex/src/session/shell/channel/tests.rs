// SPDX-License-Identifier: Apache-2.0
//! The channel's lock order, its gate and its terminal barrier.

use std::sync::mpsc;
use std::time::Duration;

use ace_adapter_api::bridge::SessionEvent;
use ace_adapter_api::bridge::queue::QUEUE_EVENTS;
use ace_json::json;

use super::super::ShellConfig;
use super::*;
use crate::session::frames::{Effect, FrameDir};
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

/// The two locks, both ways at once: the host's delivery asks the channel to
/// admit a frame while holding the host, and the channel calls `foreign` from
/// under its core. One order (core→host) must hold, so neither waits forever.
#[test]
fn the_hosts_delivery_and_a_core_read_into_the_host_run_together() {
    let channel = channel();
    let host = std::sync::Arc::clone(&channel.shared.host);
    host.attach(1, channel.clone()).expect("attach");
    let guard = channel.core.lock().expect("core");
    let delivering = {
        let host = std::sync::Arc::clone(&host);
        std::thread::spawn(move || {
            host.line(r#"{"jsonrpc":"2.0","method":"account/rateLimits/updated","params":{}}"#);
        })
    };
    // Let the delivery reach the channel's admission while the core is held.
    std::thread::sleep(Duration::from_millis(100));
    let (sender, receiver) = mpsc::channel();
    let reading = {
        let host = std::sync::Arc::clone(&host);
        std::thread::spawn(move || {
            let foreign = host.foreign(1, &ace_json::JsString::from("thread-other"));
            let _ = sender.send(foreign);
        })
    };
    assert_eq!(
        receiver.recv_timeout(Duration::from_secs(2)),
        Ok(false),
        "the host's lock waited on a core read that waits on the host"
    );
    drop(guard);
    delivering.join().expect("delivery");
    reading.join().expect("read");
}

/// Rule 3: every event one input decided reaches the queue as one step, so
/// another input's events never land between two of them.
#[test]
fn each_inputs_effects_are_published_in_one_step() {
    let channel = channel();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let run = |tag: &'static str| {
        let channel = std::sync::Arc::clone(&channel);
        let barrier = std::sync::Arc::clone(&barrier);
        std::thread::spawn(move || {
            barrier.wait();
            let effects = (0..100)
                .map(|_| Effect::Frame {
                    dir: FrameDir::Send,
                    channel: "stdio",
                    text: tag.to_owned(),
                })
                .collect();
            channel.apply(effects);
        })
    };
    let a = run("a");
    let b = run("b");
    a.join().expect("a");
    b.join().expect("b");
    let batch = channel.queue.take_batch(1000, 1024 * 1024);
    let tags: Vec<&str> = batch
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Frame { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(tags.len(), 200);
    let transitions = tags.windows(2).filter(|pair| pair[0] != pair[1]).count();
    assert_eq!(transitions, 1, "an input's frames were split: {tags:?}");
}

/// Rule 5: the close's settlement and every earlier event precede `Drained`,
/// and the terminal barrier is the last thing the queue sees.
#[test]
fn a_close_settles_before_the_terminal_barrier() {
    let channel = channel();
    channel.close(1, "user");
    let batch = channel.queue.take_batch(64, 64 * 1024);
    let settle = batch
        .iter()
        .position(|event| matches!(event, SessionEvent::Settle { id: 1, .. }));
    let drained = batch
        .iter()
        .position(|event| matches!(event, SessionEvent::Drained));
    assert!(settle.is_some(), "the close never settled");
    assert_eq!(drained, Some(batch.len() - 1), "Drained was not last");
    assert!(settle < drained);
}

/// Rule 4: the session's gate is the host gate the pumps answer, so the
/// engine's pause stops that tenant's intake and the resume restarts it.
#[test]
fn a_paused_session_stops_its_hosts_pumps_and_the_resume_restarts_them() {
    const PAUSED_SLACK: usize = 3 * 1024 * 1024;
    const FLOWING_BYTES: usize = 4 * 1024 * 1024;
    let channel = channel();
    let run = crate::session::harness::GateRun::start_on(
        crate::session::harness::Scratch::new("channel-pause"),
        channel.shared.host.gate().clone(),
    );
    assert!(run.wait_for(512 * 1024), "both pipes deliver");
    channel.set_paused(true);
    let (out0, err0) = run.bytes();
    std::thread::sleep(Duration::from_millis(400));
    let (out1, err1) = run.bytes();
    assert!(
        out1 - out0 <= PAUSED_SLACK && err1 - err0 <= PAUSED_SLACK,
        "a paused session keeps reading: stdout +{}, stderr +{}",
        out1 - out0,
        err1 - err0
    );
    channel.set_paused(false);
    std::thread::sleep(Duration::from_millis(400));
    let (out2, err2) = run.bytes();
    assert!(
        out2 - out1 >= FLOWING_BYTES && err2 - err1 >= FLOWING_BYTES,
        "the resume restarts both pumps: stdout +{}, stderr +{}",
        out2 - out1,
        err2 - err1
    );
    run.stop();
}

/// A host's exit also publishes the terminal barrier last, after the exit
/// evidence every earlier frame preceded.
#[test]
fn a_host_exit_publishes_the_terminal_barrier_last() {
    let channel = channel();
    channel.host_exited(&crate::session::host::HostExit {
        reason: crate::session::host::ExitReason::Exit,
        code: Some(0),
        signal: None,
        pid: None,
        output_drained: true,
    });
    let batch = channel.queue.take_batch(256, 1024 * 1024);
    assert!(
        matches!(batch.last(), Some(SessionEvent::Drained)),
        "Drained was not last"
    );
    assert!(batch.len() > 1, "the exit evidence was dropped");
}
