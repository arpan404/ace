// SPDX-License-Identifier: Apache-2.0
//! The transport binding (T1a.5): the loopback listener, upgrade admission and
//! the socket, translated to JavaScript. No decision lives here. The listener,
//! the proxy hop, the handshake and the socket are `ace-transport`'s; the
//! admission state machine is [`admission`], the upgrade half is [`upgrade`] and
//! the socket half is [`socket`]. This module turns values, errors and handles
//! around and owns the shared state they name.
//!
//! `NativeLoopback.close` resolves only after every socket that reached
//! `opened` has reported `close`; an upgrade still deciding when the listener's
//! deadline passes is abandoned, and a promise that settles afterwards is only
//! released.

// napi-derive registers exports only outside test builds, so in the lib test
// target every export reads as unused.
#![cfg_attr(test, allow(dead_code))]

mod admission;
mod socket;
mod upgrade;

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use ace_transport::{HopSecret, LoopbackListener, ProxyTarget, WebSocketUpgrades};
use admission::{Admission, Held};
use napi::bindgen_prelude::Object;
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, JsValue};
use napi_derive::napi;
use tokio::runtime::{Handle, Runtime};
use tokio::sync::{Notify, watch};
use upgrade::{AdmitFn, Admitting, OpenedFn, ReleaseFn, Sinking};

/// The admission deadline when the caller names none: `socket-admission.ts`'s
/// hello window, which admission answers with its own `503`.
const ADMIT_TIMEOUT: Duration = Duration::from_secs(5);

/// The addon's transport runtime: the listener, its connections, and the tasks
/// that carry JavaScript's answers back. The shell's thread never waits on it.
static RUNTIME: OnceLock<Runtime> = OnceLock::new();

fn runtime() -> napi::Result<&'static Runtime> {
    if let Some(runtime) = RUNTIME.get() {
        return Ok(runtime);
    }
    let built = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .thread_name("ace-transport")
        .enable_all()
        .build()
        .map_err(|error| {
            napi::Error::from_reason(format!("transport runtime failed to start: {error}"))
        })?;
    let _ = RUNTIME.set(built);
    RUNTIME
        .get()
        .ok_or_else(|| napi::Error::from_reason("transport runtime failed to start"))
}

/// `start`'s options: the public port (`0` picks one), the internal server the
/// hop forwards to, this boot's hop secret as hex, and admission's deadline.
#[napi(object)]
pub struct StartOptions {
    pub port: f64,
    pub target_port: f64,
    pub secret_hex: String,
    pub admit_timeout_ms: f64,
}

/// Everything the admission half, the socket half and the listener share.
pub(crate) struct Shared {
    pub(crate) admission: Admission,
    pub(crate) admit: AdmitFn,
    pub(crate) release: ReleaseFn,
    pub(crate) opened: OpenedFn,
    pub(crate) timeout: Duration,
    pub(crate) runtime: Handle,
    pub(crate) live: Live,
    /// Resolves `true` at close: the promises still watched end there.
    pub(crate) stop: watch::Sender<bool>,
}

impl Shared {
    /// The one release: the machine's transition already happened, so this is
    /// the close wait's count and TypeScript's callback.
    pub(crate) fn release(&self, held: Held) {
        if held.writing {
            self.live.leave_writing();
        }
        self.release_js(held.reservation);
    }

    /// TypeScript drops one reservation. Called only by a transition that won.
    pub(crate) fn release_js(&self, reservation: u64) {
        let _ = self
            .release
            .call(reservation as f64, ThreadsafeFunctionCallMode::NonBlocking);
    }

    /// Everything the upgrade asks JavaScript, as one future: the call and the
    /// promise it returned.
    pub(crate) async fn ask(
        &self,
        request: upgrade::AdmitRequestJs,
    ) -> napi::Result<upgrade::AdmitAnswerJs> {
        let promise = self.admit.call_async_catch(request).await?;
        promise.await
    }
}

/// The close all `close` calls share: the first one stops the listener and waits
/// for every socket, and the promise of each call settles on the same signal.
struct CloseGate {
    started: Mutex<bool>,
    done: watch::Sender<bool>,
}

impl CloseGate {
    fn new() -> Self {
        Self {
            started: Mutex::new(false),
            done: watch::channel(false).0,
        }
    }
}

/// The sockets that reached `opened` and have not reported `close`, and the
/// upgrades still on the wire.
pub(crate) struct Live {
    next: AtomicU64,
    sockets: Mutex<HashSet<u64>>,
    /// Reservations in `Writing` that have neither opened nor been released. A
    /// hyper upgrade registers its socket from a task of its own, after the
    /// listener has drained, so the close waits for these too.
    writing: AtomicU64,
    quiet: Notify,
}

impl Live {
    fn new() -> Self {
        Self {
            next: AtomicU64::new(1),
            sockets: Mutex::new(HashSet::new()),
            writing: AtomicU64::new(0),
            quiet: Notify::new(),
        }
    }

    /// An upgrade reached `Writing`: its `101` is on the wire until it opens or
    /// releases.
    pub(crate) fn enter_writing(&self) {
        self.writing.fetch_add(1, Ordering::Relaxed);
    }

    /// An upgrade opened (its socket is counted first) or released.
    pub(crate) fn leave_writing(&self) {
        let mut remaining = 0;
        let _ = self
            .writing
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                remaining = count.saturating_sub(1);
                Some(remaining)
            });
        if remaining == 0 {
            self.quiet.notify_one();
        }
    }

    pub(crate) fn add(&self) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        locked(&self.sockets).insert(id);
        id
    }

    /// Idempotent: a socket's `close`, and a handle dropped before it ever
    /// listened, both end it, and either may be reported twice.
    pub(crate) fn done(&self, id: u64) {
        if locked(&self.sockets).remove(&id) {
            self.quiet.notify_one();
        }
    }

    /// Waits until no socket is left, taking the future before the check so a
    /// close that lands in between still wakes this wait.
    async fn quiet(&self) {
        loop {
            let quiet = self.quiet.notified();
            if self.writing.load(Ordering::Acquire) == 0 && locked(&self.sockets).is_empty() {
                return;
            }
            quiet.await;
        }
    }
}

pub(crate) fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// The loopback listener: `start` binds it, `close` stops it.
#[napi]
pub struct NativeLoopback {
    inner: Arc<Shared>,
    listener: Mutex<Option<LoopbackListener>>,
    closing: CloseGate,
    port: u16,
}

#[napi]
impl NativeLoopback {
    /// 32 bytes from the OS CSPRNG as hex, once per boot. The secret is never
    /// logged, written or published; TypeScript keeps it in memory and passes it
    /// back to `start`.
    #[napi(catch_unwind)]
    pub fn generate_secret() -> napi::Result<String> {
        HopSecret::generate()
            .map(|secret| secret.hex())
            .map_err(|error| napi::Error::from_reason(error.to_string()))
    }

    /// Binds the loopback listener and forwards HTTP to `targetPort`. Resolves
    /// once the port is bound; upgrades are decided through `admit`.
    #[napi(catch_unwind)]
    pub fn start(
        env: Env,
        options: StartOptions,
        admit: AdmitFn,
        release: ReleaseFn,
        opened: OpenedFn,
    ) -> napi::Result<Object<'static>> {
        let secret = HopSecret::from_hex(&options.secret_hex)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let target = ProxyTarget::new(
            addr(options.target_port, "targetPort", false)?,
            Arc::new(secret),
        )
        .map_err(|error| napi::Error::from_reason(error.to_string()))?;
        let listen = addr(options.port, "port", true)?;
        let runtime = runtime()?;
        let shared = Arc::new(Shared {
            admission: Admission::new(),
            admit,
            release,
            opened,
            timeout: admit_timeout(options.admit_timeout_ms),
            runtime: runtime.handle().clone(),
            live: Live::new(),
            stop: watch::channel(false).0,
        });
        let upgrades = Arc::new(WebSocketUpgrades::new(
            Arc::new(Admitting(Arc::clone(&shared))),
            Arc::new(Sinking(Arc::clone(&shared))),
        ));
        let (deferred, promise) = env.create_deferred()?;
        let raw = promise.raw();
        runtime.spawn(async move {
            match LoopbackListener::bind(listen, target, upgrades).await {
                Ok(listener) => {
                    let port = listener.local_addr().port();
                    let loopback = NativeLoopback {
                        inner: shared,
                        listener: Mutex::new(Some(listener)),
                        closing: CloseGate::new(),
                        port,
                    };
                    deferred.resolve(move |_env| Ok(loopback));
                }
                Err(error) => deferred.reject(napi::Error::from_reason(error.to_string())),
            }
        });
        Ok(Object::from_raw(env.raw(), raw))
    }

    /// The port the listener bound; a `0` request's port is known here only.
    #[napi(catch_unwind)]
    pub fn port(&self) -> f64 {
        f64::from(self.port)
    }

    /// Stops accepting, abandons what is still deciding at the deadline, and
    /// resolves once every socket that opened has reported `close` to
    /// JavaScript. A second call waits on the same close, listener drain and
    /// late registrations included.
    #[napi(catch_unwind)]
    pub fn close(&self, env: Env, deadline_ms: f64) -> napi::Result<Object<'static>> {
        // Only the first call owns the listener join; every call settles on the
        // one completion below.
        let first = {
            let mut started = locked(&self.closing.started);
            let first = !*started;
            *started = true;
            first
        };
        let listener = if first {
            locked(&self.listener).take()
        } else {
            None
        };
        let shared = Arc::clone(&self.inner);
        let deadline = Duration::from_millis(deadline(deadline_ms));
        let gate = self.closing.done.clone();
        let runtime = runtime()?;
        let (deferred, promise) = env.create_deferred()?;
        let raw = promise.raw();
        runtime.spawn(async move {
            if first {
                if let Some(listener) = listener {
                    listener.close(deadline).await;
                }
                // Every upgrade still deciding was dropped by the listener above,
                // so its promise is no longer watched: TypeScript drops what it
                // holds at close anyway.
                let _ = shared.stop.send_replace(true);
                shared.live.quiet().await;
                let _ = gate.send_replace(true);
            }
            let mut done = gate.subscribe();
            let _ = done.wait_for(|closed| *closed).await;
            deferred.resolve(|_env| Ok(()));
        });
        Ok(Object::from_raw(env.raw(), raw))
    }

    /// T1a.4's unpaired-debit count: a non-zero value is this crate's bug, never
    /// the peer's, and the shell warns once when it reads one.
    #[napi(catch_unwind)]
    pub fn underflow_count() -> f64 {
        ace_transport::socket::underflow_count() as f64
    }
}

// A number that names a port: a whole number in `0..=65535`, where `0` is only
/// a port when the caller may pick one.
fn addr(value: f64, name: &str, any_port: bool) -> napi::Result<SocketAddr> {
    let lowest = if any_port { 0.0 } else { 1.0 };
    if !value.is_finite() || value.fract() != 0.0 || value < lowest || value > 65535.0 {
        return Err(napi::Error::from_reason(format!("Invalid {name}")));
    }
    Ok(SocketAddr::from((Ipv4Addr::LOCALHOST, value as u16)))
}

/// `admitTimeoutMs`, with the shell's 5,000 when it names none.
fn admit_timeout(milliseconds: f64) -> Duration {
    if !milliseconds.is_finite() || milliseconds <= 0.0 {
        return ADMIT_TIMEOUT;
    }
    Duration::from_millis(milliseconds as u64)
}

fn deadline(milliseconds: f64) -> u64 {
    if !milliseconds.is_finite() || milliseconds <= 0.0 {
        return 0;
    }
    milliseconds as u64
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    use super::Live;

    #[tokio::test]
    async fn a_close_waits_for_an_upgrade_that_has_not_registered_its_socket_yet() {
        let live = Arc::new(Live::new());
        live.enter_writing();
        let stopped = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&stopped);
        let waiting = Arc::clone(&live);
        let quiet = tokio::spawn(async move {
            waiting.quiet().await;
            flag.store(true, Ordering::Release);
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !stopped.load(Ordering::Acquire),
            "the close waits while the 101 is on the wire"
        );
        live.leave_writing();
        tokio::time::timeout(Duration::from_secs(2), quiet)
            .await
            .expect("the close finishes once the upgrade registers or releases")
            .expect("the wait did not panic");
        assert!(stopped.load(Ordering::Acquire));
    }
}
