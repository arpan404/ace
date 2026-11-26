// SPDX-License-Identifier: Apache-2.0
//! The daemon's listeners, served in this process through `ace-transport`.
//!
//! The loopback listener (T1a) accepts HTTP/1.1 and WebSocket on
//! `127.0.0.1:<ACE_PORT>`, proxies ordinary HTTP to the in-process server on a
//! private loopback port, and hands every upgrade to this module's admission.
//! The LAN listener (T1b) does the same behind TLS when `ACE_LISTEN=lan` and the
//! home holds the `tls/cert.pem` and `tls/key.pem` its paired devices pinned;
//! without them it does not start, and the daemon keeps listening on loopback, as
//! TypeScript's `remoteStarted.direct` settles on a failed remote listener and
//! never stops the daemon.
//!
//! TypeScript cases ported: `apps/daemon/src/socket-upgrade.ts`'s
//! `upgradeDecision` ("only `/`", the Origin rule, the 256-socket cap and the
//! pre-authentication budgets), guarded by
//! `apps/daemon/src/admission.server.process.test.ts` ("an upgrade on another path
//! is dropped without an answer", "an upgrade from a refused Origin is 403", "an
//! upgrade with no Origin is admitted on loopback", "an unauthenticated socket
//! over the budget is 503", "a socket over the connection cap is closed with
//! 4013").

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use ace_transport::upgrade::{
    AdmissionDecision, AdmissionOutcome, SocketSink, UpgradeAdmission, UpgradeRequest,
    WebSocketUpgrades,
};
use ace_transport::{
    ConnectionLimits, Deflate, HopSecret, LoopbackListener, ProxyTarget, RemoteListener,
    TlsIdentity, UpgradeHandler, UpgradeIo, process_provider,
};

use crate::config::Listen;
use crate::http::{HttpConfig, HttpServer};
use crate::log::Log;
use crate::session;

mod live;

use live::{Kind, Live};

/// Admission for one listener.
struct Admission {
    live: Arc<Live>,
    kind: Kind,
    allowed_origins: Vec<String>,
}

impl UpgradeAdmission for Admission {
    fn admit(
        &self,
        request: UpgradeRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = AdmissionOutcome> + Send>> {
        let decision = if request.target != "/" {
            AdmissionDecision::Drop
        } else if self.kind == Kind::Local
            && request
                .origin
                .as_ref()
                .is_some_and(|origin| !self.allowed_origins.iter().any(|allowed| allowed == origin))
        {
            AdmissionDecision::Forbidden
        } else {
            match self.live.reserve(self.kind, request.peer.remote.ip()) {
                Some(reservation) => AdmissionDecision::Accept { reservation },
                None => AdmissionDecision::Unavailable,
            }
        };
        Box::pin(async move { AdmissionOutcome::Decided(decision) })
    }

    fn writing(&self, reservation: u64) -> bool {
        self.live.is_held(reservation)
    }

    fn release(&self, reservation: u64) {
        self.live.release(reservation);
    }
}

/// Who receives a socket whose `101` reached the wire.
struct Sink {
    live: Arc<Live>,
    auth: Arc<dyn session::Authenticator>,
    /// Startup's gate: a hello before it opens is told services are starting.
    ready: Arc<std::sync::atomic::AtomicBool>,
    /// The loopback listener admits the host token; remote listeners never do.
    local: bool,
}

impl SocketSink for Sink {
    fn opened(
        &self,
        reservation: u64,
        stream: Box<dyn UpgradeIo>,
        _user_agent: Option<String>,
        deflate: Option<Deflate>,
    ) {
        let live = Arc::clone(&self.live);
        let closed = Arc::clone(&live);
        let signed_in = Arc::clone(&live);
        let handle = session::start(
            stream,
            deflate,
            Arc::clone(&self.auth),
            self.local,
            Arc::clone(&self.ready),
            Arc::new(move || signed_in.authenticated(reservation)),
            Arc::new(move || closed.closed(reservation)),
        );
        live.opened(reservation, handle);
    }
}

/// Why a listener did not bind.
#[derive(Debug)]
pub enum TransportError {
    Loopback(ace_transport::TransportError),
    Http(std::io::Error),
    Identity(String),
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Loopback(error) => write!(formatter, "loopback listener: {error}"),
            Self::Http(error) => write!(formatter, "in-process HTTP server: {error}"),
            Self::Identity(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for TransportError {}

/// A remote listener to start, decided by `wiring::remote_plan`.
pub struct RemotePlan {
    pub listen: Listen,
    /// The home whose `tls/` holds the pinned identity.
    pub home: std::path::PathBuf,
    pub identity: crate::identity::Identity,
    /// The host clients use, which is not always the address the listener binds.
    pub advertised: String,
    pub port: u16,
    /// Tailscale only: the MagicDNS name whose certificate is fetched.
    pub tailnet: Option<String>,
}

/// What a started remote listener publishes to the launcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteInfo {
    /// `wss://<host>:<port>`.
    pub url: String,
    /// The pinned certificate's public-key SHA-256.
    pub fingerprint: String,
}

/// Everything this process bound, and the only way to close it in order.
pub struct Transport {
    pub port: u16,
    pub remote: Option<RemoteInfo>,
    live: Arc<Live>,
    loopback: Option<LoopbackListener>,
    remote_listener: Option<RemoteListener>,
    tailscale_task: Option<tokio::task::JoinHandle<()>>,
    http: Option<HttpServer>,
    log: Arc<Log>,
}

impl Transport {
    /// Bind the in-process HTTP server, the loopback listener and, when planned,
    /// the LAN or Tailscale listener.
    pub async fn bind(
        config: HttpConfig,
        port: u16,
        plan: Option<RemotePlan>,
        authenticator: Arc<dyn session::Authenticator>,
        ready: Arc<std::sync::atomic::AtomicBool>,
        log: Arc<Log>,
    ) -> Result<Self, TransportError> {
        let secret = Arc::new(HopSecret::generate().map_err(TransportError::Loopback)?);
        let secret_hex = secret.hex();
        let allowed_origins = config.allowed_origins.clone();
        let http = HttpServer::bind(config, secret_hex)
            .await
            .map_err(TransportError::Http)?;
        let target = ProxyTarget::new(http.addr, secret).map_err(TransportError::Loopback)?;
        let live = Arc::new(Live::new());
        let admission: Arc<dyn UpgradeAdmission> = Arc::new(Admission {
            live: Arc::clone(&live),
            kind: Kind::Local,
            allowed_origins,
        });
        let upgrades = Arc::new(WebSocketUpgrades::new(
            admission,
            Arc::new(Sink {
                live: Arc::clone(&live),
                auth: Arc::clone(&authenticator),
                ready: Arc::clone(&ready),
                local: true,
            }),
        ));
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let loopback = LoopbackListener::bind(addr, target, upgrades)
            .await
            .map_err(TransportError::Loopback)?;
        let bound = loopback.local_addr();
        let mut remote = None;
        let mut remote_listener = None;
        let mut tailscale_task = None;
        if let Some(plan) = plan {
            match bind_remote(&live, http.addr, &plan, authenticator, ready).await {
                Ok((listener, tailnet)) => {
                    if let Some((resolver, name)) = tailnet {
                        tailscale_task = Some(crate::tailscale::spawn_refresh(
                            resolver,
                            name,
                            std::path::PathBuf::from(&plan.home),
                            Arc::clone(&log),
                        ));
                    }
                    let url = format!(
                        "wss://{}:{}",
                        url_host(&plan.advertised),
                        listener.local_addr().port()
                    );
                    log.log(
                        "info",
                        "Remote listener started",
                        serde_json::json!({"url": url}),
                    );
                    remote = Some(RemoteInfo {
                        url,
                        fingerprint: plan.identity.fingerprint.clone(),
                    });
                    remote_listener = Some(listener);
                }
                Err(error) => {
                    log.log(
                        "warn",
                        "Remote listener did not start",
                        serde_json::json!({"error": error.to_string()}),
                    );
                }
            }
        }
        Ok(Self {
            port: bound.port(),
            remote,
            live,
            loopback: Some(loopback),
            remote_listener,
            tailscale_task,
            http: Some(http),
            log,
        })
    }

    /// The daemon's own URL, as the endpoint file and `ace start` print it.
    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}", self.port)
    }

    /// The HTTP URL paired clients and the CLI use.
    pub fn http_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Stop accepting, close every socket, and then stop the in-process server.
    /// `deadline` bounds the sockets' goodbyes.
    pub async fn close(mut self, deadline: Duration) {
        if let Some(task) = self.tailscale_task.take() {
            task.abort();
        }
        if let Some(listener) = self.loopback.take() {
            listener.close(deadline).await;
        }
        if let Some(listener) = self.remote_listener.take() {
            listener.close(deadline).await;
        }
        self.live.shutdown(Duration::from_secs(1)).await;
        if let Some(http) = self.http.take() {
            http.stop();
        }
        self.log
            .log("info", "Listeners closed", serde_json::json!({}));
    }
}

/// The LAN or Tailscale listener: TLS with the home's pinned identity, deflate
/// negotiated. Tailscale also gets the resolver whose certificate is refreshed.
async fn bind_remote(
    live: &Arc<Live>,
    internal: SocketAddr,
    plan: &RemotePlan,
    authenticator: Arc<dyn session::Authenticator>,
    ready: Arc<std::sync::atomic::AtomicBool>,
) -> Result<
    (
        RemoteListener,
        Option<(Arc<ace_transport::SniResolver>, String)>,
    ),
    TransportError,
> {
    let provider = process_provider().map_err(TransportError::Loopback)?;
    let tls = TlsIdentity::from_pem(&plan.identity.cert_pem, &plan.identity.key_pem)
        .map_err(|error| TransportError::Identity(error.to_string()))?;
    let secret = Arc::new(HopSecret::generate().map_err(TransportError::Loopback)?);
    let target = ProxyTarget::new(internal, secret).map_err(TransportError::Loopback)?;
    let admission: Arc<dyn UpgradeAdmission> = Arc::new(Admission {
        live: Arc::clone(live),
        kind: Kind::Remote,
        allowed_origins: Vec::new(),
    });
    let upgrades: Arc<dyn UpgradeHandler> = Arc::new(WebSocketUpgrades::with_deflate(
        admission,
        Arc::new(Sink {
            live: Arc::clone(live),
            auth: authenticator,
            ready,
            local: false,
        }),
    ));
    let (addr, limits) = match plan.listen {
        Listen::Tailscale => {
            let address: std::net::IpAddr = plan
                .advertised
                .parse()
                .map_err(|_| TransportError::Identity("not a Tailscale address".to_owned()))?;
            (
                SocketAddr::new(address, plan.port),
                ConnectionLimits::remote_sni(ace_transport::SniLimits::default()),
            )
        }
        _ => (
            SocketAddr::from(([0, 0, 0, 0], plan.port)),
            ConnectionLimits::remote_static(),
        ),
    };
    let listener = RemoteListener::bind(addr, provider, tls, limits, target, upgrades)
        .await
        .map_err(TransportError::Loopback)?;
    let tailnet = plan
        .tailnet
        .as_ref()
        .map(|name| (listener.resolver_handle(), name.clone()));
    Ok((listener, tailnet))
}

/// A URL host: an IPv6 literal is bracketed, as `urlHost` does.
pub fn url_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}
