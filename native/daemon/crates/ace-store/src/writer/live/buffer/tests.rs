// SPDX-License-Identifier: Apache-2.0
//! The buffer's behaviour, against what `LiveWriteBuffer` in TypeScript does.

use super::{Admission, Buffer, EVENT_DELAY_MS, QUIET_DELAY_MS};
use ace_json::JsString;

/// One appended event of `bytes` JSON bytes at `seq`.
fn pinned(buffer: &mut Buffer, thread: &str, seq: f64, bytes: f64) -> Option<u64> {
    buffer.append(thread, &[(seq, bytes)])
}

/// A thread key as the binding hands one over.
fn key(thread: &str) -> JsString {
    JsString::from(thread)
}

#[test]
fn an_event_adds_eight_times_its_json_bytes_and_a_fixed_row_cost() {
    let mut buffer = Buffer::new();
    assert_eq!(pinned(&mut buffer, "a", 1.0, 100.0), Some(EVENT_DELAY_MS));
    assert_eq!(buffer.bytes(), 100.0 * 8.0 + 512.0);
    assert_eq!(buffer.head(), Some(1.0));
    assert_eq!(buffer.size(), 1);
    assert!(!buffer.quiet());
    pinned(&mut buffer, "a", 2.0, 100.0);
    assert_eq!(buffer.bytes(), 2.0 * (100.0 * 8.0 + 512.0));
    assert_eq!(buffer.head(), Some(2.0));
    let metrics = buffer.metrics();
    assert_eq!(metrics.live_bytes, 200.0);
    assert_eq!(metrics.peak_bytes, buffer.bytes());
}

#[test]
fn a_liveness_batch_waits_a_second_and_a_shorter_deadline_replaces_it() {
    let mut buffer = Buffer::new();
    // No events: only a snapshot, which nobody has seen, so it waits 1 s.
    assert_eq!(buffer.append("a", &[]), Some(QUIET_DELAY_MS));
    assert!(buffer.quiet());
    // A delta in the same batch now waits 75 ms, which replaces the longer deadline.
    assert_eq!(pinned(&mut buffer, "a", 1.0, 1.0), Some(EVENT_DELAY_MS));
    // A second delta may not push the deadline out: the armed 75 ms stands.
    assert_eq!(pinned(&mut buffer, "a", 2.0, 1.0), None);
    // A re-arm keeps the same deadline rather than scheduling another.
    assert_eq!(buffer.rearm(), None);
    assert!(buffer.begin());
    assert!(!buffer.begin());
    assert_eq!(buffer.rearm(), Some(EVENT_DELAY_MS));
}

#[test]
fn the_buffer_asks_for_a_flush_at_64_kib_and_refuses_a_batch_past_8_mib() {
    let mut buffer = Buffer::new();
    assert!(!buffer.full());
    // Each event weighs 968 bytes; 68 of them pass 64 KiB.
    for index in 0..68 {
        pinned(&mut buffer, "a", index as f64 + 1.0, 57.0);
    }
    assert!(buffer.full());
    // A batch charges `bytes * 8 + 4096`, with no per-row cost of its own: 8,376,000 plus
    // 12,288 still fits 8 MiB, and one row's 512 bytes more would have drained it. A byte
    // over the exact ceiling drains it.
    let mut near = Buffer::new();
    pinned(&mut near, "a", 1.0, 1_046_936.0);
    assert_eq!(near.admission(1024.0), Admission::Admit);
    assert_eq!(near.admission(1064.0), Admission::Admit);
    assert_eq!(near.admission(1065.0), Admission::Drain);
    assert_eq!(near.admission(8_000_000.0), Admission::Never);
    let empty = Buffer::new();
    assert_eq!(empty.admission(1024.0), Admission::Admit);
}

#[test]
fn committing_every_thread_clears_the_batch_and_settles_a_retrying_one() {
    let mut buffer = Buffer::new();
    pinned(&mut buffer, "a", 1.0, 10.0);
    pinned(&mut buffer, "b", 2.0, 20.0);
    let _ = pinned(&mut buffer, "a", 3.0, 10.0);
    buffer.retry();
    assert!(buffer.failed());
    // Only one thread of two: the rest stays pinned, failures included.
    let wake = buffer.committed(&[key("a")], 3);
    assert_eq!(wake.size, 1);
    assert!(!wake.woke);
    assert!(!wake.cancelled);
    assert!(buffer.failed());
    assert_eq!(buffer.size(), 1);
    assert_eq!(buffer.bytes(), 20.0 * 8.0 + 512.0);
    assert_eq!(buffer.head(), Some(2.0));
    assert!(!buffer.has(&key("a")));
    assert_eq!(buffer.metrics().flushes, 1);
    assert_eq!(buffer.metrics().rows, 3);
    // The last thread: the batch empties, the failure clears and the timer is dropped.
    let wake = buffer.committed(&[key("b")], 1);
    assert_eq!(wake.size, 0);
    assert!(wake.woke);
    assert!(wake.cancelled);
    assert!(!buffer.failed());
    assert_eq!(buffer.bytes(), 0.0);
    assert_eq!(buffer.head(), None);
    assert_eq!(buffer.metrics().flushes, 2);
    assert_eq!(buffer.metrics().rows, 4);
    // A fresh batch arms again from a clean state.
    assert_eq!(pinned(&mut buffer, "a", 4.0, 1.0), Some(EVENT_DELAY_MS));
}

#[test]
fn discarding_a_quarantined_thread_keeps_the_others_and_their_deadline() {
    let mut buffer = Buffer::new();
    pinned(&mut buffer, "a", 1.0, 10.0);
    pinned(&mut buffer, "b", 2.0, 20.0);
    buffer.retry();
    let wake = buffer.discard(&key("a"));
    assert_eq!(wake.size, 1);
    assert!(!wake.woke);
    assert_eq!(buffer.threads(), &[key("b")]);
    assert_eq!(buffer.bytes(), 20.0 * 8.0 + 512.0);
    assert_eq!(buffer.metrics().flushes, 0);
    assert!(buffer.failed());
    // Discarding the last thread settles the buffer without a flush or a row count.
    let wake = buffer.discard(&key("b"));
    assert!(wake.woke);
    assert_eq!(buffer.size(), 0);
    assert_eq!(buffer.metrics().flushes, 0);
    assert_eq!(buffer.metrics().rows, 0);
}

#[test]
fn a_retry_doubles_its_deadline_and_counts_every_failure() {
    let mut buffer = Buffer::new();
    pinned(&mut buffer, "a", 1.0, 10.0);
    assert_eq!(buffer.retry(), 100);
    assert_eq!(buffer.retry(), 200);
    assert_eq!(buffer.metrics().failures, 2);
    // A batch that gains a row again is written sooner than the retry's 200 ms.
    assert_eq!(buffer.rearm(), Some(EVENT_DELAY_MS));
    assert_eq!(buffer.rearm(), None);
    assert!(buffer.begin());
}

#[test]
fn after_returns_the_first_event_past_the_published_sequence() {
    let mut buffer = Buffer::new();
    pinned(&mut buffer, "a", 10.0, 1.0);
    pinned(&mut buffer, "a", 11.0, 1.0);
    pinned(&mut buffer, "a", 20.0, 1.0);
    assert_eq!(buffer.after(0.0), 0);
    assert_eq!(buffer.after(10.0), 1);
    assert_eq!(buffer.after(11.0), 2);
    assert_eq!(buffer.after(20.0), 3);
    let empty = Buffer::new();
    assert_eq!(empty.after(0.0), 0);
}

#[test]
fn a_fired_deadline_is_no_longer_armed() {
    let mut buffer = Buffer::new();
    pinned(&mut buffer, "a", 1.0, 10.0);
    assert!(buffer.fired());
    assert!(!buffer.fired());
    assert!(!buffer.begin());
    assert_eq!(buffer.rearm(), Some(EVENT_DELAY_MS));
    assert!(buffer.stop());
}
