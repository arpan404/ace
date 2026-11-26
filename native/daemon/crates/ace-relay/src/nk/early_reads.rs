// SPDX-License-Identifier: Apache-2.0
//! The read subscribes an NK first message carries (ADR 0155, "Read subscribes before
//! confirmation", `apps/daemon/src/relay-nk/early-reads.ts`). Before the client confirms, only one
//! kind is answered: a thread subscribe resuming from a cursor, whose missed events are read under
//! a limit the store enforces before decoding anything, and only when the whole answer fits the
//! session's remaining read, event and output budgets. Its answer is only events applied early: the
//! ones an XX replay would carry, flagged `early`, never a ready, a progress or a snapshot. At
//! confirmation each subscribe is made as an ordinary one, from the cursor its early events ended
//! at.

use ace_json::{Map, Value};

use super::admission::NkSession;
use super::hello::EarlySubscribe;

/// XX sends a replay this small as is, without weighing a snapshot against it.
pub const EARLY_REPLAY_BYTES: usize = 16 * 1024;

/// What the store answered, already decoded and measured (`BoundedEvents`).
#[derive(Debug, Clone, PartialEq)]
pub struct BoundedRead {
    pub events: Vec<Value>,
    pub bytes: usize,
}

/// Why a cursor can't be replayed: the store's read failed or its answer is unusable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorUnreadable;

/// The store reads an early answer needs. The daemon's store supplies them; a test's table can.
pub trait EarlyStore {
    fn head_seq(&self) -> u64;
    fn has_live_thread(&self, thread_id: &str) -> bool;
    /// Whether a replay from `after_seq` is safe; an unreadable cursor is `Err`.
    fn replay_safe(&self, after_seq: u64) -> Result<bool, CursorUnreadable>;
    /// The bounded read the store enforces before decoding anything; `None` when it doesn't fit.
    fn bounded_thread_events(
        &self,
        thread_id: &str,
        after_seq: u64,
        head: u64,
        rows: usize,
        bytes: usize,
    ) -> Option<BoundedRead>;
}

/// The wire encoder an early answer measures events with (`WireEncoder.eventBytes`).
pub trait EarlyEncoder {
    fn event_bytes(&self, event: &Value) -> usize;
}

/// One unconfirmed socket's early reads.
pub struct EarlyReads<'a> {
    pub session: &'a NkSession,
    pub store: &'a dyn EarlyStore,
    pub can_read: &'a dyn Fn(&str) -> bool,
    pub encoder: &'a dyn EarlyEncoder,
    pub send: &'a mut dyn FnMut(Value),
}

/// Answers what may be answered before confirmation and returns, in order, the subscribes to run
/// once the client confirms (held ones as they came, answered ones from where they ended).
pub fn answer_early(subscribes: &[EarlySubscribe], reads: &mut EarlyReads<'_>) -> Vec<Value> {
    subscribes
        .iter()
        .map(|subscribe| {
            let answered = answer(subscribe, reads);
            subscribe.to_subscribe_message(answered)
        })
        .collect()
}

/// The cursor the early events ended at, or `None` when none were sent.
fn answer(subscribe: &EarlySubscribe, reads: &mut EarlyReads<'_>) -> Option<u64> {
    let thread_id = subscribe.thread_id()?;
    let after_seq = subscribe.after_seq?;
    if !(reads.can_read)(thread_id) || !reads.store.has_live_thread(thread_id) {
        return None;
    }
    match reads.store.replay_safe(after_seq) {
        Ok(true) => {}
        _ => return None,
    }
    let head = reads.store.head_seq();
    if after_seq > head {
        return None;
    }
    let room = reads.session.remaining();
    let read = reads.store.bounded_thread_events(
        thread_id,
        after_seq,
        head,
        room.events,
        room.bytes.min(EARLY_REPLAY_BYTES),
    )?;
    let wire: usize = read
        .events
        .iter()
        .map(|event| reads.encoder.event_bytes(event))
        .sum();
    if wire > EARLY_REPLAY_BYTES {
        return None;
    }
    // Nothing missed of this thread: nothing to send early.
    if read.events.is_empty() {
        return None;
    }
    // The missed events in one frame, as an XX replay carries them, flagged early.
    let mut message = Map::new();
    message.insert("type", Value::String("events".into()));
    message.insert(
        "subscriptionId",
        Value::String(subscribe.subscription_id.clone().into()),
    );
    message.insert("afterSeq", Value::from(after_seq));
    message.insert("throughSeq", Value::from(head));
    message.insert("events", Value::from(read.events.clone()));
    message.insert("early", Value::Bool(true));
    let message = Value::Object(message);
    // Its JSON is at least what goes on the wire: the answer fits the output left, or isn't sent.
    let size = ace_json::to_string(&message).len();
    if size > room.output {
        return None;
    }
    if !reads.session.reserve_bytes(read.bytes) || !reads.session.reserve_events(read.events.len())
    {
        return None;
    }
    (reads.send)(message);
    Some(head)
}

#[cfg(test)]
mod tests;
