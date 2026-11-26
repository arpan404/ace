// SPDX-License-Identifier: Apache-2.0
//! A tenant that records what the server core asked of it, and a queue the core
//! publishes its notes to. Shared by the routes and server tables.

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionEvent};
use ace_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use super::server::{Tenant, TenantError};
use crate::translate::boundaries::NativeEvent;

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
type Predicate = Box<dyn Fn(&Value, u64) -> Result<bool, TenantError> + Send + Sync>;

/// A tenant whose ownership is a predicate and whose calls are recorded.
pub(crate) struct Fake {
    accept: Predicate,
    calls: Mutex<Vec<Call>>,
    queue: EventQueue,
    /// Notes and calls interleaved, for the activity tables; only kept when
    /// `tracing` is set, so the other tables see calls alone.
    tracing: bool,
    trace: Mutex<Vec<String>>,
    /// How many times the core asked this tenant whether it accepts an event.
    accepts_calls: AtomicUsize,
    /// Set while `finalize_snapshots` refuses with this message.
    finalize_error: Mutex<Option<String>>,
}

impl Fake {
    pub(crate) fn new(
        accept: impl Fn(&Value, u64) -> Result<bool, TenantError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            accept: Box::new(accept),
            calls: Mutex::new(Vec::new()),
            queue: EventQueue::new(ReadGate::new()),
            tracing: false,
            trace: Mutex::new(Vec::new()),
            accepts_calls: AtomicUsize::new(0),
            finalize_error: Mutex::new(None),
        }
    }

    /// A tenant that accepts every event and interleaves notes with calls.
    pub(crate) fn tracing() -> Self {
        let mut fake = Self::all();
        fake.tracing = true;
        fake
    }

    /// A tenant that refuses every event with `message`.
    pub(crate) fn refusing(message: &'static str) -> Self {
        Self::new(move |_, _| Err(TenantError(message.to_owned())))
    }

    /// Makes `finalize_snapshots` refuse with `message`, or accept again.
    pub(crate) fn fail_finalize(&self, message: Option<&str>) {
        *self
            .finalize_error
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = message.map(str::to_owned);
    }

    /// The notes and calls the core made, in the order they were produced.
    /// Every note before the last call was already drained into the trace, so
    /// this drains what follows it too.
    pub(crate) fn trace(&self) -> Vec<String> {
        self.flush_notes();
        self.lock_trace().clone()
    }

    /// Notes the core published before the call being recorded, then the call.
    fn flush_notes(&self) {
        if !self.tracing {
            return;
        }
        for (channel, _) in self.notes() {
            self.lock_trace().push(format!("note:{channel}"));
        }
    }

    fn record(&self, entry: String) {
        if self.tracing {
            self.lock_trace().push(entry);
        }
    }

    fn lock_trace(&self) -> MutexGuard<'_, Vec<String>> {
        self.trace.lock().unwrap_or_else(|error| error.into_inner())
    }

    /// A tenant that accepts every event.
    pub(crate) fn all() -> Self {
        Self::new(|_, _| Ok(true))
    }

    /// A tenant that accepts the events whose `data.sessionID` is `name`.
    pub(crate) fn session(name: &'static str) -> Self {
        Self::new(move |value, _| {
            Ok(value
                .get("data")
                .and_then(|data| data.get("sessionID"))
                .and_then(Value::as_str)
                == Some(name))
        })
    }

    pub(crate) fn accepts_calls(&self) -> usize {
        self.accepts_calls.load(Ordering::SeqCst)
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
        SessionEvent::Port { .. } => "port",
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

    fn accepts(
        &self,
        _event: &NativeEvent<'_>,
        data: &Value,
        watermark: u64,
    ) -> Result<bool, TenantError> {
        self.accepts_calls.fetch_add(1, Ordering::SeqCst);
        (self.accept)(data, watermark)
    }

    fn receive(
        &self,
        _event: &NativeEvent<'_>,
        data: &Value,
        _watermark: u64,
    ) -> Result<(), TenantError> {
        self.flush_notes();
        let json = ace_json::to_string(data);
        self.record(format!("receive:{json}"));
        self.lock().push(Call::Receive(json));
        Ok(())
    }

    fn buffered(&self, data: &Value, watermark: u64) -> Result<(), TenantError> {
        self.flush_notes();
        let json = ace_json::to_string(data);
        self.record(format!("buffered:{json}"));
        self.lock().push(Call::Buffered(json, watermark));
        Ok(())
    }

    fn disconnected(&self, started: u64) {
        self.lock().push(Call::Disconnected(started));
    }

    fn reconcile(&self, data: &Value, watermark: u64) -> Result<(), TenantError> {
        self.lock()
            .push(Call::Reconcile(ace_json::to_string(data), watermark));
        Ok(())
    }

    fn finalize_snapshots(&self) -> Result<(), TenantError> {
        self.lock().push(Call::Finalize);
        let failure = self
            .finalize_error
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        match failure {
            Some(message) => Err(TenantError(message)),
            None => Ok(()),
        }
    }

    fn recovered(&self) {
        self.lock().push(Call::Recovered);
    }

    fn take_reconcile(&self) -> bool {
        false
    }
}
