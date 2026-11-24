// SPDX-License-Identifier: Apache-2.0
//! The socket and its lifecycle (T1a.4). `tokio-tungstenite` frames the bytes
//! and answers the protocol's own control frames; this module owns what `ws`
//! owns above that: the ready state, the buffered amount, pause and resume, the
//! bound in front of JavaScript, and exactly one event per outcome, with `Close`
//! last. Nothing here parses an ace message: a peer's JSON ping is an ordinary
//! text `Message` for its TypeScript owner to answer (T1a.6).
//!
//! `drive` runs the socket: a reader task delivers what arrives and a writer task
//! flushes what `send` queued, so a slow write never stops a control frame from
//! being read. The writer always ends the conversation: it sends the close frame
//! the ending calls for, fails every frame still owed a `Sent`, then reports
//! `Close` once.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use bytes::Bytes;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Message, Utf8Bytes};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

use crate::driver::UpgradeIo;

mod drive;
#[cfg(test)]
mod tests;

/// `maxPayload` (`server.ts:252`): one inbound message, after any inflation.
pub const MAX_MESSAGE_BYTES: usize = 1 << 20;
/// `socket-input.ts`'s `messageOverhead`: a message is charged its length plus
/// this, so an empty one still counts.
pub const MESSAGE_OVERHEAD: u64 = 256;
/// The charged total the reader waits at (`socket-input.ts`'s `pauseBytes`).
pub const DELIVERY_BYTES: u64 = 1024 * 1024;
/// The messages the reader waits at, so empty ones are bounded too.
pub const DELIVERY_MESSAGES: u64 = 64;

/// `ws`'s ready states, as `readyState` reports them.
pub const OPEN: u8 = 1;
pub const CLOSING: u8 = 2;
pub const CLOSED: u8 = 3;

/// One thing that happened to a socket, in production order.
#[derive(Debug)]
pub enum SocketEvent {
    /// One inbound message, copied into a vector this socket owns alone, which
    /// the binding wipes after copying it to JavaScript (T1a.5).
    Message { data: Vec<u8>, binary: bool },
    /// The one completion of a `send` that returned [`SendResult::Queued`].
    Sent { id: u64, error: Option<String> },
    /// `too_big`, `protocol` or `io`; then the socket closes.
    Error { code: &'static str, message: String },
    /// The last event: exactly once, on every exit path.
    Close { code: u16, reason: Vec<u8> },
}

/// `ws`'s `send` outcome: queued for the writer, or refused because the state is
/// no longer `OPEN` (the caller takes the post-close path, T1a.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendResult {
    Queued,
    NotOpen,
}

/// What one socket is to its owner. Cheap to clone; every clone is one socket.
#[derive(Clone)]
pub struct SocketHandle {
    shared: Arc<Shared>,
}

/// What a `send` still owes: the id that gets one `Sent`, and the bytes it holds
/// in `buffered_amount` until it is flushed or failed.
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

/// How a socket's conversation ended, and what it still owes the wire.
struct Ending {
    /// `Close`'s code, and the close frame's when one is sent.
    code: u16,
    reason: Vec<u8>,
    /// The `Error` event to report before `Close`.
    error: Option<(&'static str, String)>,
    wire: Wire,
}

enum Wire {
    /// The connection is gone: nothing more is written.
    Nothing,
    /// The peer closed: flush tungstenite's queued reply.
    Reply,
    /// A violation: send `ws`'s close frame for this code.
    Close(u16),
}

impl Ending {
    /// The connection ended without a close handshake, or `terminate` dropped it.
    fn lost() -> Self {
        Self {
            code: 1006,
            reason: Vec::new(),
            error: None,
            wire: Wire::Nothing,
        }
    }
}

/// The socket's state, its outbound queue and its events under one lock, so a
/// `send` checks `OPEN` and enqueues as one step and nothing is emitted after
/// `Close`.
struct Inner {
    state: u8,
    /// `None` once the socket is closed: no later `send` can queue anything.
    outbound: Option<mpsc::UnboundedSender<Outbound>>,
    events: Option<mpsc::UnboundedSender<SocketEvent>>,
}

struct Shared {
    inner: Mutex<Inner>,
    /// Bytes accepted by `send` and not yet flushed.
    buffered: AtomicU64,
    paused: AtomicBool,
    /// Charged bytes and messages waiting for JavaScript, so for the reader.
    waiting_bytes: AtomicU64,
    waiting_messages: AtomicU64,
    wake: mpsc::Sender<()>,
    /// The conversation has ended: both tasks stop.
    over: CancellationToken,
    /// The first task to end records why; the writer reports it.
    ending: Mutex<Option<Ending>>,
}

impl SocketHandle {
    /// `ws`'s `send` while the state is `OPEN`. A frame is either queued (and
    /// then owes exactly one `Sent`) or refused with nothing emitted.
    pub fn send(&self, data: Bytes, binary: bool, id: u64) -> SendResult {
        let length = data.len() as u64;
        // `ws` refuses a text send that is not UTF-8, and queues nothing.
        let Ok(frame) = message(data, binary) else {
            return SendResult::NotOpen;
        };
        {
            let inner = lock(&self.shared.inner);
            if inner.state != OPEN {
                return SendResult::NotOpen;
            }
            let Some(outbound) = inner.outbound.as_ref() else {
                return SendResult::NotOpen;
            };
            let own = Some(Own { id, length });
            if outbound.send(Outbound { frame, own }).is_err() {
                return SendResult::NotOpen;
            }
        }
        self.shared.buffered.fetch_add(length, Ordering::Relaxed);
        SendResult::Queued
    }

    /// `ws`'s `close`: idempotent, and a socket already closing keeps its code.
    /// Nothing here times the handshake out; the TypeScript closer's `terminate`
    /// (`server-socket-close.ts`) bounds it, as it bounds `ws`'s socket today.
    pub fn close(&self, code: Option<u16>, reason: String) {
        let frame = Message::Close(code.map(|code| CloseFrame {
            code: CloseCode::from(code),
            reason: Utf8Bytes::from(reason),
        }));
        let mut inner = lock(&self.shared.inner);
        if inner.state != OPEN {
            return;
        }
        inner.state = CLOSING;
        if let Some(outbound) = inner.outbound.as_ref() {
            let _ = outbound.send(Outbound { frame, own: None });
        }
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

    /// Bytes accepted by `send` and not yet flushed.
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
        subtract(&shared.waiting_bytes, charge);
        subtract(&shared.waiting_messages, 1);
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
        self.waiting_bytes
            .fetch_add(data.len() as u64 + MESSAGE_OVERHEAD, Ordering::Relaxed);
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

    /// Completes a frame the writer is done with, flushed or failed.
    fn complete(&self, own: Option<Own>, error: Option<String>) {
        let Some(own) = own else {
            return;
        };
        subtract(&self.buffered, own.length);
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

    /// No later `send` can queue a frame, so everything left in the queue owes a
    /// `Sent` and nothing new can join it.
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
/// path's `Prefixed<TcpStream>`, the keep-alive path's upgraded stream). It is
/// `OPEN` at once: frames queued before the task runs are flushed in order. The
/// socket's tasks run on the caller's tokio runtime, as the binding's do (T1a.5).
pub fn open(stream: Box<dyn UpgradeIo>) -> (SocketHandle, mpsc::UnboundedReceiver<SocketEvent>) {
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
        paused: AtomicBool::new(false),
        waiting_bytes: AtomicU64::new(0),
        waiting_messages: AtomicU64::new(0),
        wake,
        over: CancellationToken::new(),
        ending: Mutex::new(None),
    });
    tokio::spawn(drive::run(stream, Arc::clone(&shared), queued, woken));
    (SocketHandle { shared }, incoming)
}

/// The frame for one outbound payload: text only for bytes that are UTF-8, which
/// everything TypeScript sends is.
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

fn subtract(counter: &AtomicU64, amount: u64) {
    let _ = counter.try_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
        Some(value.saturating_sub(amount))
    });
}
