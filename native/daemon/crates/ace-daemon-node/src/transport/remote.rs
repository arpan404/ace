// SPDX-License-Identifier: Apache-2.0
//! The remote listeners' binding (T1b.1b): `NativeRemote`, one Rust listener per
//! bind, translated to JavaScript. It reuses T1a's admission state machine and
//! its `Admitting`/`Sinking` bridges, one instance per listener; no decision
//! lives here.
//!
//! A start resolves once the port is bound and never waits on a certificate or
//! the network. A bind failure rejects with the OS's own words, as
//! `bindListener` reports it. Failures after the bind reach `error`, the first
//! of each OS code at once and then at most one a minute per code with the count
//! since (the brief's difference 11).

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use ace_supervisor::errors::NodeIoError;
use ace_transport::prefixed::WRITE_TIMEOUT;
use ace_transport::{
    ConnectionLimits, Counts, ErrorSink, HopSecret, ProxyTarget, RemoteListener, TlsIdentity,
    WebSocketUpgrades, process_provider,
};
use napi::bindgen_prelude::{Buffer, Object};
use napi::threadsafe_function::ThreadsafeFunctionCallMode;
use napi::{Env, JsValue};
use napi_derive::napi;
use tokio::sync::watch;

use super::admission::Admission;
use super::upgrade::{AdmitFn, Admitting, ErrorFn, OpenedFn, ReleaseFn, Sinking};
use super::{CloseGate, Live, Shared, admit_timeout, bind_rejection, deadline, locked, runtime};

/// How long a listener waits before reporting the same OS accept failure again.
const REPORT_INTERVAL: Duration = Duration::from_secs(60);

/// `start`'s timers, as the shell names them (milliseconds).
#[napi(object)]
pub struct RemoteLimitsJs {
    pub handshake_ms: f64,
    pub first_head_ms: f64,
    /// `null`: only the idle timer bounds a later head.
    pub head_ms: Option<f64>,
    pub keep_alive_ms: f64,
    /// `null`: no trusted keep-alive (the static listener).
    pub trusted_keep_alive_ms: Option<f64>,
}

/// `start`'s options: the bind address, the internal server the hop forwards to,
/// this boot's hop secret, and the identity's PEM bytes exactly as TypeScript
/// loaded them.
#[napi(object)]
pub struct RemoteStartOptions {
    pub host: String,
    pub port: f64,
    pub target_port: f64,
    pub secret_hex: String,
    pub admit_timeout_ms: f64,
    pub cert: Buffer,
    pub key: Buffer,
    pub limits: RemoteLimitsJs,
}

/// What one listener handled since it bound, for the evidence file.
#[napi(object)]
pub struct HandledJs {
    pub connections: f64,
    pub exchanges: f64,
    pub upgrades: f64,
    pub trusted_handshakes: f64,
    pub post_quantum_handshakes: f64,
    pub deflated_out: f64,
    pub inflated_in: f64,
}

impl From<Counts> for HandledJs {
    fn from(counts: Counts) -> Self {
        Self {
            connections: counts.connections as f64,
            exchanges: counts.exchanges as f64,
            upgrades: counts.upgrades as f64,
            trusted_handshakes: counts.trusted_handshakes as f64,
            post_quantum_handshakes: counts.post_quantum_handshakes as f64,
            deflated_out: counts.deflated_out as f64,
            inflated_in: counts.inflated_in as f64,
        }
    }
}

/// The per-code throttle for accept failures after the bind.
struct Reported {
    seen: Mutex<HashMap<String, Seen>>,
}

struct Seen {
    last: Instant,
    /// The failures since the last report, not counting the reported one.
    since: u64,
}

impl Reported {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            seen: Mutex::new(HashMap::new()),
        })
    }

    /// One accept failure: reported now if its code is new or a minute passed,
    /// otherwise counted for that code's next line.
    fn report(&self, error: &std::io::Error, sink: &ErrorFn) {
        let code = NodeIoError::new("accept", error).code().to_owned();
        let repeated = {
            let mut seen = locked(&self.seen);
            let now = Instant::now();
            match seen.get_mut(&code) {
                Some(entry) if now.duration_since(entry.last) < REPORT_INTERVAL => {
                    entry.since += 1;
                    return;
                }
                Some(entry) => {
                    let repeated = entry.since;
                    entry.since = 0;
                    entry.last = now;
                    repeated
                }
                None => {
                    seen.insert(
                        code.clone(),
                        Seen {
                            last: now,
                            since: 0,
                        },
                    );
                    0
                }
            }
        };
        let _ = sink.call(
            napi::bindgen_prelude::FnArgs::from((code, error.to_string(), repeated as f64)),
            ThreadsafeFunctionCallMode::NonBlocking,
        );
    }
}

#[napi]
pub struct NativeRemote {
    inner: Arc<Shared>,
    listener: Mutex<Option<RemoteListener>>,
    closing: CloseGate,
    port: u16,
}

#[napi]
impl NativeRemote {
    /// Parses the PEM as `start` will, and throws naming what is unusable. The
    /// process provider is installed here too (T1b.1a).
    #[napi(catch_unwind)]
    pub fn check_identity(cert: Buffer, key: Buffer) -> napi::Result<()> {
        let _provider = process_provider().map_err(reason)?;
        TlsIdentity::from_pem(cert.as_ref(), key.as_ref())
            .map(|_| ())
            .map_err(reason)
    }

    /// Binds the listener and terminates TLS with `cert`/`key`, resolving once
    /// the port is bound; upgrades go through `admit`, and accept failures after
    /// the bind reach `error`.
    #[napi(catch_unwind)]
    pub fn start(
        env: Env,
        options: RemoteStartOptions,
        admit: AdmitFn,
        release: ReleaseFn,
        opened: OpenedFn,
        error: ErrorFn,
    ) -> napi::Result<Object<'static>> {
        let provider = process_provider().map_err(reason)?;
        let identity =
            TlsIdentity::from_pem(options.cert.as_ref(), options.key.as_ref()).map_err(reason)?;
        let secret = HopSecret::from_hex(&options.secret_hex).map_err(reason)?;
        let target = ProxyTarget::new(
            addr(options.target_port, "targetPort", false)?,
            Arc::new(secret),
        )
        .map_err(reason)?;
        let limits = connection_limits(options.limits);
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
            stats: OnceLock::new(),
        });
        let upgrades = Arc::new(WebSocketUpgrades::new(
            Arc::new(Admitting(Arc::clone(&shared))),
            Arc::new(Sinking(Arc::clone(&shared))),
        ));
        let reported = Reported::new();
        let report: ErrorSink = Arc::new(move |failure| reported.report(failure, &error));
        let (deferred, promise) = env.create_deferred()?;
        let raw = promise.raw();
        runtime.spawn(async move {
            let addr = match resolve(&options.host, options.port).await {
                Ok(addr) => addr,
                Err(error) => {
                    deferred.reject(error);
                    return;
                }
            };
            match RemoteListener::bind_reporting(
                addr,
                provider,
                identity,
                limits,
                target,
                upgrades,
                Some(report),
            )
            .await
            {
                Ok(listener) => {
                    let port = listener.local_addr().port();
                    let _ = shared.stats.set(listener.stats());
                    let remote = NativeRemote {
                        inner: shared,
                        listener: Mutex::new(Some(listener)),
                        closing: CloseGate::new(),
                        port,
                    };
                    deferred.resolve(move |_env| Ok(remote));
                }
                Err(ace_transport::TransportError::Bind { addr, source }) => {
                    deferred.reject(bind_rejection(addr, &source))
                }
                Err(error) => deferred.reject(reason(error)),
            }
        });
        Ok(Object::from_raw(env.raw(), raw))
    }

    /// The port the listener bound; a `0` request's port is known here only.
    #[napi(catch_unwind)]
    pub fn port(&self) -> f64 {
        f64::from(self.port)
    }

    /// Serves `identity` for `name` from the next handshake on, replacing any
    /// trusted certificate served before.
    #[napi(catch_unwind)]
    pub fn set_trusted(&self, name: String, cert: Buffer, key: Buffer) -> napi::Result<()> {
        let identity = TlsIdentity::from_pem(cert.as_ref(), key.as_ref()).map_err(reason)?;
        let listener = locked(&self.listener);
        let Some(listener) = listener.as_ref() else {
            return Err(napi::Error::from_reason("the listener is closed"));
        };
        listener.resolver().set_trusted(&name, identity);
        Ok(())
    }

    /// Serves the pinned certificate again from the next handshake on.
    #[napi(catch_unwind)]
    pub fn clear_trusted(&self) {
        if let Some(listener) = locked(&self.listener).as_ref() {
            listener.resolver().clear_trusted();
        }
    }

    /// What this listener handled since it bound (T1b.5's evidence).
    #[napi(catch_unwind)]
    pub fn handled(&self) -> HandledJs {
        self.inner
            .stats
            .get()
            .map(|stats| HandledJs::from(stats.counts()))
            .unwrap_or_else(|| HandledJs::from(Counts::default()))
    }

    /// Stops accepting, abandons what is still deciding at the deadline, and
    /// resolves once every socket that opened has reported `close`.
    #[napi(catch_unwind)]
    pub fn close(&self, env: Env, deadline_ms: f64) -> napi::Result<Object<'static>> {
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
}

/// A number that names a port, `0..=65535`; `0` only where the caller may pick one.
fn addr(value: f64, name: &str, any_port: bool) -> napi::Result<SocketAddr> {
    let lowest = if any_port { 0.0 } else { 1.0 };
    if !value.is_finite() || value.fract() != 0.0 || value < lowest || value > 65535.0 {
        return Err(napi::Error::from_reason(format!("Invalid {name}")));
    }
    Ok(SocketAddr::from(([127, 0, 0, 1], value as u16)))
}

/// The bind address: an IP literal as given, or the host resolved once, as
/// node's `listen` does.
async fn resolve(host: &str, port: f64) -> napi::Result<SocketAddr> {
    if !port.is_finite() || port.fract() != 0.0 || !(0.0..=65535.0).contains(&port) {
        return Err(napi::Error::from_reason("Invalid port"));
    }
    let port = port as u16;
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, port));
    }
    tokio::net::lookup_host((host, port))
        .await
        .map_err(|error| napi::Error::from_reason(format!("Invalid host: {error}")))?
        .next()
        .ok_or_else(|| napi::Error::from_reason("Invalid host"))
}

/// The listener's timers. A remote connection has no request timeout and no HTTP
/// write bound (T1b.1a); only a `101` or a refusal is bounded.
fn connection_limits(limits: RemoteLimitsJs) -> ConnectionLimits {
    ConnectionLimits {
        handshake: Some(millis(limits.handshake_ms)),
        first_head: millis(limits.first_head_ms),
        head: limits.head_ms.map(millis),
        keep_alive: millis(limits.keep_alive_ms),
        trusted_keep_alive: limits.trusted_keep_alive_ms.map(millis),
        exchange: None,
        upgrade_write: WRITE_TIMEOUT,
    }
}

fn millis(value: f64) -> Duration {
    Duration::from_millis(if value.is_finite() && value > 0.0 {
        value as u64
    } else {
        0
    })
}

/// An error the binding throws as it is: the provider's, an identity's, or the transport's.
fn reason(error: impl std::fmt::Display) -> napi::Error {
    napi::Error::from_reason(error.to_string())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::RemoteLimitsJs;
    use super::connection_limits;

    /// The static listener's numbers are the ones the shell passes
    /// (`ConnectionLimits::remote_static()`, T1b.1a's table).
    #[test]
    fn the_static_limits_arrive_as_the_remote_static_values() {
        let limits = connection_limits(RemoteLimitsJs {
            handshake_ms: 120_000.0,
            first_head_ms: 10_000.0,
            head_ms: Some(10_000.0),
            keep_alive_ms: 5_000.0,
            trusted_keep_alive_ms: None,
        });
        assert_eq!(limits.handshake, Some(Duration::from_secs(120)));
        assert_eq!(limits.first_head, Duration::from_millis(10_000));
        assert_eq!(limits.head, Some(Duration::from_millis(10_000)));
        assert_eq!(limits.keep_alive, Duration::from_secs(5));
        assert_eq!(limits.trusted_keep_alive, None);
        assert_eq!(limits.exchange, None);
        assert_eq!(limits.upgrade_write, Duration::from_secs(5));
    }
}
