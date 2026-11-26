// SPDX-License-Identifier: Apache-2.0
//! One WebSocket session, in Rust: the seam T2 (hello, authentication, devices)
//! fills in.
//!
//! A socket that has not authenticated is refused exactly as the TypeScript
//! refuses it: a first frame that is binary, is not JSON or is not a `hello` gets
//! `{"type":"error","code":"unauthorized","message":"Valid hello required"}` (or
//! "Message does not match the protocol" for a broken frame) and close `4001`
//! (`server.ts:855`–`:900`). A `ping` before the hello gets `pong`, as the
//! transport answers it before any handler.
//!
//! [`Authenticator`] is the socket-facing seam: T2's `ace-auth` supplies the
//! decision (welcome or refusal) and the daemon releases the socket's
//! pre-authentication slot when it accepts one.
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

/// What a hello authenticated.
// T2's authenticator constructs these; slice 1's refuses every hello.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Welcome {
    /// The frame to put on the wire before anything else (T2 builds it).
    Frame(Vec<u8>),
}

/// Who decides a hello, and with what answer. T2's `ace-auth` implements this.
pub trait Authenticator: Send + Sync + 'static {
    /// The `hello` frame's text, and whether this socket is on loopback. The
    /// authenticator parses it with `ace-auth`'s one hello decoder.
    fn hello(&self, text: &str, local: bool) -> Answer;
}

/// An authenticator's answer to one hello.
// T2's authenticator constructs these; slice 1's refuses every hello.
#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// The socket is authenticated: send this first, then continue.
    Authenticated(Welcome),
    /// The hello authenticated nothing: this message, then close `4001`.
    Refused { message: &'static str },
    /// The hello did not match the protocol: "Message does not match the protocol".
    Invalid,
    /// Finishing the hello failed in the store: close `1011 service_unavailable`.
    Unavailable,
}

/// Open a socket and run its session on the current runtime. The returned handle
/// is what a shutdown closes; `authenticated` runs once the hello is accepted, and
/// `closed` when the last event arrived.
#[allow(clippy::too_many_arguments)]
pub fn start(
    stream: Box<dyn UpgradeIo>,
    deflate: Option<Deflate>,
    auth: Arc<dyn Authenticator>,
    local: bool,
    authenticated: Arc<dyn Fn() + Send + Sync>,
    closed: Closed,
) -> SocketHandle {
    let (handle, mut events) = socket::open(stream, deflate, None);
    let sending = handle.clone();
    let next = Arc::new(AtomicU64::new(1));
    tokio::spawn(async move {
        let mut signed_in = false;
        while let Some(event) = events.recv().await {
            match event {
                SocketEvent::Message { data, binary } => {
                    let charge = data.len() as u64 + MESSAGE_OVERHEAD;
                    signed_in = handle_message(
                        &sending,
                        &next,
                        &auth,
                        local,
                        &authenticated,
                        &data,
                        binary,
                        signed_in,
                    );
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

/// The answer a session owes one inbound message. Returns whether it is signed in.
#[allow(clippy::too_many_arguments)]
fn handle_message(
    handle: &SocketHandle,
    next: &AtomicU64,
    auth: &Arc<dyn Authenticator>,
    local: bool,
    authenticated: &Arc<dyn Fn() + Send + Sync>,
    data: &[u8],
    binary: bool,
    signed_in: bool,
) -> bool {
    if binary {
        refuse(handle, next, "Message does not match the protocol");
        return signed_in;
    }
    let Ok(value) = serde_json::from_slice::<Value>(data) else {
        refuse(handle, next, "Message does not match the protocol");
        return signed_in;
    };
    match value.get("type").and_then(Value::as_str) {
        // A heartbeat is answered only once welcomed: before the hello, every
        // frame but the hello is refused (`server.ts:866`).
        Some("ping") if signed_in => {
            send(handle, next, br#"{"type":"pong"}"#);
            signed_in
        }
        Some("hello") if !signed_in => {
            let Ok(text) = std::str::from_utf8(data) else {
                refuse(handle, next, "Message does not match the protocol");
                return signed_in;
            };
            match auth.hello(text, local) {
                Answer::Authenticated(Welcome::Frame(frame)) => {
                    authenticated();
                    send(handle, next, &frame);
                    true
                }
                Answer::Refused { message } => {
                    refuse(handle, next, message);
                    signed_in
                }
                Answer::Invalid => {
                    refuse(handle, next, "Message does not match the protocol");
                    signed_in
                }
                Answer::Unavailable => {
                    let _ = handle.close(Some(1011), "service_unavailable".to_owned());
                    signed_in
                }
            }
        }
        // A second hello on an authenticated socket closes it without another
        // welcome (`auth.server.process.test.ts`).
        Some("hello") => {
            refuse(handle, next, "Hello is only valid once");
            signed_in
        }
        _ => {
            if signed_in {
                // T2's command and read owners answer authenticated messages;
                // until they are wired, an authenticated unknown type is the
                // daemon's `unsupported` answer.
                unsupported(handle, next, &value);
            } else {
                refuse(handle, next, "Valid hello required");
            }
            signed_in
        }
    }
}

/// `fail("unauthorized", message, true)`: the error, then close `4001`.
fn refuse(handle: &SocketHandle, next: &AtomicU64, message: &str) {
    let body = format!(
        r#"{{"type":"error","code":"unauthorized","message":{}}}"#,
        Value::String(message.to_owned())
    );
    send(handle, next, body.as_bytes());
    let _ = handle.close(Some(4001), "unauthorized".to_owned());
}

/// `{type:"error", code:"unsupported"}` for an authenticated unknown request.
fn unsupported(handle: &SocketHandle, next: &AtomicU64, value: &Value) {
    let request_id = value.get("requestId").cloned();
    let body = match request_id {
        Some(request_id) => format!(
            r#"{{"type":"error","code":"unsupported","message":"Request type is not supported by this daemon","requestId":{request_id}}}"#
        ),
        None => String::from(
            r#"{"type":"error","code":"unsupported","message":"Request type is not supported by this daemon"}"#,
        ),
    };
    send(handle, next, body.as_bytes());
}

fn send(handle: &SocketHandle, next: &AtomicU64, payload: &[u8]) {
    let id = next.fetch_add(1, Ordering::Relaxed);
    let _ = handle.send(Bytes::copy_from_slice(payload), false, false, id);
}
