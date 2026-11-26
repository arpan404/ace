// SPDX-License-Identifier: Apache-2.0
//! One WebSocket session, in Rust: the seam T2 (hello, authentication, devices)
//! fills in.
//!
//! A socket that has not authenticated is refused exactly as the TypeScript
//! refuses it: a first frame that is binary, is not JSON, is not a `hello`, or
//! names credentials this build cannot check yet gets
//! `{"type":"error","code":"unauthorized"}` and close `4001`
//! (`server.ts:855`–`:900`, `auth.server.process.test.ts`). A `ping` before the
//! hello gets `pong`, as the transport answers it before any handler.
//!
//! TypeScript cases ported: `apps/daemon/src/auth.server.process.test.ts`
//! ("closes without sending data for a non-hello first frame", "closes without
//! sending data for a token prefix followed by extra bytes", "closes without
//! sending data for an unsupported protocol version", "closes without sending
//! data for a missing token", "rejects a binary first frame even when it contains
//! a valid hello").

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use ace_transport::deflate::Deflate;
use ace_transport::driver::UpgradeIo;
use ace_transport::socket::{self, MESSAGE_OVERHEAD, SocketEvent, SocketHandle};
use bytes::Bytes;
use serde_json::Value;

/// What a session tells the daemon when it ends.
pub type Closed = Arc<dyn Fn() + Send + Sync>;

/// Open a socket and run its session on the current runtime. The returned handle
/// is what a shutdown closes; `closed` runs when its last event arrived.
pub fn start(stream: Box<dyn UpgradeIo>, deflate: Option<Deflate>, closed: Closed) -> SocketHandle {
    let (handle, mut events) = socket::open(stream, deflate, None);
    let sending = handle.clone();
    let next = Arc::new(AtomicU64::new(1));
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                SocketEvent::Message { data, binary } => {
                    let charge = data.len() as u64 + MESSAGE_OVERHEAD;
                    handle_message(&sending, &next, &data, binary);
                    sending.delivered(charge);
                }
                SocketEvent::Error { code, message } => {
                    // Nothing to send: the socket is closing. Kept for the log later.
                    let _ = (code, message);
                }
                SocketEvent::Sent { .. } => {}
                SocketEvent::Close { .. } => break,
            }
        }
        closed();
    });
    handle
}

/// The answer a session owes one inbound message.
fn handle_message(handle: &SocketHandle, next: &AtomicU64, data: &[u8], binary: bool) {
    if binary {
        refuse(handle, next, Some("Message does not match the protocol"));
        return;
    }
    let Ok(value) = serde_json::from_slice::<Value>(data) else {
        refuse(handle, next, Some("Message does not match the protocol"));
        return;
    };
    match value.get("type").and_then(Value::as_str) {
        // A heartbeat is answered before any handler, authenticated or not.
        Some("ping") => send(handle, next, br#"{"type":"pong"}"#),
        Some("hello") => {
            // Slice 1 has no credential check to run: the hello is refused as a
            // hello that authenticates nothing is, and T2 replaces this seam.
            refuse(handle, next, Some("Valid hello required"));
        }
        _ => refuse(handle, next, Some("Valid hello required")),
    }
}

/// `fail("unauthorized", message, true)`: the error, then close `4001`.
fn refuse(handle: &SocketHandle, next: &AtomicU64, message: Option<&str>) {
    let body = match message {
        None => String::from(r#"{"type":"error","code":"unauthorized"}"#),
        Some(message) => format!(
            r#"{{"type":"error","code":"unauthorized","message":{}}}"#,
            Value::String(message.to_owned())
        ),
    };
    send(handle, next, body.as_bytes());
    let _ = handle.close(Some(4001), "unauthorized".to_owned());
}

fn send(handle: &SocketHandle, next: &AtomicU64, payload: &[u8]) {
    let id = next.fetch_add(1, Ordering::Relaxed);
    let _ = handle.send(Bytes::copy_from_slice(payload), false, false, id);
}
