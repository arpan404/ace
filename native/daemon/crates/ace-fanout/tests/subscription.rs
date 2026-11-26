#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Ports the cases of the subscription test files by name. Byte equality with the TypeScript
//! is `tests/subscription_vectors.rs`; these cases assert what each name guards, over a small
//! in-memory store.
//!
//! `apps/daemon/src/subscription-replay.test.ts`:
//! - "a thread whose missed events pass the replay limit gets a snapshot"
//! - "a resume after a long streamed turn costs no more than a snapshot and shows the same thread"
//! - "a short resume still replays its events"
//! - "a resume never answers with a snapshot cut to a tail: it gets the full one"
//! - "a resume past the replay limit gets the full snapshot, as a cursor with no replay does"
//!
//! `apps/daemon/src/subscription-routing.test.ts`:
//! - "each subscription hears only its thread's events and progress over the rest"
//! - "a stopped subscription hears nothing more while others on the store still do"
//!
//! `apps/daemon/src/subscription-snapshot.test.ts`:
//! - "each subscriber's snapshot of an unchanged thread carries the current head"
//! - "a subscriber's snapshot shows the thread's newest write"
//!
//! and the tail and progress rules of `subscription-tail.test.ts` and behaviour.md §9.

use std::cell::{Cell, RefCell};

use ace_fanout::encode::WireEncoder;
use ace_fanout::{
    DEFAULT_PROGRESS_INTERVAL_MS, DeliveryEvent, Scope, SnapshotTail, SubscribeError,
    SubscribeOptions, Subscription, SubscriptionFrame, SubscriptionStore, WHOLE_EVENTS,
};
use ace_json::{JsString, Value};

fn parse(text: &str) -> Value {
    ace_json::parse(text).expect("parse JSON")
}

fn event(seq: u64, thread: &str, payload: &str) -> DeliveryEvent {
    DeliveryEvent::parse(&format!(
        r#"{{"id":"e{seq}","seq":{seq},"at":1,"threadId":"{thread}","payload":{payload}}}"#
    ))
    .expect("parse event")
}

fn item_event(seq: u64, thread: &str, item: &str) -> DeliveryEvent {
    event(
        seq,
        thread,
        &format!(
            r#"{{"type":"item.created","item":{{"id":"{item}","agentId":"a","type":"message","role":"assistant","createdAt":1,"parts":[],"raw":[]}}}}"#
        ),
    )
}

fn thread_view(seq: u64, items_before: Option<u64>, items: &[&str]) -> Value {
    let rows: Vec<String> = items
        .iter()
        .map(|id| {
            format!(
                r#""{id}":{{"id":"{id}","agentId":"a","type":"message","role":"assistant","createdAt":1,"parts":[],"raw":[]}}"#
            )
        })
        .collect();
    parse(&format!(
        r#"{{"kind":"thread","seq":{seq},"thread":{{"id":"t","workspaceId":"w","title":"t","provider":"codex","status":{{"state":"new"}},"createdAt":1,"updatedAt":1}},"agents":{{}},"agentChildren":{{}},"runs":{{}},"items":{{{}}},"itemOrder":[{}],"itemsBefore":{},"interactions":{{}},"backgroundTasks":{{}},"usage":{{}},"contextMeters":{{}},"usageSnapshots":{{}}}}"#,
        rows.join(","),
        items
            .iter()
            .map(|id| format!("\"{id}\""))
            .collect::<Vec<_>>()
            .join(","),
        items_before.map_or("null".to_owned(), |seq| seq.to_string())
    ))
}

fn list_view(threads: &[&str]) -> Value {
    let rows: Vec<String> = threads
        .iter()
        .map(|id| {
            format!(
                r#""{id}":{{"id":"{id}","workspaceId":"w","title":"{id}","provider":"codex","status":{{"state":"new"}},"createdAt":1,"updatedAt":1}}"#
            )
        })
        .collect();
    parse(&format!(
        r#"{{"kind":"threads","seq":1,"threads":{{{}}}}}"#,
        rows.join(",")
    ))
}

#[derive(Default)]
struct Mem {
    head: Cell<u64>,
    safe: Cell<bool>,
    exists: Cell<bool>,
    view: RefCell<Value>,
    list: RefCell<Value>,
    count: Cell<Option<usize>>,
    events: RefCell<Vec<DeliveryEvent>>,
    reads: RefCell<Vec<String>>,
    tails: RefCell<Vec<Option<SnapshotTail>>>,
    released: Cell<usize>,
}

impl Mem {
    fn new(head: u64) -> Mem {
        Mem {
            head: Cell::new(head),
            safe: Cell::new(true),
            exists: Cell::new(true),
            view: RefCell::new(thread_view(head, None, &[])),
            list: RefCell::new(list_view(&["t"])),
            count: Cell::new(None),
            events: RefCell::new(Vec::new()),
            reads: RefCell::new(Vec::new()),
            tails: RefCell::new(Vec::new()),
            released: Cell::new(0),
        }
    }

    fn read(&self, call: &str) {
        self.reads.borrow_mut().push(call.to_owned());
    }
}

impl SubscriptionStore for Mem {
    fn head_seq(&self) -> u64 {
        self.read("headSeq");
        self.head.get()
    }

    fn replay_safe(&self, _after_seq: u64) -> bool {
        self.read("replaySafe");
        self.safe.get()
    }

    fn get_thread(&self, _thread: &str) -> bool {
        self.read("getThread");
        self.exists.get()
    }

    fn acquire_thread(&self, _thread: &str) {
        self.read("acquireThread");
    }

    fn release_thread(&self, _thread: &str) {
        self.read("releaseThread");
        self.released.set(self.released.get() + 1);
    }

    fn snapshot_thread(&self, _thread: &str, tail: Option<SnapshotTail>) -> Value {
        self.read("snapshotThread");
        self.tails.borrow_mut().push(tail);
        self.view.borrow().clone()
    }

    fn list_threads(&self) -> Value {
        self.read("listThreads");
        self.list.borrow().clone()
    }

    fn count_thread_events(
        &self,
        _thread: &str,
        _after: u64,
        _through: u64,
        _limit: usize,
    ) -> Option<usize> {
        self.read("countThreadEvents");
        self.count.get()
    }

    fn read_events(
        &self,
        after: u64,
        limit: usize,
        byte_limit: usize,
        thread: Option<&str>,
    ) -> Vec<DeliveryEvent> {
        self.read("readEvents");
        let encoder = WireEncoder::new();
        let mut out = Vec::new();
        let mut bytes = 0;
        for event in self.events.borrow().iter() {
            if event.seq().is_none_or(|seq| seq as u64 <= after) {
                continue;
            }
            if thread.is_some() && event.thread_id() != Some(&JsString::from(thread.unwrap_or("")))
            {
                continue;
            }
            out.push(event.clone());
            bytes += encoder.event_bytes(event, WHOLE_EVENTS);
            if out.len() >= limit || bytes > byte_limit {
                break;
            }
        }
        out
    }
}

fn options() -> SubscribeOptions {
    SubscribeOptions::default()
}

fn open(scope: Scope, after: Option<u64>) -> (Subscription, Mem) {
    let mem = Mem::new(10);
    let subscription = Subscription::new(JsString::from("s"), scope, after, options());
    (subscription, mem)
}

fn snapshot(frames: &[SubscriptionFrame]) -> (&u64, &Value) {
    for frame in frames {
        if let SubscriptionFrame::Snapshot { seq, view, .. } = frame {
            return (seq, view);
        }
    }
    panic!("no snapshot frame: {frames:?}");
}

fn events(frame: &SubscriptionFrame) -> &ace_fanout::encode::EventsMessage {
    match frame {
        SubscriptionFrame::Events(message) => message,
        _ => panic!("not an events frame: {frame:?}"),
    }
}

/// "each subscriber's snapshot of an unchanged thread carries the current head" and "a
/// subscriber's snapshot shows the thread's newest write".
#[test]
fn a_snapshot_carries_the_head_read_with_it() {
    let (mut subscription, mem) = open(Scope::Thread("t".to_owned()), None);
    // The view was read at an older write; the head read with it is the newer one.
    *mem.view.borrow_mut() = thread_view(3, None, &[]);
    mem.head.set(9);
    let frames = subscription.start(&mem, 0).expect("start");
    let (seq, view) = snapshot(&frames);
    assert_eq!(*seq, 9);
    assert_eq!(
        view.get("seq").and_then(|seq| match seq {
            Value::Number(seen) => Some(seen.value()),
            _ => None,
        }),
        Some(9.0)
    );
    assert_eq!(subscription.cursor(), 9);
}

/// "a resume never answers with a snapshot cut to a tail: it gets the full one".
#[test]
fn a_resume_never_gets_a_tail() {
    let mut options = options();
    options.tail = Some(SnapshotTail {
        items: 2,
        bytes: 4096,
    });
    let mem = Mem::new(10);
    let mut subscription = Subscription::new(
        JsString::from("s"),
        Scope::Thread("t".to_owned()),
        Some(4),
        options,
    );
    // Unsafe to replay, so the resume gets a snapshot — a full one.
    mem.safe.set(false);
    let frames = subscription.start(&mem, 0).expect("start");
    snapshot(&frames);
    assert_eq!(mem.tails.borrow().as_slice(), &[None]);
}

/// "a first open carries the tail the client asked for".
#[test]
fn a_first_open_passes_the_tail_to_the_read() {
    let mut options = options();
    let tail = SnapshotTail {
        items: 30,
        bytes: 48 * 1024,
    };
    options.tail = Some(tail);
    let mem = Mem::new(10);
    let mut subscription = Subscription::new(
        JsString::from("s"),
        Scope::Thread("t".to_owned()),
        None,
        options,
    );
    subscription.start(&mem, 0).expect("start");
    assert_eq!(mem.tails.borrow().as_slice(), &[Some(tail)]);
}

/// "a thread whose missed events pass the replay limit gets a snapshot".
#[test]
fn a_replay_over_its_limit_gets_a_snapshot_without_reading_the_events() {
    let mem = Mem::new(20);
    let mut options = options();
    options.replay_limit = 2;
    mem.count.set(Some(3));
    mem.view.replace(thread_view(20, None, &["m1"]));
    let mut subscription = Subscription::new(
        JsString::from("s"),
        Scope::Thread("t".to_owned()),
        Some(10),
        options,
    );
    let frames = subscription.start(&mem, 0).expect("start");
    snapshot(&frames);
    let reads = mem.reads.borrow().clone();
    assert!(reads.contains(&"countThreadEvents".to_owned()), "{reads:?}");
    assert!(!reads.contains(&"readEvents".to_owned()), "{reads:?}");
}

/// "a resume past the replay limit gets the full snapshot, as a cursor with no replay does."
#[test]
fn a_list_cursor_past_the_limit_never_reads() {
    let mem = Mem::new(20);
    let mut options = options();
    options.replay_limit = 2;
    let mut subscription =
        Subscription::new(JsString::from("s"), Scope::Threads, Some(10), options);
    let frames = subscription.start(&mem, 0).expect("start");
    snapshot(&frames);
    let reads = mem.reads.borrow().clone();
    assert!(!reads.contains(&"readEvents".to_owned()), "{reads:?}");
    assert!(reads.contains(&"listThreads".to_owned()), "{reads:?}");
}

/// "a short resume still replays its events", with contiguous cursors.
#[test]
fn a_short_resume_replays_its_events() {
    let mem = Mem::new(12);
    mem.events
        .replace(vec![item_event(11, "t", "m1"), item_event(12, "t", "m2")]);
    let mut subscription = Subscription::new(
        JsString::from("s"),
        Scope::Thread("t".to_owned()),
        Some(10),
        options(),
    );
    let frames = subscription.start(&mem, 0).expect("start");
    assert_eq!(frames.len(), 1);
    let message = events(&frames[0]);
    assert_eq!(message.after_seq, 10.0);
    assert_eq!(message.through_seq, 12.0);
    assert_eq!(message.events.len(), 2);
    assert_eq!(subscription.cursor(), 12);
}

/// "a resume after a long streamed turn costs no more than a snapshot and shows the same
/// thread": the full snapshot, when it is smaller and holds what the deltas touched.
#[test]
fn a_long_streamed_turn_resumes_from_the_smaller_snapshot() {
    let mem = Mem::new(0);
    let mut events: Vec<DeliveryEvent> = Vec::new();
    for seq in 1..=600 {
        events.push(event(
            seq,
            "t",
            &format!(
                r#"{{"type":"item.delta","itemId":"reply","agentId":"a","field":"text","append":"line {seq} of a streamed answer"}}"#
            ),
        ));
    }
    mem.head.set(600);
    mem.events.replace(events);
    mem.count.set(Some(600));
    mem.view.replace(thread_view(600, None, &["reply"]));
    let mut subscription = Subscription::new(
        JsString::from("s"),
        Scope::Thread("t".to_owned()),
        Some(0),
        SubscribeOptions {
            replay_limit: 5000,
            ..options()
        },
    );
    let frames = subscription.start(&mem, 0).expect("start");
    let (seq, view) = snapshot(&frames);
    assert_eq!(*seq, 600);
    assert_eq!(subscription.cursor(), 600);
    let Some(Value::Object(items)) = view.get("items") else {
        panic!("items");
    };
    assert!(items.contains_key("reply"));
}

/// "each subscription hears only its thread's events and progress over the rest".
#[test]
fn a_batch_of_another_thread_advances_through_progress_after_250_ms() {
    let (mut subscription, mem) = open(Scope::Thread("t".to_owned()), None);
    mem.view.replace(thread_view(5, None, &["m1"]));
    mem.head.set(5);
    subscription.start(&mem, 1_000).expect("start");
    // Another thread's write, ahead of the cursor.
    let heard = subscription.hear(vec![item_event(7, "other", "x")], 7, 2_000);
    assert!(heard.is_empty());
    assert_eq!(
        subscription.progress_due(),
        Some(2_000 + DEFAULT_PROGRESS_INTERVAL_MS)
    );
    let flushed = subscription.flush_progress().expect("progress");
    match flushed {
        SubscriptionFrame::Progress {
            after_seq,
            through_seq,
            ..
        } => {
            assert_eq!((after_seq, through_seq), (5, 7));
        }
        _ => panic!("not progress"),
    }
    assert_eq!(subscription.cursor(), 7);
}

/// Its own events cover the range a pending progress would have: one events frame from the
/// old cursor through the batch's head, and the timer cancelled.
#[test]
fn a_subscriptions_own_events_cover_a_pending_progress() {
    let (mut subscription, mem) = open(Scope::Thread("t".to_owned()), None);
    mem.view.replace(thread_view(5, None, &["m1"]));
    mem.head.set(5);
    subscription.start(&mem, 1_000).expect("start");
    subscription.hear(vec![item_event(7, "other", "x")], 7, 2_000);
    let heard = subscription.hear(vec![item_event(9, "t", "mine")], 9, 2_100);
    assert_eq!(heard.len(), 1);
    let message = events(&heard[0]);
    assert_eq!(message.after_seq, 5.0);
    assert_eq!(message.through_seq, 9.0);
    assert_eq!(subscription.progress_due(), None);
    assert!(subscription.flush_progress().is_none());
    assert_eq!(subscription.cursor(), 9);
}

/// "a stopped subscription hears nothing more while others on the store still do": stopping
/// releases the thread read and silences the subscription.
#[test]
fn a_stopped_subscription_hears_nothing_more() {
    let (mut subscription, mem) = open(Scope::Thread("t".to_owned()), None);
    subscription.start(&mem, 0).expect("start");
    subscription.stop(&mem);
    assert_eq!(mem.released.get(), 1);
    let heard = subscription.hear(vec![item_event(1, "t", "late")], 1, 1_000);
    assert!(heard.is_empty());
    assert!(subscription.is_stopped());
    // A second stop releases nothing more.
    subscription.stop(&mem);
    assert_eq!(mem.released.get(), 1);
}

/// An unknown thread is the one error the socket answers `subscribe_failed` for.
#[test]
fn an_unknown_thread_fails_to_subscribe() {
    let mem = Mem::new(10);
    mem.exists.set(false);
    let mut subscription = Subscription::new(
        JsString::from("s"),
        Scope::Thread("gone".to_owned()),
        Some(4),
        options(),
    );
    assert_eq!(
        subscription.start(&mem, 0).map(|_| ()),
        Err(SubscribeError::UnknownThread)
    );
    assert!(subscription.is_stopped());
}

/// An interaction too large to send with its thread reaches a snapshot as its summary (ADR
/// 0157): `truncated` says so and the unbounded schema is left out.
#[test]
fn a_thread_snapshot_carries_a_bounded_interaction_summary() {
    let mem = Mem::new(1);
    let interaction = format!(
        r#"{{"id":"i","request":{{"kind":"elicitation","server":"s","message":"m","schema":{{"blob":"{}"}}}}}}"#,
        "x".repeat(200_000)
    );
    let view = parse(&format!(
        r#"{{"kind":"thread","seq":1,"thread":{{"id":"t","workspaceId":"w","title":"t","provider":"codex","status":{{"state":"new"}},"createdAt":1,"updatedAt":1}},"agents":{{}},"agentChildren":{{}},"runs":{{}},"items":{{}},"itemOrder":[],"itemsBefore":null,"interactions":{{"i":{interaction}}},"backgroundTasks":{{}},"usage":{{}},"contextMeters":{{}},"usageSnapshots":{{}}}}"#
    ));
    *mem.view.borrow_mut() = view;
    let mut subscription = Subscription::new(
        JsString::from("s"),
        Scope::Thread("t".to_owned()),
        None,
        options(),
    );
    let frames = subscription.start(&mem, 0).expect("start");
    let SubscriptionFrame::Snapshot { view, .. } = &frames[0] else {
        panic!("snapshot");
    };
    let Some(Value::Object(interactions)) = view.get("interactions") else {
        panic!("interactions");
    };
    let Some(Value::Object(interaction)) = interactions.get("i") else {
        panic!("interaction");
    };
    assert!(interaction.contains_key("truncated"));
    let Some(Value::Object(request)) = interaction.get("request") else {
        panic!("request");
    };
    assert!(!request.contains_key("schema"));
    assert!(ace_json::to_string(view).len() < 100_000);
}

/// A live `interaction.opened` event reaches its subscriber summarized too.
#[test]
fn a_live_interaction_event_is_sent_summarized() {
    let (mut subscription, mem) = open(Scope::Thread("t".to_owned()), None);
    subscription.start(&mem, 0).expect("start");
    let interaction = format!(
        r#"{{"id":"i","request":{{"kind":"elicitation","server":"s","message":"m","schema":{{"blob":"{}"}}}}}}"#,
        "x".repeat(200_000)
    );
    let heard = subscription.hear(
        vec![event(
            11,
            "t",
            &format!(r#"{{"type":"interaction.opened","interaction":{interaction}}}"#),
        )],
        11,
        1_000,
    );
    let SubscriptionFrame::Events(message) = &heard[0] else {
        panic!("events");
    };
    let view = message.events[0].value();
    let Some(Value::Object(payload)) = view.get("payload") else {
        panic!("payload");
    };
    let Some(Value::Object(interaction)) = payload.get("interaction") else {
        panic!("interaction");
    };
    assert!(interaction.contains_key("truncated"));
}

/// A replay is weighed in the bytes clients get: a huge interaction event that goes summarized
/// replays instead of forcing a snapshot, and never makes a frame over the client's limit.
#[test]
fn a_replay_is_weighed_after_interactions_are_summarized() {
    let mem = Mem::new(1);
    let interaction = format!(
        r#"{{"id":"i","request":{{"kind":"elicitation","server":"s","message":"m","schema":{{"blob":"{}"}}}}}}"#,
        "x".repeat(2 * 1024 * 1024)
    );
    *mem.events.borrow_mut() = vec![event(
        1,
        "t",
        &format!(r#"{{"type":"interaction.opened","interaction":{interaction}}}"#),
    )];
    let mut subscription = Subscription::new(
        JsString::from("s"),
        Scope::Thread("t".to_owned()),
        Some(0),
        options(),
    );
    let frames = subscription.start(&mem, 0).expect("start");
    let SubscriptionFrame::Events(message) = &frames[0] else {
        panic!("a replay, not a snapshot");
    };
    let Some(Value::Object(payload)) = message.events[0].value().get("payload") else {
        panic!("payload");
    };
    let Some(Value::Object(interaction)) = payload.get("interaction") else {
        panic!("interaction");
    };
    assert!(interaction.contains_key("truncated"));
}
