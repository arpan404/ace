// SPDX-License-Identifier: Apache-2.0
//! The handle the socket's owner drives: `ws`'s `send`, `close`, `terminate`,
//! `pause`, `resume` and `bufferedAmount`, over the state `socket` keeps.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use bytes::Bytes;

use super::drive::Ending;
use super::events::SendResult;
use super::{
    CLOSE_TIMEOUT, CLOSED, CLOSING, MESSAGE_OVERHEAD, OPEN, OUTBOUND_MESSAGES, Own, Queued, Shared,
    debit, lock, message,
};
use crate::frame::assemble::valid_status;
use crate::frame::{Opcode, Outbound as Frame};

/// Why `ws` refuses a local close before anything reaches the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseError {
    /// Not `isValidStatusCode` (sender.js:184): `TypeError` in `ws`.
    InvalidCode,
    /// A reason over 123 bytes: `RangeError` in `ws` (sender.js:196).
    ReasonTooLong,
}

impl CloseError {
    /// `ws`'s words for the throw.
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidCode => "First argument must be a valid error code number",
            Self::ReasonTooLong => "The message must not be greater than 123 bytes",
        }
    }
}

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

impl SocketHandle {
    /// The handle for a freshly opened socket; its owner keeps the socket alive.
    pub(super) fn attach(shared: Arc<Shared>) -> Self {
        Self {
            _owner: Arc::new(Owner(Arc::clone(&shared))),
            shared,
        }
    }

    /// `ws`'s `send` while the state is `OPEN`. A frame is either queued (and
    /// then owes exactly one `Sent`) or refused with a reason and nothing
    /// emitted, charged or counted.
    pub fn send(&self, data: Bytes, binary: bool, id: u64) -> SendResult {
        let length = data.len() as u64 + MESSAGE_OVERHEAD;
        // `ws` refuses a text send that is not UTF-8, and queues nothing.
        let Ok(frame) = message(data, binary) else {
            return SendResult::InvalidUtf8;
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
            return SendResult::Full;
        }
        // Charged under the lock and before the enqueue, so the writer can never
        // complete a frame whose bytes were not charged yet: a debit therefore
        // always follows its charge.
        shared.buffered.fetch_add(length, Ordering::Relaxed);
        shared.pending.fetch_add(1, Ordering::Relaxed);
        let own = Some(Own { id });
        match outbound.send(Queued {
            frame,
            own,
            charge: length,
            control: false,
        }) {
            Ok(()) => SendResult::Queued,
            Err(_) => {
                debit(&shared.buffered, length);
                debit(&shared.pending, 1);
                SendResult::NotOpen
            }
        }
    }

    /// `ws`'s `close`: idempotent, and a socket already closing keeps its code.
    /// Its deadline starts here, as `ws`'s close timer does, whatever is queued.
    pub fn close(&self, code: Option<u16>, reason: String) -> Result<(), CloseError> {
        let mut payload = Vec::with_capacity(2 + reason.len());
        let mut inner = lock(&self.shared.inner);
        // `ws` returns for a socket that is no longer open before its sender
        // validates the code or reason (websocket.js:315-331), so a late invalid
        // close is a no-op rather than a throw.
        if inner.state != OPEN {
            return Ok(());
        }
        // A close with no code writes no payload at all, reason included, as `ws`
        // does when `close()` is called with no arguments.
        if let Some(code) = code {
            if !valid_status(code) {
                return Err(CloseError::InvalidCode);
            }
            if reason.len() > 123 {
                return Err(CloseError::ReasonTooLong);
            }
            payload.extend_from_slice(&code.to_be_bytes());
            payload.extend_from_slice(reason.as_bytes());
        }
        inner.state = CLOSING;
        inner.close = Some(payload.clone());
        if let Some(outbound) = inner.outbound.as_ref() {
            let frame = Frame {
                opcode: Opcode::Close,
                rsv1: false,
                payload: Bytes::from(payload),
            };
            let _ = outbound.send(Queued {
                frame,
                own: None,
                charge: 0,
                control: false,
            });
        }
        drop(inner);
        let expired = self.shared.expired.clone();
        let over = self.shared.over.clone();
        let runtime = self.shared.runtime.clone();
        // The deadline is taken now, through the socket's own time driver, not
        // when the timer task is first polled.
        let deadline = {
            let _entered = runtime.enter();
            tokio::time::sleep(CLOSE_TIMEOUT)
        };
        runtime.spawn(async move {
            tokio::select! {
                biased;
                // The handshake finished first, or the socket ended.
                _ = over.cancelled() => {}
                () = deadline => expired.cancel(),
            }
        });
        Ok(())
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
        debit(&shared.waiting_bytes, charge);
        debit(&shared.waiting_messages, 1);
        shared.wake();
    }
}
