// SPDX-License-Identifier: Apache-2.0
//! One connection's subscription: the handoff from a read to live events, step for step as
//! `apps/daemon/src/subscription.ts` does it (behaviour.md §9).
//!
//! 1. The shell registers for live events before any read; every batch heard while the
//!    subscription initializes is queued.
//! 2. [`Subscription::start`] reads the snapshot or the replay, with the head watermark of the
//!    same read, and sends it.
//! 3. It then delivers the queued batches strictly above the cursor, and live batches the same
//!    way. Cursors stay contiguous through events the scope filters out, which advance through
//!    a `progress` frame within `progress_interval_ms`.
//!
//! Replay is bounded (`replay_limit`, 5,000 events and 2 MiB), never history-sized (ADR 0170):
//! a replay that overflows becomes a snapshot, and a cursor further behind than the limit never
//! reads at all. The store reads are the shell's ([`SubscriptionStore`]): the daemon runs them
//! on its reader pool and feeds the results in; nothing here owns a thread, a timer or a global.

use ace_json::{JsString, Map, Number, Value};
use ace_projection::{changed_item_id, is_sidebar_event, wire_thread_view};

use crate::encode::{EventsMessage, WHOLE_EVENTS, WireEncoder};
use crate::event::DeliveryEvent;
use crate::js::{field, field_text, number, object};

/// A list cursor further behind than this gets a snapshot instead of its replay (5000 events).
pub const DEFAULT_REPLAY_LIMIT: usize = 5_000;
/// Events filtered out of a scope advance the cursor through a progress frame this often.
pub const DEFAULT_PROGRESS_INTERVAL_MS: u64 = 250;
/// A replay is split into frames of about this many event bytes, well below the client's 2 MiB
/// frame limit. A single larger event still travels alone.
pub const REPLAY_FRAME_BYTES: usize = 1024 * 1024;
/// A thread replay at or under this many bytes is sent without weighing a snapshot against it.
pub const REPLAY_COMPARE_BYTES: usize = 16 * 1024;
/// A replay reads at most this many event bytes.
pub const REPLAY_READ_BYTES: usize = REPLAY_FRAME_BYTES * 2;

/// What a first open of a thread carries: its newest items within this many items and bytes.
/// The read's own rules (T4) shape the view; the subscription only hands it on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotTail {
    pub items: usize,
    pub bytes: usize,
}

/// What a subscription covers: one thread, or the sidebar's list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scope {
    Thread(String),
    Threads,
}

impl Scope {
    fn thread(&self) -> Option<&str> {
        match self {
            Scope::Thread(thread) => Some(thread),
            Scope::Threads => None,
        }
    }

    fn matches(&self, event: &DeliveryEvent) -> bool {
        match self {
            Scope::Thread(thread) => event
                .thread_id()
                .is_some_and(|seen| seen.as_str() == thread.as_str()),
            Scope::Threads => event
                .payload_type()
                .is_some_and(|kind| is_sidebar_event(kind.as_str())),
        }
    }
}

/// How one subscription behaves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubscribeOptions {
    pub replay_limit: usize,
    pub progress_interval_ms: u64,
    pub paced: bool,
    pub tail: Option<SnapshotTail>,
}

impl Default for SubscribeOptions {
    fn default() -> SubscribeOptions {
        SubscribeOptions {
            replay_limit: DEFAULT_REPLAY_LIMIT,
            progress_interval_ms: DEFAULT_PROGRESS_INTERVAL_MS,
            paced: false,
            tail: None,
        }
    }
}

/// The reads a subscription asks its shell for. Every call is bounded: a snapshot is one
/// thread or one list, a replay at most `limit` events and a byte budget, a count at most
/// `limit`. The daemon answers them from `ace-store` on the reader pool; nothing here performs
/// I/O or schedules work.
pub trait SubscriptionStore {
    /// `headSeq()`: the highest committed sequence.
    fn head_seq(&self) -> u64;
    /// `replaySafe(afterSeq)`: whether a cursor can replay without double-appending a
    /// compacted delta. A store without the concept says yes.
    fn replay_safe(&self, after_seq: u64) -> bool {
        let _ = after_seq;
        true
    }
    /// `getThread(threadId) !== undefined`.
    fn get_thread(&self, thread: &str) -> bool;
    /// `acquireThread`: hold a snapshot read's thread until the subscription stops.
    fn acquire_thread(&self, thread: &str) {
        let _ = thread;
    }
    fn release_thread(&self, thread: &str) {
        let _ = thread;
    }
    /// `snapshotThread(threadId, tail)`: the thread's view, frozen or copied.
    fn snapshot_thread(&self, thread: &str, tail: Option<SnapshotTail>) -> Value;
    /// `createThreadListView(store.listThreads())`: the sidebar's list view.
    fn list_threads(&self) -> Value;
    /// `countThreadEvents(...)`: how many of the thread's events lie in `(after, through]`,
    /// counting at most `limit`; `None` when the store cannot count.
    fn count_thread_events(
        &self,
        thread: &str,
        after: u64,
        through: u64,
        limit: usize,
    ) -> Option<usize> {
        let _ = (thread, after, through, limit);
        None
    }
    /// `readEvents`: at most `limit` events above `after` and through `head`, stopping after the
    /// event that crosses `byte_limit`, for one thread or the whole log. `complete` says whether
    /// the read reached the end of that range or the budget stopped it first.
    fn read_events(
        &self,
        after: u64,
        limit: usize,
        byte_limit: usize,
        head: u64,
        thread: Option<&str>,
    ) -> EventRead;
}

/// A bounded replay read's result (`readEvents`): the events and whether the read reached the
/// end of its range.
///
/// §9's rule is that a replay covers through the head it reports or becomes a snapshot. A read
/// that stopped at its byte budget with more events still in `(after, head]` must say so
/// (`complete: false`); the subscription then sends a snapshot instead of claiming a cursor it
/// never read. Summarizing an interaction can hide that overflow from the byte count, so the
/// count alone can never decide this.
#[derive(Debug, Default)]
pub struct EventRead {
    pub events: Vec<DeliveryEvent>,
    /// `true` when the read returned every event in its range; `false` when its byte budget
    /// stopped it first.
    pub complete: bool,
}

impl EventRead {
    /// A read that reached the end of its range.
    pub fn complete(events: Vec<DeliveryEvent>) -> EventRead {
        EventRead {
            events,
            complete: true,
        }
    }

    /// A read the byte budget stopped before its range ended.
    pub fn incomplete(events: Vec<DeliveryEvent>) -> EventRead {
        EventRead {
            events,
            complete: false,
        }
    }
}

/// Why a subscription could not start. The socket answers `subscribe_failed` with the
/// TypeScript's wording; only an unknown thread reaches here (an invalid cursor is the socket's
/// check of the generated message).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubscribeError {
    UnknownThread,
}

/// One message a subscription sends.
#[derive(Clone, Debug)]
pub enum SubscriptionFrame {
    Snapshot {
        subscription_id: JsString,
        seq: u64,
        view: Value,
    },
    Events(EventsMessage),
    Progress {
        subscription_id: JsString,
        after_seq: u64,
        through_seq: u64,
    },
    Ready {
        subscription_id: JsString,
        seq: u64,
    },
}

impl SubscriptionFrame {
    /// The message as the wire's object (`encode` serializes it; an events frame is handed to
    /// the encoder instead).
    pub fn to_value(&self) -> Value {
        match self {
            SubscriptionFrame::Snapshot {
                subscription_id,
                seq,
                view,
            } => {
                let mut message = Map::with_capacity(4);
                message.insert("type", Value::String(JsString::from("snapshot")));
                message.insert("subscriptionId", Value::String(subscription_id.clone()));
                message.insert("seq", Value::Number(Number::from(*seq)));
                message.insert("view", view.clone());
                Value::Object(message)
            }
            SubscriptionFrame::Events(message) => {
                let mut out = Map::with_capacity(5);
                out.insert("type", Value::String(JsString::from("events")));
                out.insert(
                    "subscriptionId",
                    Value::String(message.subscription_id.clone()),
                );
                out.insert(
                    "afterSeq",
                    Value::Number(Number::from(message.after_seq as u64)),
                );
                out.insert(
                    "throughSeq",
                    Value::Number(Number::from(message.through_seq as u64)),
                );
                let events: Vec<Value> = message
                    .events
                    .iter()
                    .map(|event| event.value().clone())
                    .collect();
                out.insert("events", Value::Array(events.into()));
                Value::Object(out)
            }
            SubscriptionFrame::Progress {
                subscription_id,
                after_seq,
                through_seq,
            } => {
                let mut message = Map::with_capacity(4);
                message.insert("type", Value::String(JsString::from("progress")));
                message.insert("subscriptionId", Value::String(subscription_id.clone()));
                message.insert("afterSeq", Value::Number(Number::from(*after_seq)));
                message.insert("throughSeq", Value::Number(Number::from(*through_seq)));
                Value::Object(message)
            }
            SubscriptionFrame::Ready {
                subscription_id,
                seq,
            } => {
                let mut message = Map::with_capacity(3);
                message.insert("type", Value::String(JsString::from("subscription.ready")));
                message.insert("subscriptionId", Value::String(subscription_id.clone()));
                message.insert("seq", Value::Number(Number::from(*seq)));
                Value::Object(message)
            }
        }
    }
}

/// One subscription. The shell creates it, registers its live listener, calls
/// [`Subscription::start`], then forwards each live batch to [`Subscription::hear`].
pub struct Subscription {
    id: JsString,
    scope: Scope,
    after_seq: Option<u64>,
    options: SubscribeOptions,
    cursor: u64,
    progress_head: u64,
    progress_due: Option<u64>,
    initializing: bool,
    stopped: bool,
    queued: Vec<DeliveryEvent>,
    queued_head: u64,
    acquired: Option<String>,
    encoder: WireEncoder,
}

impl Subscription {
    /// A subscription about to initialize. `after_seq` is the client's resume cursor; `0` when
    /// absent is what the TypeScript starts its cursor at.
    pub fn new(
        id: JsString,
        scope: Scope,
        after_seq: Option<u64>,
        options: SubscribeOptions,
    ) -> Subscription {
        Subscription {
            id,
            scope,
            after_seq,
            options,
            cursor: after_seq.unwrap_or(0),
            progress_head: after_seq.unwrap_or(0),
            progress_due: None,
            initializing: true,
            stopped: false,
            queued: Vec::new(),
            queued_head: 0,
            acquired: None,
            encoder: WireEncoder::new(),
        }
    }

    pub fn id(&self) -> &JsString {
        &self.id
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// The cursor every frame continues from.
    pub fn cursor(&self) -> u64 {
        self.cursor
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped
    }

    /// When the shell should call [`Subscription::flush_progress`]: the progress interval
    /// after a batch left only filtered-out events. `None` when no progress is pending.
    pub fn progress_due(&self) -> Option<u64> {
        self.progress_due
    }

    /// A live batch. While initializing it is queued; afterwards it is delivered. `now_ms` is
    /// the shell's clock, read only to date a scheduled progress frame.
    pub fn hear(
        &mut self,
        events: Vec<DeliveryEvent>,
        head: u64,
        now_ms: u64,
    ) -> Vec<SubscriptionFrame> {
        let mut frames = Vec::new();
        if self.stopped {
            return frames;
        }
        if !self.initializing {
            self.deliver(events, head, false, now_ms, &mut frames);
        } else {
            self.queued_head = self.queued_head.max(head);
            self.queued.extend(events);
        }
        frames
    }

    /// Read the snapshot or replay (bounded), send it, then drain the batches queued while the
    /// read ran. Errors leave the subscription stopped, as the TypeScript stops before it
    /// rethrows.
    pub fn start(
        &mut self,
        store: &dyn SubscriptionStore,
        now_ms: u64,
    ) -> Result<Vec<SubscriptionFrame>, SubscribeError> {
        let mut frames = Vec::new();
        let result = self.start_inner(store, now_ms, &mut frames);
        match result {
            Ok(()) => {
                if self.options.paced {
                    frames.push(SubscriptionFrame::Ready {
                        subscription_id: self.id.clone(),
                        seq: self.cursor,
                    });
                }
                self.initializing = false;
                let pending = std::mem::take(&mut self.queued);
                let last = pending
                    .last()
                    .and_then(DeliveryEvent::seq)
                    .map(|seq| seq as u64);
                let head = self.queued_head.max(last.unwrap_or(0));
                self.deliver(pending, head, false, now_ms, &mut frames);
                Ok(frames)
            }
            Err(error) => {
                self.stop(store);
                Err(error)
            }
        }
    }

    /// Stop: release the thread read's hold. The shell removes its live listener; a stopped
    /// subscription sends nothing more.
    pub fn stop(&mut self, store: &dyn SubscriptionStore) {
        if self.stopped {
            return;
        }
        self.stopped = true;
        self.progress_due = None;
        if let Some(thread) = self.acquired.take() {
            store.release_thread(&thread);
        }
    }

    /// `flushProgress`: the contiguous cursor through events the scope filtered out.
    pub fn flush_progress(&mut self) -> Option<SubscriptionFrame> {
        self.progress_due = None;
        if self.stopped || self.progress_head <= self.cursor {
            return None;
        }
        let previous = self.cursor;
        self.cursor = self.progress_head;
        Some(SubscriptionFrame::Progress {
            subscription_id: self.id.clone(),
            after_seq: previous,
            through_seq: self.cursor,
        })
    }

    fn start_inner(
        &mut self,
        store: &dyn SubscriptionStore,
        now_ms: u64,
        frames: &mut Vec<SubscriptionFrame>,
    ) -> Result<(), SubscribeError> {
        let mut replay_safe = self.after_seq.is_none();
        let initial_head = match self.after_seq {
            Some(after) => {
                replay_safe = store.replay_safe(after);
                Some(store.head_seq())
            }
            None => None,
        };
        let too_far = self.scope.thread().is_none()
            && self.after_seq.is_some_and(|after| {
                initial_head.unwrap_or(0).saturating_sub(after) as usize > self.options.replay_limit
            });
        let cursor_unusable = self
            .after_seq
            .is_some_and(|after| after > initial_head.unwrap_or(0));
        if self.after_seq.is_none() || cursor_unusable || too_far || !replay_safe {
            let view = self.read_snapshot(store);
            let head = store.head_seq();
            self.cursor = head;
            self.progress_head = head;
            frames.push(SubscriptionFrame::Snapshot {
                subscription_id: self.id.clone(),
                seq: head,
                view: with_seq(view, head),
            });
            return Ok(());
        }
        let Some(after) = self.after_seq else {
            return Ok(());
        };
        if let Some(thread) = self.scope.thread()
            && !store.get_thread(thread)
        {
            return Err(SubscribeError::UnknownThread);
        }
        let head = initial_head.unwrap_or(0);
        if head <= after {
            return Ok(());
        }
        let overflows = match self.scope.thread() {
            Some(thread) => store
                .count_thread_events(thread, after, head, self.options.replay_limit + 1)
                .is_some_and(|count| count > self.options.replay_limit),
            None => false,
        };
        let read = if overflows {
            EventRead::default()
        } else {
            store.read_events(
                after,
                self.options.replay_limit + 1,
                REPLAY_READ_BYTES,
                head,
                self.scope.thread(),
            )
        };
        // §9: a prefix never advances the cursor. The read says whether it covered the range;
        // the byte count after summarizing cannot, since a summary can hide an overflow.
        let incomplete = !read.complete;
        let events: Vec<DeliveryEvent> = read
            .events
            .into_iter()
            .filter(|event| event.seq().is_some_and(|seq| seq as u64 <= head))
            .map(|event| event.wired())
            .collect();
        let bytes: usize = events
            .iter()
            .map(|event| self.encoder.event_bytes(event, WHOLE_EVENTS))
            .sum();
        // Only a complete replay is worth weighing against a snapshot.
        let cheaper = if incomplete || overflows {
            None
        } else if self.scope.thread().is_some() && bytes > REPLAY_COMPARE_BYTES {
            self.smaller_snapshot(store, after, &events, bytes, head)
        } else {
            None
        };
        if overflows
            || incomplete
            || events.len() > self.options.replay_limit
            || bytes > REPLAY_READ_BYTES
            || events
                .iter()
                .any(|event| self.encoder.event_bytes(event, WHOLE_EVENTS) > REPLAY_FRAME_BYTES)
        {
            self.cursor = head;
            self.progress_head = head;
            let frame = cheaper.unwrap_or_else(|| self.snapshot_at(store, head));
            frames.push(frame);
        } else if let Some(cheaper) = cheaper {
            self.cursor = head;
            self.progress_head = head;
            frames.push(cheaper);
        } else {
            self.deliver(events, head, true, now_ms, frames);
        }
        Ok(())
    }

    /// `snapshotThread(threadId, tail?)` or `createThreadListView(listThreads())`, holding the
    /// thread read for as long as the subscription lives.
    fn read_snapshot(&mut self, store: &dyn SubscriptionStore) -> Value {
        match self.scope.thread() {
            Some(thread) => {
                store.acquire_thread(thread);
                self.acquired = Some(thread.to_owned());
                let tail = if self.after_seq.is_none() {
                    self.options.tail
                } else {
                    None
                };
                wired_view(store.snapshot_thread(thread, tail))
            }
            None => store.list_threads(),
        }
    }

    /// The `snapshot()` the replay branch compares and falls back to: the view read now, with
    /// the replay's head.
    fn snapshot_at(&self, store: &dyn SubscriptionStore, head: u64) -> SubscriptionFrame {
        let view = match self.scope.thread() {
            Some(thread) => wired_view(store.snapshot_thread(thread, None)),
            None => store.list_threads(),
        };
        SubscriptionFrame::Snapshot {
            subscription_id: self.id.clone(),
            seq: head,
            view: with_seq(view, head),
        }
    }

    /// `smallerSnapshot(...)`: the full snapshot, when it costs fewer bytes than the replay and
    /// the client ends where the replay would leave it. It must hold every item the client
    /// would keep and every item a missed event changed (ADR 0062).
    fn smaller_snapshot(
        &self,
        store: &dyn SubscriptionStore,
        after: u64,
        missed: &[DeliveryEvent],
        replay_bytes: usize,
        head: u64,
    ) -> Option<SubscriptionFrame> {
        let frame = self.snapshot_at(store, head);
        let SubscriptionFrame::Snapshot { view, .. } = &frame else {
            return None;
        };
        if field_text(view, "kind").is_none_or(|kind| kind != "thread") {
            return None;
        }
        if let Some(items_before) = field(view, "itemsBefore").and_then(number)
            && items_before > after as f64 + 1.0
        {
            return None;
        }
        let items = field(view, "items").and_then(object);
        for event in missed {
            let Some(payload) = field(event.value(), "payload") else {
                continue;
            };
            let Some(changed) = changed_item_id(payload) else {
                continue;
            };
            let items = items?;
            if !items.contains_key(changed.as_str()) {
                return None;
            }
        }
        let message = frame.to_value();
        (ace_json::to_string(&message).len() < replay_bytes).then_some(frame)
    }

    /// `deliver(events, head, replay)`: send what the scope takes, or move the cursor through
    /// what it filters out.
    fn deliver(
        &mut self,
        events: Vec<DeliveryEvent>,
        head: u64,
        replay: bool,
        now_ms: u64,
        frames: &mut Vec<SubscriptionFrame>,
    ) {
        if self.stopped || head <= self.cursor {
            return;
        }
        let cursor = self.cursor;
        let selected: Vec<DeliveryEvent> = events
            .into_iter()
            .filter(|event| {
                event
                    .seq()
                    .is_some_and(|seq| seq as u64 > cursor && seq as u64 <= head)
                    && self.scope.matches(event)
            })
            .map(|event| event.wired())
            .collect();
        self.progress_head = self.progress_head.max(head);
        if !selected.is_empty() {
            self.progress_due = None;
            let mut built = replay_frames(selected, &self.encoder, &self.id);
            let last = built.len().saturating_sub(1);
            for (index, frame) in built.drain(..).enumerate() {
                if self.stopped {
                    return;
                }
                let previous = self.cursor;
                self.cursor = if index == last {
                    head
                } else {
                    frame
                        .events
                        .last()
                        .and_then(DeliveryEvent::seq)
                        .map(|seq| seq as u64)
                        .unwrap_or(previous)
                };
                let mut message = frame;
                message.subscription_id = self.id.clone();
                message.after_seq = previous as f64;
                message.through_seq = self.cursor as f64;
                frames.push(SubscriptionFrame::Events(message));
            }
        } else if replay {
            self.progress_due = None;
            if let Some(frame) = self.flush_progress() {
                frames.push(frame);
            }
        } else if self.progress_due.is_none() {
            self.progress_due = Some(now_ms + self.options.progress_interval_ms);
        }
    }
}

/// `replayFrames(events)`: the selected events cut into about `REPLAY_FRAME_BYTES` frames.
fn replay_frames(
    events: Vec<DeliveryEvent>,
    encoder: &WireEncoder,
    subscription_id: &JsString,
) -> Vec<EventsMessage> {
    let mut frames = Vec::new();
    let mut frame: Vec<DeliveryEvent> = Vec::new();
    let mut bytes = 0;
    for event in events {
        let size = encoder.event_bytes(&event, WHOLE_EVENTS);
        if !frame.is_empty() && bytes + size > REPLAY_FRAME_BYTES {
            frames.push(frame);
            frame = Vec::new();
            bytes = 0;
        }
        frame.push(event);
        bytes += size;
    }
    if !frame.is_empty() {
        frames.push(frame);
    }
    frames
        .into_iter()
        .map(|events| {
            let through = events.last().and_then(DeliveryEvent::seq).unwrap_or(0.0);
            EventsMessage {
                subscription_id: subscription_id.clone(),
                after_seq: 0.0,
                through_seq: through,
                early: false,
                events,
            }
        })
        .collect()
}

/// `wireThreadView(view)`: the view clients get, or the view itself when nothing is summarized.
fn wired_view(view: Value) -> Value {
    wire_thread_view(&view).unwrap_or(view)
}

/// `{ ...view, seq: head }`: a snapshot's cursor is its view's cursor.
fn with_seq(mut view: Value, head: u64) -> Value {
    if let Some(map) = object_mut(&mut view) {
        map.insert("seq", Value::Number(Number::from(head)));
    }
    view
}

fn object_mut(value: &mut Value) -> Option<&mut Map> {
    match value {
        Value::Object(map) => Some(map),
        _ => None,
    }
}
