// SPDX-License-Identifier: Apache-2.0
//! One socket, as JavaScript holds it (T1a.5): the `ws`-shaped methods over
//! T1a.4's socket, and its events on their way out — one object per event in the
//! socket's own order, an inbound payload copied into a JavaScript `Buffer` and
//! then wiped from the vector that carried it, and the delivery charge released
//! only after the JavaScript callback returned. Nothing parses a message here;
//! the socket's own bound (1 MiB or 64 waiting messages) keeps a JavaScript that
//! stops listening from growing the queue.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use ace_transport::socket::{
    MESSAGE_OVERHEAD, SendResult, SocketEvent, SocketEvents, SocketHandle,
};
use napi::Status;
use napi::bindgen_prelude::{Buffer, Either, Uint8Array};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use zeroize::Zeroize;

use super::{Shared, locked, runtime};

/// One event, as the shell sees it: `kind` names the variant and only that
/// variant's fields are set. Payloads and reasons are Node `Buffer`s, and `code`
/// is Node's own field: the close code as a number, an `error`'s code as its
/// word (`too_big`, `protocol`, `io`).
#[napi(object)]
pub struct SocketEventJs {
    /// `message`, `sent`, `error` or `close`.
    pub kind: String,
    /// A message's payload, copied out of the socket's vector.
    pub data: Option<Buffer>,
    /// A message's frame kind: text or binary.
    pub binary: Option<bool>,
    /// A message's delivery charge (its length plus 256), which the shell may
    /// account for; the binding releases it itself.
    pub charge: Option<f64>,
    /// A `sent`'s id, from the `send` that queued it.
    pub id: Option<f64>,
    /// A `sent`'s failure, in `ws`'s words, or null when the frame went out.
    pub error: Option<String>,
    /// A `close`'s code (a number), or an `error`'s (a word).
    pub code: Option<Either<String, f64>>,
    /// An `error`'s message.
    pub message: Option<String>,
    /// A `close`'s reason, as the peer sent it.
    pub reason: Option<Buffer>,
}

impl SocketEventJs {
    fn of(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            data: None,
            binary: None,
            charge: None,
            id: None,
            error: None,
            code: None,
            message: None,
            reason: None,
        }
    }
}

/// A socket's listener: called once per event, in order, with the event alone
/// (`CalleeHandled = false`: no error-first argument). Its threadsafe function is
/// weak, so an open socket never keeps the process alive.
pub type Listener = ThreadsafeFunction<SocketEventJs, (), SocketEventJs, Status, false, true>;

/// One socket's Rust state: the socket itself, the events nobody is listening
/// to yet, the listener's accounting, and the id its `close` reports.
struct SocketState {
    id: u64,
    shared: Arc<Shared>,
    handle: SocketHandle,
    events: Mutex<Option<SocketEvents>>,
    registered: AtomicBool,
}

/// One socket, as JavaScript holds it. Its events queue in Rust, bounded by the
/// socket, until `listen` names their listener.
#[napi]
pub struct NativeSocketHandle {
    inner: Arc<SocketState>,
}

impl NativeSocketHandle {
    /// Opens T1a.4's socket over a flushed `101` and counts it until it reports
    /// `close`: the listener's close waits on this count. `deflate` is the
    /// `permessage-deflate` extension this connection negotiated (T1b.3b), and
    /// `stats` the listener's counters.
    pub(crate) fn open(
        shared: Arc<Shared>,
        stream: Box<dyn ace_transport::UpgradeIo>,
        deflate: Option<ace_transport::Deflate>,
        stats: Option<Arc<ace_transport::Stats>>,
    ) -> Self {
        let (handle, events) = ace_transport::socket::open(stream, deflate, stats);
        let id = shared.live.add();
        Self {
            inner: Arc::new(SocketState {
                id,
                shared,
                handle,
                events: Mutex::new(Some(events)),
                registered: AtomicBool::new(false),
            }),
        }
    }
}

#[napi]
impl NativeSocketHandle {
    /// Delivers this socket's events, in order, to `events`. Called once: the
    /// first listener keeps the queue, and a later call is ignored.
    #[napi(catch_unwind)]
    pub fn listen(&self, events: Listener) -> napi::Result<()> {
        let Some(queue) = locked(&self.inner.events).take() else {
            return Ok(());
        };
        self.inner.registered.store(true, Ordering::Release);
        let shared = Arc::clone(&self.inner.shared);
        let id = self.inner.id;
        let closed: Arc<dyn Fn() + Send + Sync> = Arc::new(move || shared.live.done(id));
        runtime()?.spawn(pump(self.inner.handle.clone(), queue, events, closed));
        Ok(())
    }

    /// `ws`'s send while open: `queued` (and then exactly one `sent`), or why
    /// nothing was queued. The shell tells `not-open` (a close race) apart from
    /// `full` and `invalid-utf8`, which only fail that one send's callback.
    /// `compress` is the shell's per-message answer (the compression allowlist);
    /// Rust adds `ws`'s threshold and compresses nothing without the extension.
    #[napi(catch_unwind)]
    pub fn send(&self, data: Uint8Array, binary: bool, compress: bool, id: f64) -> String {
        match self.inner.handle.send(
            bytes::Bytes::copy_from_slice(&data),
            binary,
            compress,
            count(id),
        ) {
            SendResult::Queued => "queued",
            SendResult::NotOpen => "not-open",
            SendResult::Full => "full",
            SendResult::InvalidUtf8 => "invalid-utf8",
        }
        .to_owned()
    }

    /// A deliberate close with its code and reason; idempotent per socket. `ws`
    /// refuses an invalid code or a reason over 123 bytes before sending, and so
    /// does this: the shell sees the throw, and nothing was queued.
    #[napi(catch_unwind)]
    pub fn close(&self, code: Option<u16>, reason: String) -> napi::Result<()> {
        self.inner
            .handle
            .close(code, reason)
            .map_err(|error| napi::Error::new(Status::InvalidArg, error.message()))
    }

    /// Drops the connection and reports `close` with `1006`.
    #[napi(catch_unwind)]
    pub fn terminate(&self) {
        self.inner.handle.terminate();
    }

    /// Stops reading the socket; messages already read are still delivered.
    #[napi(catch_unwind)]
    pub fn pause(&self) {
        self.inner.handle.pause();
    }

    #[napi(catch_unwind)]
    pub fn resume(&self) {
        self.inner.handle.resume();
    }

    #[napi(catch_unwind)]
    pub fn is_paused(&self) -> bool {
        self.inner.handle.is_paused()
    }

    /// Bytes accepted by `send` and not yet flushed.
    #[napi(catch_unwind)]
    pub fn buffered_amount(&self) -> f64 {
        self.inner.handle.buffered_amount() as f64
    }

    #[napi(catch_unwind)]
    pub fn ready_state(&self) -> u8 {
        self.inner.handle.ready_state()
    }
}

impl Drop for NativeSocketHandle {
    fn drop(&mut self) {
        // A handle that never listened reports no close: there is no queue to
        // report it from, so its own end is what the listener's close waits for.
        if !self.inner.registered.load(Ordering::Acquire) {
            self.inner.shared.live.done(self.inner.id);
        }
        // Dropping the last handle ends the socket (T1a.4); a queue still here is
        // dropped with it, which wipes every payload it holds.
        let _ = locked(&self.inner.events).take();
    }
}

/// Delivers every event the socket produces until it reports `Close` (or its
/// queue ends). `closed` runs after JavaScript has the close event, in the
/// callback's completion — or at once when the close could not be queued — and
/// that is what the listener's close waits for. The message's charge is released
/// after its JavaScript callback returned.
async fn pump(
    handle: SocketHandle,
    mut events: SocketEvents,
    listener: Listener,
    closed: Arc<dyn Fn() + Send + Sync>,
) {
    let mut queued_close = false;
    while let Some(event) = events.recv().await {
        let last = matches!(event, SocketEvent::Close { .. });
        let (event, charge) = translate(event);
        let delivered = handle.clone();
        let done = Arc::clone(&closed);
        let owed = charge;
        let status = listener.call_with_return_value(
            event,
            ThreadsafeFunctionCallMode::NonBlocking,
            move |value, _env| {
                // The charge is released whatever the listener did, and a
                // listener that threw stays an uncaught exception, as the
                // supervisor binding's events do.
                if let Some(charge) = charge {
                    delivered.delivered(charge);
                }
                if last {
                    done();
                }
                value?;
                Ok(())
            },
        );
        // The socket ended, or the shell can no longer be called: either way,
        // nothing more can be delivered.
        if status == napi::Status::Closing {
            break;
        }
        if !reached_callback(status) {
            // The call never reached its callback, so nothing would hand this
            // message's charge back: a later error would then wait on it for
            // the close timeout. The close is settled by the tail below.
            if let Some(charge) = owed {
                handle.delivered(charge);
            }
            break;
        }
        if last {
            queued_close = true;
            break;
        }
    }
    // A close JavaScript never received still ends the socket here, so the
    // listener's close cannot wait on an event that will never arrive.
    if !queued_close {
        closed();
    }
}

/// Whether a listener call with `status` reached its callback. Only `Ok` did;
/// `Closing` is excluded because events already queued still reach their
/// callbacks, and those hand their own charges back.
fn reached_callback(status: Status) -> bool {
    status == Status::Ok
}

/// One event as JavaScript receives it, and the charge its message holds until
/// the callback returned.
fn translate(event: SocketEvent) -> (SocketEventJs, Option<u64>) {
    match event {
        SocketEvent::Message { mut data, binary } => {
            let charge = data.len() as u64 + MESSAGE_OVERHEAD;
            // The copy is what JavaScript gets; the vector the socket owned is
            // wiped here, as the TypeScript side wipes its own queued text.
            let copy = data.clone();
            data.zeroize();
            let event = SocketEventJs {
                data: Some(Buffer::from(copy)),
                binary: Some(binary),
                charge: Some(charge as f64),
                ..SocketEventJs::of("message")
            };
            (event, Some(charge))
        }
        SocketEvent::Sent { id, error } => (
            SocketEventJs {
                id: Some(id as f64),
                error,
                ..SocketEventJs::of("sent")
            },
            None,
        ),
        SocketEvent::Error { code, message } => (
            SocketEventJs {
                code: Some(Either::A(code.to_owned())),
                message: Some(message),
                ..SocketEventJs::of("error")
            },
            None,
        ),
        SocketEvent::Close { code, reason } => (
            SocketEventJs {
                code: Some(Either::B(f64::from(code))),
                reason: Some(Buffer::from(reason)),
                ..SocketEventJs::of("close")
            },
            None,
        ),
    }
}

/// A JavaScript number as the `u64` it names; ids come from the shell's own
/// counters, and anything else names nothing.
fn count(value: f64) -> u64 {
    if value.is_finite() && value >= 0.0 {
        value as u64
    } else {
        0
    }
}
