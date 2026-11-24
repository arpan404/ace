// SPDX-License-Identifier: Apache-2.0
//! The socket and its lifecycle (T1a.4). `frame` puts RFC 6455 on the wire and
//! assembles what arrives; this module owns what `ws` owns above that: the ready
//! state, the buffered amount, pause and resume, the bound in front of
//! JavaScript, and one event per outcome. Nothing here parses an ace message.
//!
//! `drive` runs the two tasks, so a slow write never stops a control frame being
//! read; `events` is what the owner receives. Dropping the handle or the receiver
//! closes the socket.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use tokio::runtime::Handle;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

use crate::driver::UpgradeIo;
use crate::frame::{Opcode, Outbound as Frame};

mod drive;
mod events;
mod handle;
#[cfg(test)]
mod tests;

pub use events::{SendResult, SocketEvent, SocketEvents};
pub use handle::{CloseError, SocketHandle};

use drive::Ending;

/// `maxPayload` (`server.ts:252`): one inbound message, after any inflation.
pub use crate::frame::MAX_MESSAGE_BYTES;
/// `socket-input.ts`'s `messageOverhead`: a message is charged its length plus
/// this, so an empty one still counts, inbound and outbound alike.
pub const MESSAGE_OVERHEAD: u64 = 256;
/// The charged total the reader waits at (`socket-input.ts`'s `pauseBytes`).
pub const DELIVERY_BYTES: u64 = 1024 * 1024;
/// The messages the reader waits at, so empty ones are bounded too.
pub const DELIVERY_MESSAGES: u64 = 64;
/// Sends whose `Sent` the owner has not taken before `send` refuses: the outbox's
/// 4 MiB hard limit (`outbox.ts:26`) over the 256-byte charge.
pub const OUTBOUND_MESSAGES: u64 = 16_384;
/// `ws`'s `closeTimeout`: an unanswered local close is destroyed and reported `1006`.
pub const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);

/// `ws`'s ready states, as `readyState` reports them.
pub const OPEN: u8 = 1;
pub const CLOSING: u8 = 2;
pub const CLOSED: u8 = 3;

/// What a `send` still owes: the id that gets one `Sent`.
#[derive(Clone, Copy)]
struct Own {
    id: u64,
}

/// One thing for the writer: a frame, the `send` whose completion it is, and the
/// bytes it charged. A control reply is charged but owes no `Sent`.
struct Queued {
    frame: Frame,
    own: Option<Own>,
    charge: u64,
    control: bool,
}

/// The socket's state, its outbound queue and its events under one lock, so a
/// `send` checks `OPEN`, charges and enqueues as one step and nothing is emitted
/// after `Close`.
struct Inner {
    state: u8,
    /// `None` once the socket is closed: no later `send` can queue anything.
    outbound: Option<mpsc::UnboundedSender<Queued>>,
    events: Option<mpsc::UnboundedSender<SocketEvent>>,
    /// The local close frame queued but not yet on the wire (`ws`'s
    /// `_closeFrameSent === false` after `close()`).
    close: Option<Vec<u8>>,
    /// A close frame has been flushed, local or a reply.
    close_sent: bool,
}

struct Shared {
    inner: Mutex<Inner>,
    /// Charged bytes accepted by `send` and not yet flushed.
    buffered: AtomicU64,
    /// Sends whose `Sent` the owner has not taken, which bounds the queue.
    pending: AtomicU64,
    /// Auto-pongs queued but not flushed, bounded like sends and charged like them.
    controls: AtomicU64,
    paused: AtomicBool,
    /// Charged bytes and messages waiting for JavaScript, so for the reader.
    waiting_bytes: AtomicU64,
    waiting_messages: AtomicU64,
    wake: mpsc::Sender<()>,
    /// The conversation has ended: both tasks stop.
    over: CancellationToken,
    /// `terminate` was called: the stream is dropped where it stands.
    stop: CancellationToken,
    /// The first task to end records why; the writer reports it.
    ending: Mutex<Option<Ending>>,
    /// A local close ran past [`CLOSE_TIMEOUT`]: the socket is destroyed.
    expired: CancellationToken,
    /// The runtime it was opened on: `close` starts its timer from any thread.
    runtime: Handle,
}

impl Shared {
    fn readable(&self) -> bool {
        !self.paused.load(Ordering::Relaxed)
            && self.waiting_bytes.load(Ordering::Relaxed) <= DELIVERY_BYTES
            && self.waiting_messages.load(Ordering::Relaxed) < DELIVERY_MESSAGES
            // Control replies are bounded by the send budget: at its edge the
            // reader waits for the writer rather than dropping a pong.
            && self.controls.load(Ordering::Relaxed) < OUTBOUND_MESSAGES
    }

    fn wake(&self) {
        let _ = self.wake.try_send(());
    }

    /// Queues one control frame the reader owes (a pong), with no `Sent`: control
    /// frames answer the peer, they are not one of the owner's sends. Its charge
    /// is exactly the payload bytes, which is what `ws` counts for a pong (no
    /// per-message overhead); `readable` stops the reader at the send budget,
    /// so the reply is never dropped.
    fn control(&self, opcode: Opcode, payload: Vec<u8>) {
        let charge = payload.len() as u64;
        let inner = lock(&self.inner);
        let Some(outbound) = inner.outbound.as_ref() else {
            return;
        };
        self.controls.fetch_add(1, Ordering::Relaxed);
        self.buffered.fetch_add(charge, Ordering::Relaxed);
        let frame = Frame {
            opcode,
            rsv1: false,
            payload: Bytes::from(payload),
        };
        if outbound
            .send(Queued {
                frame,
                own: None,
                charge,
                control: true,
            })
            .is_err()
        {
            debit(&self.controls, 1);
            debit(&self.buffered, charge);
        }
    }

    fn state(&self) -> u8 {
        lock(&self.inner).state
    }

    /// Hands one inbound payload to JavaScript, charged before it is queued so
    /// the reader stops at the bound. A payload whose receiver is gone is wiped
    /// here, the same bytes the binding wipes on the path it does deliver.
    fn deliver(&self, data: Vec<u8>, binary: bool) -> bool {
        let charge = data.len() as u64 + MESSAGE_OVERHEAD;
        self.waiting_bytes.fetch_add(charge, Ordering::Relaxed);
        self.waiting_messages.fetch_add(1, Ordering::Relaxed);
        match self.emit(SocketEvent::Message { data, binary }) {
            Ok(()) => true,
            Err(SocketEvent::Message { mut data, .. }) => {
                data.zeroize();
                false
            }
            Err(_) => false,
        }
    }

    fn sent(&self, id: u64, error: Option<String>) {
        let _ = self.emit(SocketEvent::Sent { id, error });
    }

    /// Releases a frame's charge without completing it; `finish` reports the
    /// `Sent` once sealed, and the owner's taking it is what releases `pending`.
    fn release(&self, charge: u64, control: bool) {
        debit(&self.buffered, charge);
        if control {
            debit(&self.controls, 1);
            // The reader may be waiting at the control bound; a freed slot lets
            // it read the next ping.
            self.wake();
        }
    }

    /// One queued frame is done: release its charge, its control slot, and the
    /// one `Sent` a data send owes.
    fn settle(&self, own: Option<Own>, charge: u64, control: bool, error: Option<String>) {
        self.release(charge, control);
        if let Some(own) = own {
            self.sent(own.id, error);
        }
    }

    /// A close frame reached the wire: `ws`'s `_closeFrameSent`, and no later
    /// reply is written.
    fn close_flushed(&self) {
        let mut inner = lock(&self.inner);
        inner.close_sent = true;
        inner.close = None;
    }

    fn emit(&self, event: SocketEvent) -> Result<(), SocketEvent> {
        let inner = lock(&self.inner);
        let Some(events) = inner.events.as_ref() else {
            return Err(event);
        };
        match events.send(event) {
            Ok(()) => Ok(()),
            Err(error) => Err(error.0),
        }
    }

    /// Reports `Close` and stops accepting events: the socket is done.
    fn finish_events(&self, code: u16, reason: Vec<u8>) {
        let mut inner = lock(&self.inner);
        if let Some(events) = inner.events.take() {
            let _ = events.send(SocketEvent::Close { code, reason });
        }
    }

    /// No later `send` can queue a frame, so the queue left owes only `Sent`s.
    fn seal(&self) {
        let mut inner = lock(&self.inner);
        inner.state = CLOSED;
        inner.outbound = None;
    }

    /// The first task to end records why; the writer reports it.
    fn end(&self, ending: Ending) {
        let mut slot = lock(&self.ending);
        if slot.is_none() {
            *slot = Some(ending);
        }
        drop(slot);
        self.over.cancel();
    }

    fn ended(&self) -> Ending {
        lock(&self.ending).take().unwrap_or_else(Ending::lost)
    }
}

/// Opens a socket over either kind of stream the handshake hands on (the raw
/// path's `Prefixed<TcpStream>`, the keep-alive path's upgraded stream), `OPEN` at
/// once on the caller's tokio runtime (T1a.5).
pub fn open(stream: Box<dyn UpgradeIo>) -> (SocketHandle, SocketEvents) {
    let (events, incoming) = mpsc::unbounded_channel();
    let (outbound, queued) = mpsc::unbounded_channel();
    let (wake, woken) = mpsc::channel(1);
    let shared = Arc::new(Shared {
        inner: Mutex::new(Inner {
            state: OPEN,
            outbound: Some(outbound),
            events: Some(events),
            close: None,
            close_sent: false,
        }),
        buffered: AtomicU64::new(0),
        pending: AtomicU64::new(0),
        controls: AtomicU64::new(0),
        paused: AtomicBool::new(false),
        waiting_bytes: AtomicU64::new(0),
        waiting_messages: AtomicU64::new(0),
        wake,
        over: CancellationToken::new(),
        stop: CancellationToken::new(),
        ending: Mutex::new(None),
        expired: CancellationToken::new(),
        runtime: Handle::current(),
    });
    Handle::current().spawn(drive::run(stream, Arc::clone(&shared), queued, woken));
    let events = SocketEvents {
        receiver: incoming,
        shared: Arc::clone(&shared),
    };
    (SocketHandle::attach(shared), events)
}

/// The frame for one outbound payload: text only for UTF-8, which TypeScript sends.
fn message(data: Bytes, binary: bool) -> Result<Frame, std::str::Utf8Error> {
    let opcode = if binary {
        Opcode::Binary
    } else {
        std::str::from_utf8(&data)?;
        Opcode::Text
    };
    Ok(Frame {
        opcode,
        rsv1: false,
        payload: data,
    })
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// A counter's debit. A debit for something never charged is a bug: the
/// subtraction is checked, so a debug build stops, and a release build leaves the
/// counter alone and counts it in [`underflow_count`] instead of hiding it.
fn debit(counter: &AtomicU64, amount: u64) {
    let _ = counter.try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        let next = value.checked_sub(amount);
        if next.is_none() {
            UNDERFLOWS.fetch_add(1, Ordering::Relaxed);
        }
        next
    });
}

/// Unpaired debits this process has seen: this crate's bug, never the peer's, so
/// no socket fails for it. Nothing is printed from a library; the binding reads
/// this and forwards it to JavaScript's warning path (T1a.5).
static UNDERFLOWS: AtomicU64 = AtomicU64::new(0);

/// How many debits found nothing to take. It stays zero unless this crate has a
/// bookkeeping bug; the binding reports a non-zero value once.
pub fn underflow_count() -> u64 {
    UNDERFLOWS.load(Ordering::Relaxed)
}
