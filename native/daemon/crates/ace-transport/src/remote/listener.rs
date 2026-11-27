// SPDX-License-Identifier: Apache-2.0
//! One Rust type for both remote listeners (T1b.1a, decision 8): a TCP listener
//! that terminates TLS with a [`SniResolver`], then serves each decrypted
//! connection through the shared driver. The static listener has no trusted
//! keep-alive and serves one identity; the run-time listener's resolver can
//! serve Tailscale's certificate for its `ts.net` name.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use rustls::NamedGroup;
use rustls::crypto::CryptoProvider;
use tokio::net::TcpStream;

use crate::accept::{Accepting, Acceptor, Admitted, DEFAULT_MAX_TCP_CONNECTIONS, ErrorSink};
use crate::conn_io::ConnIo;
use crate::conn_state::Accepted;
use crate::driver::UpgradeHandler;
use crate::error::TransportError;
use crate::limits::ConnectionLimits;
use crate::peer::Peer;
use crate::proxy::{ProxyTarget, is_localhost};
use crate::stats::Stats;
use crate::tls::config::{server_config, server_config_preferring_hybrid};
use crate::tls::handshake::{self, Configs};
use crate::tls::identity::TlsIdentity;
use crate::tls::resolver::SniResolver;

/// A bound remote listener: TLS in front, the connection driver behind.
pub struct RemoteListener {
    accepting: Accepting,
    resolver: Arc<SniResolver>,
    stats: Arc<Stats>,
}

impl RemoteListener {
    /// Listen on `addr` (`0.0.0.0` for the LAN, the 100.x address on Tailscale,
    /// port 0 picks a free port), terminate TLS with `identity`, and forward
    /// ordinary HTTP to `target` (127.0.0.1 only), handing every upgrade
    /// candidate to `upgrades`.
    pub async fn bind(
        addr: SocketAddr,
        provider: Arc<CryptoProvider>,
        identity: TlsIdentity,
        limits: ConnectionLimits,
        target: ProxyTarget,
        upgrades: Arc<dyn UpgradeHandler>,
    ) -> Result<Self, TransportError> {
        Self::bind_reporting(addr, provider, identity, limits, target, upgrades, None).await
    }

    /// The same bind, with every accept failure after it reaches `errors`
    /// (T1b.1b): the binding reports them, throttled per OS error code.
    #[allow(clippy::too_many_arguments)]
    pub async fn bind_reporting(
        addr: SocketAddr,
        provider: Arc<CryptoProvider>,
        identity: TlsIdentity,
        limits: ConnectionLimits,
        target: ProxyTarget,
        upgrades: Arc<dyn UpgradeHandler>,
        errors: Option<ErrorSink>,
    ) -> Result<Self, TransportError> {
        if !is_localhost(target.addr) {
            return Err(TransportError::NotLoopback { addr: target.addr });
        }
        let stats = Stats::new();
        let resolver = Arc::new(SniResolver::with_stats(identity, Arc::clone(&stats)));
        // Both configurations are built once per identity: a hybrid-capable
        // client gets the hybrid-only one, everyone else the normal one.
        let preferring =
            server_config_preferring_hybrid(Arc::clone(&provider), Arc::clone(&resolver))?;
        let normal = server_config(provider, Arc::clone(&resolver))?;
        let acceptor = Tls {
            configs: Arc::new(Configs::new(Arc::new(preferring), Arc::new(normal))),
            handshake: limits.handshake,
            stats: Arc::clone(&stats),
        };
        let accepting = Accepting::start(
            addr,
            acceptor,
            target,
            upgrades,
            limits,
            // Node bounds no HTTP write on a remote connection, and a slow
            // peer may stall far longer than the loopback write timeout.
            None,
            DEFAULT_MAX_TCP_CONNECTIONS,
            Arc::clone(&stats),
            errors,
        )
        .await?;
        Ok(Self {
            accepting,
            resolver,
            stats,
        })
    }

    /// The address the listener actually bound, with the port when `addr` asked
    /// for 0.
    pub fn local_addr(&self) -> SocketAddr {
        self.accepting.local_addr()
    }

    /// The certificate chooser, so TypeScript's trusted certificate can be
    /// pushed and cleared at run time.
    pub fn resolver(&self) -> &SniResolver {
        &self.resolver
    }

    /// The same chooser as a handle a later task can push to: the daemon program
    /// fetches Tailscale's certificate in the background, without holding the
    /// listener.
    pub fn resolver_handle(&self) -> Arc<SniResolver> {
        Arc::clone(&self.resolver)
    }

    /// The counters this listener has kept since it bound (T1b.1b).
    pub fn stats(&self) -> Arc<Stats> {
        Arc::clone(&self.stats)
    }

    /// Stop accepting, drop every connection that is handshaking, idle or
    /// carrying an HTTP exchange (at once when `deadline` is zero), and let an
    /// upgrade that is writing its `101` finish.
    pub async fn close(self, deadline: Duration) {
        self.accepting.close(deadline).await
    }
}

/// A remote connection ends TLS before the driver sees it.
#[derive(Clone)]
struct Tls {
    configs: Arc<Configs>,
    handshake: Option<Duration>,
    stats: Arc<Stats>,
}

impl Acceptor for Tls {
    fn admit(&self, stream: TcpStream, _peer: Peer) -> Admitted {
        let configs = Arc::clone(&self.configs);
        let handshake_limit = self.handshake;
        let stats = Arc::clone(&self.stats);
        Box::pin(async move {
            let accepted = handshake::accept(&configs, stream, handshake_limit).await?;
            // A hybrid handshake is the post-quantum one (T1b.1b's evidence).
            if accepted
                .stream
                .get_ref()
                .1
                .negotiated_key_exchange_group()
                .is_some_and(|group| group.name() == NamedGroup::X25519MLKEM768)
            {
                stats.post_quantum_handshake();
            }
            // The negotiated name reaches the hop in T1b.2; a connection keeps
            // the certificate it shook hands with.
            Some(Accepted::new(
                Box::new(accepted.stream) as Box<dyn ConnIo>,
                accepted.servername,
            ))
        })
    }
}
