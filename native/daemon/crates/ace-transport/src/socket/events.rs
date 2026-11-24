// SPDX-License-Identifier: Apache-2.0
//! What a socket reports and the receiver's half of it. Dropping the receiver
//! ends the socket and wipes every payload it never delivered, which the channel
//! alone would only free.

use std::sync::Arc;

use tokio::sync::mpsc;
use zeroize::Zeroize;

use super::{Ending, Shared, debit, lock};

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
/// no longer `OPEN` or the outbound queue is over its bound (the caller takes the
/// post-close path, T1a.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SendResult {
    Queued,
    NotOpen,
}

/// The socket's events. Dropping it ends the socket and wipes every payload that
/// was queued but never delivered.
pub struct SocketEvents {
    pub(super) receiver: mpsc::UnboundedReceiver<SocketEvent>,
    pub(super) shared: Arc<Shared>,
}

impl SocketEvents {
    /// The next event. Taking a `Sent` is what releases its place in the outbound
    /// queue's bound: a caller that stops reading stops being able to send.
    pub async fn recv(&mut self) -> Option<SocketEvent> {
        let event = self.receiver.recv().await;
        self.release(event.as_ref());
        event
    }

    pub fn try_recv(&mut self) -> Result<SocketEvent, mpsc::error::TryRecvError> {
        let event = self.receiver.try_recv()?;
        self.release(Some(&event));
        Ok(event)
    }

    fn release(&self, event: Option<&SocketEvent>) {
        if matches!(event, Some(SocketEvent::Sent { .. })) {
            debit(&self.shared.pending, 1, "pending");
        }
    }
}

impl Drop for SocketEvents {
    fn drop(&mut self) {
        self.shared.end(Ending::lost());
        // Taking the sender first is what makes this drain complete: an emit that
        // arrives after it finds no sender and wipes its own payload, so every
        // payload still queued is one wiped below.
        {
            let mut inner = lock(&self.shared.inner);
            inner.events = None;
        }
        while let Ok(mut event) = self.receiver.try_recv() {
            if let SocketEvent::Message { data, .. } = &mut event {
                data.zeroize();
            }
        }
    }
}
