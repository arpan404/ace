// SPDX-License-Identifier: Apache-2.0
//! The socket and its lifecycle (T1a.4). `tokio-tungstenite` frames the bytes and
//! answers the protocol's own control frames; this module owns what `ws` owns
//! above that: the ready state, the buffered amount, pause and resume, the bound in
//! front of JavaScript, and one event per outcome. Nothing here parses an ace
//! message: a peer's JSON ping stays a text `Message` (T1a.6).
//!
//! `drive` runs the two tasks, so a slow write never stops a control frame being
//! read; `events` is what the owner receives. Dropping the handle or the receiver
//! closes the socket.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use bytes::Bytes;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

use crate::driver::UpgradeIo;

mod drive;
mod events;
#[cfg(test)]
mod tests;

pub use events::{SendResult, SocketEvent, SocketEvents};

use drive::Ending;

/// `maxPayload` (`server.ts:252`): one inbound message, after any inflation.
pub const MAX_MESSAGE_BYTES: usize = 1 << 20;
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

/// One socket. Cheap to clone; it lives until the last clone and the events
/// receiver are gone.
#[derive(Clone)]
pub struct SocketHandle {
    shared: Arc<Shared>,
    /// Held only so its drop ends the socket; every clone keeps it alive.
    _owner: Arc<Owner>,
}

/// Dropping it ends the socket: nothing can reach it any more.
struct Owner(Arc<Shared>);

impl Drop for Owner {
    fn drop(&mut self) {
        self.0.end(Ending::lost());
    }
}

/// What a `send` still owes: the id that gets one `Sent`, and the charged bytes
/// (its length plus the per-message overhead) it holds in `buffered_amount`.
#[derive(Clone, Copy)]
struct Own {
    id: u64,
    length: u64,
}

/// One thing for the writer: a frame, and the `send` whose completion it is.
struct Outbound {
    frame: Message,
    own: Option<Own>,
}

/// The socket's state, its outbound queue and its events under one lock, so a
/// `send` checks `OPEN`, charges and enqueues as one step and nothing is emitted
/// after `Close`.
struct Inner {
    state: u8,
    /// `None` once the socket is closed: no later `send` can queue anything.
    outbound: Option<mpsc::UnboundedSender<Outbound>>,
    events: Option<mpsc::UnboundedSender<SocketEvent>>,
}

struct Shared {
    inner: Mutex<Inner>,
    /// Charged bytes accepted by `send` and not yet flushed.
    buffered: AtomicU64,
    /// Sends whose `Sent` the owner has not taken, which bounds the queue.
    pending: AtomicU64,
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
}

impl SocketHandle {
    /// `ws`'s `send` while the state is `OPEN`. A frame is either queued (and
    /// then owes exactly one `Sent`) or refused with nothing emitted.
    pub fn send(&self, data: Bytes, binary: bool, id: u64) -> SendResult {
        let length = data.len() as u64 + MESSAGE_OVERHEAD;
        // `ws` refuses a text send that is not UTF-8, and queues nothing.
        let Ok(frame) = message(data, binary) else {
            return SendResult::NotOpen;
        };
        let shared = &self.shared;
        let inner = lock(&shared.inner);
        if inner.state != OPEN {
            return SendResult::NotOpen;
        }
        let Some(outbound) = inner.outbound.as_ref() else {
            return SendResult::NotOpen;
        };
        if shared.pending.load(Ordering::Relaxed) >= OUTBOUND_MESSAGES {
            return SendResult::NotOpen;
        }
        // Charged under the lock and before the enqueue, so the writer can never
        // complete a frame whose bytes were not charged yet: a debit therefore
        // always follows its charge.
        shared.buffered.fetch_add(length, Ordering::Relaxed);
        shared.pending.fetch_add(1, Ordering::Relaxed);
        let own = Some(Own { id, length });
        match outbound.send(Outbound { frame, own }) {
            Ok(()) => SendResult::Queued,
            Err(_) => {
                debit(&shared.buffered, length, "buffered");
                debit(&shared.pending, 1, "pending");
                SendResult::NotOpen
            }
        }
    }

    /// `ws`'s `close`: idempotent, and a socket already closing keeps its code.
    /// Its deadline starts here, as `ws`'s close timer does, so frames still
    /// waiting cannot postpone it.
    pub fn close(&self, code: Option<u16>, reason: String) {
        let frame = Message::Close(code.map(|code| CloseFrame {
            code: CloseCode::from(code),
            reason: Utf8Bytes::from(reason),
        }));
        {
            let mut inner = lock(&self.shared.inner);
            if inner.state != OPEN {
                return;
            }
            inner.state = CLOSING;
            if let Some(outbound) = inner.outbound.as_ref() {
                let _ = outbound.send(Outbound { frame, own: None });
            }
        }
        let expired = self.shared.expired.clone();
        let over = self.shared.over.clone();
        let deadline = tokio::time::sleep(CLOSE_TIMEOUT);
        tokio::spawn(async move {
            tokio::select! {
                biased;
                // The handshake finished first, or the socket ended.
                _ = over.cancelled() => {}
                () = deadline => expired.cancel(),
            }
        });
    }

    /// `ws`'s `terminate`: drops the connection where it stands and reports
    /// `Close` with `1006`.
    pub fn terminate(&self) {
        {
            let mut inner = lock(&self.shared.inner);
            if inner.state == CLOSED {
                return;
            }
            inner.state = CLOSED;
            inner.outbound = None;
        }
        // Both tasks stop now: the writer abandons any write in flight, fails
        // every send still queued and reports the one `Close`.
        self.shared.stop.cancel();
        self.shared.end(Ending::lost());
    }

    /// Stops reading the socket. Messages already read are still delivered.
    pub fn pause(&self) {
        self.shared.paused.store(true, Ordering::Relaxed);
    }

    pub fn resume(&self) {
        self.shared.paused.store(false, Ordering::Relaxed);
        self.shared.wake();
    }

    pub fn is_paused(&self) -> bool {
        self.shared.paused.load(Ordering::Relaxed)
    }

    /// Charged bytes accepted by `send` and not yet flushed.
    pub fn buffered_amount(&self) -> u64 {
        self.shared.buffered.load(Ordering::Relaxed)
    }

    pub fn ready_state(&self) -> u8 {
        lock(&self.shared.inner).state
    }

    /// JavaScript consumed one message: releases its charge (`length + 256`),
    /// which lets the reader read again once it is under the bound.
    pub fn delivered(&self, charge: u64) {
        let shared = &self.shared;
        debit(&shared.waiting_bytes, charge, "waiting_bytes");
        debit(&shared.waiting_messages, 1, "waiting_messages");
        shared.wake();
    }
}

impl Shared {
    fn readable(&self) -> bool {
        !self.paused.load(Ordering::Relaxed)
            && self.waiting_bytes.load(Ordering::Relaxed) <= DELIVERY_BYTES
            && self.waiting_messages.load(Ordering::Relaxed) < DELIVERY_MESSAGES
    }

    fn wake(&self) {
        let _ = self.wake.try_send(());
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

    /// Releases a frame's bytes without completing it; `finish` reports the `Sent`
    /// once sealed, and the owner's taking it is what releases `pending`.
    fn release(&self, own: Option<Own>) {
        if let Some(own) = own {
            debit(&self.buffered, own.length, "buffered");
        }
    }

    fn complete(&self, own: Option<Own>, error: Option<String>) {
        let Some(own) = own else {
            return;
        };
        self.release(Some(own));
        self.sent(own.id, error);
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
        }),
        buffered: AtomicU64::new(0),
        pending: AtomicU64::new(0),
        paused: AtomicBool::new(false),
        waiting_bytes: AtomicU64::new(0),
        waiting_messages: AtomicU64::new(0),
        wake,
        over: CancellationToken::new(),
        stop: CancellationToken::new(),
        ending: Mutex::new(None),
        expired: CancellationToken::new(),
    });
    let owner = Arc::new(Owner(Arc::clone(&shared)));
    tokio::spawn(drive::run(stream, Arc::clone(&shared), queued, woken));
    let events = SocketEvents {
        receiver: incoming,
        shared: Arc::clone(&shared),
    };
    (
        SocketHandle {
            shared,
            _owner: owner,
        },
        events,
    )
}

/// The frame for one outbound payload: text only for UTF-8, which TypeScript sends.
fn message(data: Bytes, binary: bool) -> Result<Message, std::str::Utf8Error> {
    if binary {
        Ok(Message::Binary(data))
    } else {
        Utf8Bytes::try_from(data).map(Message::Text)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// A counter's debit. A debit for something never charged is a bug: the
/// subtraction is checked, so a debug build stops and a release build leaves the
/// counter alone, saying so once instead of dropping the debit silently.
fn debit(counter: &AtomicU64, amount: u64, name: &str) {
    let _ = counter.try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        let next = value.checked_sub(amount);
        if next.is_none() {
            report_underflow(name);
        }
        next
    });
}

/// The one line an unpaired debit leaves behind: this module's bug, not the peer's.
fn report_underflow(name: &str) {
    static REPORTED: AtomicBool = AtomicBool::new(false);
    if !REPORTED.swap(true, Ordering::Relaxed) {
        eprintln!("ace-transport: a debit for a charge that was never made ({name})");
    }
}
