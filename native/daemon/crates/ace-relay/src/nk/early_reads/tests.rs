//! Ports `apps/daemon/src/relay-nk/early-reads.test.ts`: a bounded resume is answered early
//! as XX's replay would be, and everything else costs nothing until confirmation.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use ace_json::Value;

use super::{
    BoundedRead, CursorUnreadable, EARLY_REPLAY_BYTES, EarlyEncoder, EarlyReads, EarlyStore,
    answer_early,
};
use crate::nk::admission::{Cancel, NK_LIMITS, NkAdmission, NkClock, NkSession};
use crate::nk::hello::{EarlyScope, EarlySubscribe, Tail};

struct ZeroClock;
impl NkClock for ZeroClock {
    fn now(&self) -> i64 {
        0
    }
    fn schedule(&self, _milliseconds: i64, _run: Box<dyn FnOnce() + Send>) -> Cancel {
        Box::new(|| {})
    }
}

struct Encoder;
impl EarlyEncoder for Encoder {
    fn event_bytes(&self, event: &Value) -> usize {
        ace_json::to_string(event).len()
    }
}

struct Table {
    head: u64,
    events: Vec<(String, Value, usize)>,
    live: bool,
    replay_safe: Result<bool, CursorUnreadable>,
}

impl EarlyStore for Table {
    fn head_seq(&self) -> u64 {
        self.head
    }

    fn has_live_thread(&self, _thread_id: &str) -> bool {
        self.live
    }

    fn replay_safe(&self, _after_seq: u64) -> Result<bool, CursorUnreadable> {
        self.replay_safe
    }

    fn bounded_thread_events(
        &self,
        thread_id: &str,
        after_seq: u64,
        _head: u64,
        rows: usize,
        bytes: usize,
    ) -> Option<BoundedRead> {
        let missed: Vec<&(String, Value, usize)> = self
            .events
            .iter()
            .filter(|(thread, _, _)| thread == thread_id)
            .collect();
        if missed.len() > rows {
            return None;
        }
        let total: usize = missed.iter().map(|(_, _, size)| size).sum();
        if total > bytes {
            return None;
        }
        let events = missed.iter().map(|(_, event, _)| event.clone()).collect();
        let _ = after_seq;
        Some(BoundedRead {
            events,
            bytes: total,
        })
    }
}

fn setup() -> (NkSession, Table, Vec<Value>) {
    let admission = NkAdmission::new(Arc::new(ZeroClock), NK_LIMITS);
    let session = admission.admit("phone", || {}).unwrap();
    (
        session,
        Table {
            head: 0,
            events: Vec::new(),
            live: true,
            replay_safe: Ok(true),
        },
        Vec::new(),
    )
}

fn subscribe(thread_id: &str, after_seq: Option<u64>) -> EarlySubscribe {
    EarlySubscribe {
        subscription_id: "t".to_owned(),
        scope: EarlyScope::Thread {
            thread_id: thread_id.to_owned(),
        },
        paced: false,
        after_seq,
        tail: None,
    }
}

fn event(thread_id: &str, size: usize) -> (String, Value, usize) {
    let text = "x".repeat(size);
    let value = ace_json::parse(&format!("{{\"type\":\"item\",\"text\":\"{text}\"}}")).unwrap();
    (thread_id.to_owned(), value, size)
}

#[test]
fn a_resume_with_a_tiny_tail_on_a_thread_with_mebibytes_missed_reads_nothing_and_is_held() {
    let (session, mut table, mut sent) = setup();
    table.head = 40;
    table.events = (0..40).map(|_| event("t", 100 * 1024)).collect();
    let mut request = subscribe("t", Some(0));
    request.tail = Some(Tail {
        items: 1,
        bytes: 1_024,
    });
    let later = answer_early(
        std::slice::from_ref(&request),
        &mut EarlyReads {
            session: &session,
            store: &table,
            can_read: &|_| true,
            encoder: &Encoder,
            send: &mut |message| sent.push(message),
        },
    );
    assert!(sent.is_empty());
    assert_eq!(session.remaining().events, NK_LIMITS.session_events);
    assert_eq!(session.remaining().bytes, NK_LIMITS.session_bytes);
    assert_eq!(later, vec![request.to_subscribe_message(None)]);
}

#[test]
fn one_event_larger_than_the_budget_is_not_decoded_and_nothing_is_answered() {
    let (session, mut table, mut sent) = setup();
    table.head = 1;
    table.events = vec![event("t", EARLY_REPLAY_BYTES * 4)];
    let request = subscribe("t", Some(0));
    let later = answer_early(
        std::slice::from_ref(&request),
        &mut EarlyReads {
            session: &session,
            store: &table,
            can_read: &|_| true,
            encoder: &Encoder,
            send: &mut |message| sent.push(message),
        },
    );
    assert!(sent.is_empty());
    assert_eq!(later, vec![request.to_subscribe_message(None)]);
}

#[test]
fn a_snapshot_and_a_sidebar_window_wait_for_confirmation() {
    let (session, table, mut sent) = setup();
    let thread = subscribe("t", None);
    let window = EarlySubscribe {
        subscription_id: "w".to_owned(),
        scope: EarlyScope::Threads {
            window: crate::nk::hello::Window {
                limit: 20,
                project: None,
                archived: None,
            },
        },
        paced: true,
        after_seq: None,
        tail: None,
    };
    let later = answer_early(
        &[thread.clone(), window.clone()],
        &mut EarlyReads {
            session: &session,
            store: &table,
            can_read: &|_| true,
            encoder: &Encoder,
            send: &mut |message| sent.push(message),
        },
    );
    assert_eq!(
        later,
        vec![
            thread.to_subscribe_message(None),
            window.to_subscribe_message(None)
        ]
    );
    assert!(sent.is_empty());
    assert_eq!(session.remaining().events, NK_LIMITS.session_events);
}

#[test]
fn a_small_resumes_missed_events_go_early_marked_and_the_subscribe_resumes_after_them() {
    let (session, mut table, mut sent) = setup();
    table.head = 7;
    table.events = vec![event("t", 10), event("t", 10)];
    let mut request = subscribe("t", Some(5));
    request.paced = true;
    let later = answer_early(
        std::slice::from_ref(&request),
        &mut EarlyReads {
            session: &session,
            store: &table,
            can_read: &|_| true,
            encoder: &Encoder,
            send: &mut |message| sent.push(message),
        },
    );
    assert_eq!(sent.len(), 1);
    let message = sent[0].as_object().unwrap();
    assert_eq!(message.get("type").and_then(Value::as_str), Some("events"));
    assert_eq!(message.get("afterSeq").and_then(Value::as_u64), Some(5));
    assert_eq!(message.get("throughSeq").and_then(Value::as_u64), Some(7));
    assert_eq!(message.get("early").and_then(Value::as_bool), Some(true));
    assert_eq!(
        message
            .get("events")
            .and_then(Value::as_array)
            .map(|events| events.len()),
        Some(2)
    );
    // At confirmation, an ordinary subscribe from where the early events ended, paced as asked.
    assert_eq!(later, vec![request.to_subscribe_message(Some(7))]);
    assert_eq!(session.remaining().events, NK_LIMITS.session_events - 2);
}

#[test]
fn a_resume_with_nothing_missed_sends_nothing_early_not_even_progress() {
    let (session, mut table, mut sent) = setup();
    table.head = 3;
    table.events = Vec::new();
    let request = subscribe("t", Some(3));
    let later = answer_early(
        std::slice::from_ref(&request),
        &mut EarlyReads {
            session: &session,
            store: &table,
            can_read: &|_| true,
            encoder: &Encoder,
            send: &mut |message| sent.push(message),
        },
    );
    assert_eq!(later, vec![request.to_subscribe_message(None)]);
    assert!(sent.is_empty());
}

#[test]
fn an_unreadable_cursor_forbids_another_thread_or_a_denied_read_answers_nothing() {
    let (session, mut table, mut sent) = setup();
    table.head = 2;
    table.events = vec![event("t", 10)];
    let denied = answer_early(
        &[subscribe("t", Some(0))],
        &mut EarlyReads {
            session: &session,
            store: &table,
            can_read: &|_| false,
            encoder: &Encoder,
            send: &mut |message| sent.push(message),
        },
    );
    assert_eq!(denied.len(), 1);
    assert!(sent.is_empty());
    table.replay_safe = Err(CursorUnreadable);
    let unsafe_read = answer_early(
        &[subscribe("t", Some(0))],
        &mut EarlyReads {
            session: &session,
            store: &table,
            can_read: &|_| true,
            encoder: &Encoder,
            send: &mut |message| sent.push(message),
        },
    );
    assert_eq!(unsafe_read.len(), 1);
    assert!(sent.is_empty());
    // A cursor past the head isn't answered either.
    table.replay_safe = Ok(true);
    let future = answer_early(
        &[subscribe("t", Some(9))],
        &mut EarlyReads {
            session: &session,
            store: &table,
            can_read: &|_| true,
            encoder: &Encoder,
            send: &mut |message| sent.push(message),
        },
    );
    assert_eq!(future.len(), 1);
    assert!(sent.is_empty());
}
