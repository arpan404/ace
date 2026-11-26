// SPDX-License-Identifier: Apache-2.0
//! The observer's moved cases: the E3 bridge's ordering, batching and terminal-barrier rules
//! (ADR 0223 §7), now proven on the engine side.

use super::{Event, Inbox, QueueObserver, Sink, compact_idle, compact_supported, drain};
use ace_adapter_api::{FrameDirection, SessionExit, SessionFrame, SessionObserver};
use ace_json::Raw;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::task::{Wake, Waker};

fn frame(seq: u64) -> SessionFrame {
    SessionFrame {
        seq,
        t: seq as i64,
        dir: FrameDirection::Recv,
        channel: "stdio".to_owned(),
        data: Raw::from_json(&format!("{{\"seq\":{seq}}}")).expect("json"),
    }
}

#[derive(Default)]
struct Recording {
    seen: Vec<String>,
}

impl Sink for Recording {
    fn frame(&mut self, frame: SessionFrame) {
        self.seen.push(format!("frame:{}", frame.seq));
    }
    fn identity(&mut self, native_session_id: &str) {
        self.seen.push(format!("identity:{native_session_id}"));
    }
    fn fatal(&mut self, message: &str) {
        self.seen.push(format!("fatal:{message}"));
    }
    fn exit(&mut self, exit: SessionExit) {
        self.seen.push(format!("exit:{}", exit.message));
    }
}

#[test]
fn the_observer_hands_identity_before_the_frames_it_names() {
    let inbox = Inbox::new();
    let observer = QueueObserver::new(Arc::clone(&inbox));
    observer.identity("native-1");
    observer.frame(frame(0));
    observer.frame(frame(1));
    let mut sink = Recording::default();
    assert_eq!(drain(&inbox, &mut sink), 3);
    assert_eq!(sink.seen, ["identity:native-1", "frame:0", "frame:1"]);
}

#[test]
fn the_exit_is_the_barrier_and_later_events_are_dropped() {
    let inbox = Inbox::new();
    let observer = QueueObserver::new(Arc::clone(&inbox));
    observer.frame(frame(0));
    observer.exit(SessionExit {
        deliberate: true,
        message: "closed".to_owned(),
    });
    observer.frame(frame(1));
    let mut sink = Recording::default();
    assert_eq!(drain(&inbox, &mut sink), 2);
    assert_eq!(sink.seen, ["frame:0", "exit:closed"]);
    assert!(inbox.is_empty(), "nothing after the exit is kept");
    let mut late = Recording::default();
    assert_eq!(drain(&inbox, &mut late), 0);
    assert!(late.seen.is_empty());
}

#[test]
fn a_batch_never_crosses_its_frame_bound_and_other_events_travel_with_it() {
    let inbox = Inbox::new();
    for seq in 0..5 {
        inbox.push(Event::Frame(frame(seq)));
    }
    let first = inbox.take_batch(2, usize::MAX);
    assert_eq!(first.len(), 2);
    assert!(matches!(&first[0], Event::Frame(frame) if frame.seq == 0));
    assert!(matches!(&first[1], Event::Frame(frame) if frame.seq == 1));
    assert_eq!(inbox.len(), 3);

    // An identity between frames rides along and does not count against the frame bound.
    let inbox = Inbox::new();
    inbox.push(Event::Frame(frame(0)));
    inbox.push(Event::Identity("id".to_owned()));
    inbox.push(Event::Frame(frame(1)));
    let batch = inbox.take_batch(1, usize::MAX);
    assert_eq!(batch.len(), 2, "the identity travels with its frame");
    assert!(matches!(&batch[1], Event::Identity(id) if id == "id"));
    assert_eq!(inbox.len(), 1, "the next frame waits for the next batch");
}

struct Counting(Arc<AtomicUsize>);

impl Wake for Counting {
    fn wake(self: Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
    fn wake_by_ref(self: &Arc<Self>) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn a_parked_drain_is_woken_by_a_producers_push() {
    let inbox = Inbox::new();
    let counted = Arc::new(AtomicUsize::new(0));
    let waker = Waker::from(Arc::new(Counting(Arc::clone(&counted))));
    let context = std::task::Context::from_waker(&waker);
    assert!(matches!(inbox.poll(), std::task::Poll::Pending));
    inbox.register(context.waker());

    let producer = Arc::clone(&inbox);
    std::thread::spawn(move || {
        QueueObserver::new(producer).frame(frame(7));
    })
    .join()
    .expect("the producer ran");
    assert_eq!(
        counted.load(Ordering::SeqCst),
        1,
        "the producer woke the drain"
    );
    let batch = inbox.take_batch(usize::MAX, super::QUEUE_BYTES);
    assert!(matches!(&batch[..], [Event::Frame(frame)] if frame.seq == 7));
}

#[test]
fn parallel_producers_lose_nothing() {
    let inbox = Inbox::new();
    let mut threads = Vec::new();
    for _ in 0..4 {
        let producer = Arc::clone(&inbox);
        threads.push(std::thread::spawn(move || {
            let observer = QueueObserver::new(producer);
            for seq in 0..100 {
                observer.frame(frame(seq));
            }
        }));
    }
    for thread in threads {
        thread.join().expect("producer");
    }
    let mut delivered = 0;
    loop {
        let batch = inbox.take_batch(usize::MAX, super::QUEUE_BYTES);
        if batch.is_empty() {
            break;
        }
        delivered += batch.len();
    }
    assert_eq!(delivered, 400);
}

#[test]
fn compaction_is_admitted_only_for_an_idle_thread_of_a_compacting_provider() {
    assert!(compact_supported(Some(true)));
    assert!(!compact_supported(None));
    assert!(!compact_supported(Some(false)));
    assert!(!compact_idle("working"));
    assert!(!compact_idle("starting"));
    assert!(!compact_idle("blocked"));
    assert!(!compact_idle("unresponsive"));
    assert!(compact_idle("done"));
    assert!(compact_idle("idle"));
}
