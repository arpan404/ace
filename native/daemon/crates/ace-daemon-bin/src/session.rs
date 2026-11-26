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
use std::time::Duration;

use ace_transport::deflate::Deflate;
use ace_transport::driver::UpgradeIo;
use ace_transport::socket::{self, MESSAGE_OVERHEAD, SocketEvent, SocketHandle};
use bytes::Bytes;
use serde_json::Value;

/// What a session tells the daemon when it ends.
pub type Closed = Arc<dyn Fn() + Send + Sync>;

/// The socket timers (`socket-admission.ts:26`, `server.ts:733`): a hello within
/// five seconds, and an idle socket closed with `4008` after a minute.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub hello: Duration,
    pub idle: Duration,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            hello: Duration::from_secs(5),
            idle: Duration::from_secs(60),
        }
    }
}

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
    Authenticated {
        welcome: Welcome,
        /// The hello's `channel`, when it named one.
        channel: Option<String>,
        /// The credential holds `admin`: the devices channel requires it.
        admin: bool,
    },
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
    // Whether startup finished; a hello before it gets `starting` first.
    ready: Arc<std::sync::atomic::AtomicBool>,
    limits: Limits,
    authenticated: Arc<dyn Fn() + Send + Sync>,
    closed: Closed,
) -> SocketHandle {
    let (handle, mut events) = socket::open(stream, deflate, None);
    let sending = handle.clone();
    let next = Arc::new(AtomicU64::new(1));
    tokio::spawn(async move {
        let mut state = State::default();
        let hello = tokio::time::sleep(limits.hello);
        let idle = tokio::time::sleep(limits.idle);
        tokio::pin!(hello);
        tokio::pin!(idle);
        loop {
            let event = tokio::select! {
                event = events.recv() => event,
                // An unauthenticated socket is terminated after the hello window,
                // freeing its pre-authentication slot (`socket-admission.ts:120`).
                _ = &mut hello, if !state.signed_in => {
                    sending.terminate();
                    None
                }
                _ = &mut idle => {
                    let _ = sending.close(Some(4008), "Idle timeout".to_owned());
                    // Let the close frame reach the peer, then stop.
                    let _ = tokio::time::timeout(Duration::from_secs(1), events.recv()).await;
                    None
                }
            };
            let Some(event) = event else { break };
            idle.as_mut()
                .reset(tokio::time::Instant::now() + limits.idle);
            match event {
                SocketEvent::Message { data, binary } => {
                    let charge = data.len() as u64 + MESSAGE_OVERHEAD;
                    state = handle_message(
                        &sending,
                        &next,
                        &auth,
                        local,
                        &ready,
                        &authenticated,
                        &data,
                        binary,
                        state,
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

/// What the socket has become.
#[derive(Debug, Clone, Copy, Default)]
struct State {
    signed_in: bool,
    admin: bool,
}

/// The answer a session owes one inbound message.
#[allow(clippy::too_many_arguments)]
fn handle_message(
    handle: &SocketHandle,
    next: &AtomicU64,
    auth: &Arc<dyn Authenticator>,
    local: bool,
    ready: &Arc<std::sync::atomic::AtomicBool>,
    authenticated: &Arc<dyn Fn() + Send + Sync>,
    data: &[u8],
    binary: bool,
    state: State,
) -> State {
    if binary {
        refuse(handle, next, "Message does not match the protocol");
        return state;
    }
    let Ok(value) = serde_json::from_slice::<Value>(data) else {
        refuse(handle, next, "Message does not match the protocol");
        return state;
    };
    match value.get("type").and_then(Value::as_str) {
        // A heartbeat is answered only once welcomed: before the hello, every
        // frame but the hello is refused (`server.ts:866`).
        Some("ping") if state.signed_in => {
            send(handle, next, br#"{"type":"pong"}"#);
            state
        }
        Some("hello") if !state.signed_in => {
            let Ok(text) = std::str::from_utf8(data) else {
                refuse(handle, next, "Message does not match the protocol");
                return state;
            };
            match auth.hello(text, local) {
                Answer::Authenticated {
                    welcome: Welcome::Frame(frame),
                    channel,
                    admin,
                } => {
                    authenticated();
                    // The promise the welcome makes is that the services are up:
                    // a hello that arrives before that is told they are starting.
                    if !ready.load(Ordering::Acquire) {
                        send(handle, next, br#"{"type":"starting"}"#);
                    }
                    send(handle, next, &frame);
                    if channel.as_deref() == Some("devices") && admin {
                        // The devices service is not in this slice: say off, and
                        // answer its requests with the boundary's refusal.
                        send(
                            handle,
                            next,
                            br#"{"type":"devices.enabled","enabled":false}"#,
                        );
                    }
                    State {
                        signed_in: true,
                        admin,
                    }
                }
                Answer::Refused { message } => {
                    refuse(handle, next, message);
                    state
                }
                Answer::Invalid => {
                    refuse(handle, next, "Message does not match the protocol");
                    state
                }
                Answer::Unavailable => {
                    let _ = handle.close(Some(1011), "service_unavailable".to_owned());
                    state
                }
            }
        }
        // A second hello on an authenticated socket closes it without another
        // welcome (`auth.server.process.test.ts`).
        Some("hello") => {
            refuse(handle, next, "Hello is only valid once");
            state
        }
        Some("devices.request") if state.signed_in => {
            if state.admin {
                device_unavailable(handle, next, &value);
            } else {
                device_refused(handle, next, &value);
            }
            state
        }
        Some("devices.ack") if state.signed_in => state,
        _ => {
            if state.signed_in {
                // T2's command and read owners answer authenticated messages;
                // until they are wired, an authenticated unknown type is the
                // daemon's `unsupported` answer.
                unsupported(handle, next, &value);
            } else {
                refuse(handle, next, "Valid hello required");
            }
            state
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

/// `devices.result` with `deviceAccessRefused`, for a credential without admin.
fn device_refused(handle: &SocketHandle, next: &AtomicU64, value: &Value) {
    let Some(request_id) = value.get("requestId") else {
        return;
    };
    let body = format!(
        r#"{{"type":"devices.result","requestId":{request_id},"ok":false,"error":{{"code":"permission_denied","message":"Administrator scope is required for device access","hint":"Connect with an administrator device credential to use Devices."}}}}"#
    );
    send(handle, next, body.as_bytes());
}

/// `devices.result` with `devicesUnavailable`, for a devices request no service
/// answers (`services/device-refusals.ts`).
fn device_unavailable(handle: &SocketHandle, next: &AtomicU64, value: &Value) {
    let Some(request_id) = value.get("requestId") else {
        return;
    };
    let body = format!(
        r#"{{"type":"devices.result","requestId":{request_id},"ok":false,"error":{{"code":"not_supported","message":"Devices service is unavailable on this daemon","hint":"Check the daemon's device service and reconnect."}}}}"#
    );
    send(handle, next, body.as_bytes());
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
