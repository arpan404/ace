// SPDX-License-Identifier: Apache-2.0
//! A tenant that records what the server core asked of it, and a queue the core
//! publishes its notes to. Shared by the routes and server tables.

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionEvent};
use ace_json::Value;
use std::sync::{Arc, Mutex, MutexGuard};

use super::server::Tenant;

/// One call the core made on a tenant, in order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Call {
    Receive(String),
    Buffered(String, u64),
    Disconnected(u64),
    Reconcile(String, u64),
    Finalize,
    Recovered,
}

/// A tenant's ownership predicate.
type Predicate = Box<dyn Fn(&Value, u64) -> bool + Send + Sync>;

/// A tenant whose ownership is a predicate and whose calls are recorded.
pub(crate) struct Fake {
    accept: Predicate,
    calls: Mutex<Vec<Call>>,
    queue: EventQueue,
}

impl Fake {
    pub(crate) fn new(accept: impl Fn(&Value, u64) -> bool + Send + Sync + 'static) -> Self {
        Self {
            accept: Box::new(accept),
            calls: Mutex::new(Vec::new()),
            queue: EventQueue::new(ReadGate::new()),
        }
    }

    /// A tenant that accepts every event.
    pub(crate) fn all() -> Self {
        Self::new(|_, _| true)
    }

    /// A tenant that accepts the events whose `data.sessionID` is `name`.
    pub(crate) fn session(name: &'static str) -> Self {
        Self::new(move |value, _| {
            value
                .get("data")
                .and_then(|data| data.get("sessionID"))
                .and_then(Value::as_str)
                == Some(name)
        })
    }

    pub(crate) fn calls(&self) -> Vec<Call> {
        self.lock().clone()
    }

    /// The notes the core published to this tenant, as (channel, text).
    pub(crate) fn notes(&self) -> Vec<(String, String)> {
        self.queue
            .take_batch(usize::MAX, usize::MAX)
            .into_iter()
            .map(|event| match event {
                SessionEvent::Frame {
                    dir, channel, text, ..
                } => {
                    assert_eq!(dir, FrameDirection::Note);
                    (channel, text)
                }
                other => panic!(
                    "a note queue holds only frames, got a {}",
                    event_kind(&other)
                ),
            })
            .collect()
    }

    fn lock(&self) -> MutexGuard<'_, Vec<Call>> {
        self.calls.lock().unwrap_or_else(|error| error.into_inner())
    }
}

/// A queued event that is not a frame, for the failure message.
fn event_kind(event: &SessionEvent) -> &'static str {
    match event {
        SessionEvent::Frame { .. } => "frame",
        SessionEvent::Callback { .. } => "callback",
        SessionEvent::Settle { .. } => "settle",
        SessionEvent::ArmTimer { .. } => "armTimer",
        SessionEvent::CancelTimer { .. } => "cancelTimer",
        SessionEvent::Fatal { .. } => "fatal",
        SessionEvent::Drained => "drained",
    }
}

/// Whether a selected tenant is `fake`, by identity (never by dereferencing the
/// trait object).
pub(crate) fn is(fake: &Arc<Fake>, tenant: &Arc<dyn Tenant>) -> bool {
    std::ptr::eq(
        Arc::as_ptr(fake) as *const (),
        Arc::as_ptr(tenant) as *const (),
    )
}

impl Tenant for Fake {
    fn queue(&self) -> &EventQueue {
        &self.queue
    }

    fn accepts(&self, data: &Value, watermark: u64) -> bool {
        (self.accept)(data, watermark)
    }

    fn receive(&self, data: &Value) {
        self.lock().push(Call::Receive(ace_json::to_string(data)));
    }

    fn buffered(&self, data: &Value, watermark: u64) {
        self.lock()
            .push(Call::Buffered(ace_json::to_string(data), watermark));
    }

    fn disconnected(&self, started: u64) {
        self.lock().push(Call::Disconnected(started));
    }

    fn reconcile(&self, data: &Value, watermark: u64) {
        self.lock()
            .push(Call::Reconcile(ace_json::to_string(data), watermark));
    }

    fn finalize_snapshots(&self) {
        self.lock().push(Call::Finalize);
    }

    fn recovered(&self) {
        self.lock().push(Call::Recovered);
    }
}
