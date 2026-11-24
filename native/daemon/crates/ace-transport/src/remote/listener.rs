// SPDX-License-Identifier: Apache-2.0
//! One Rust type for both remote listeners (T1b.1a, decision 8): a TCP listener
//! that terminates TLS with a [`SniResolver`], then serves each decrypted
//! connection through the shared driver. The static listener has no trusted
//! keep-alive and serves one identity; the run-time listener's resolver can
//! serve Tailscale's certificate for its `ts.net` name.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use rustls::crypto::CryptoProvider;
use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;

use crate::accept::{Accepting, Acceptor, Admitted, DEFAULT_MAX_TCP_CONNECTIONS};
use crate::conn_io::ConnIo;
use crate::driver::UpgradeHandler;
use crate::error::TransportError;
use crate::limits::ConnectionLimits;
use crate::peer::Peer;
use crate::proxy::{ProxyTarget, is_localhost};
use crate::tls::config::server_config;
use crate::tls::handshake;
use crate::tls::identity::TlsIdentity;
use crate::tls::resolver::SniResolver;

/// A bound remote listener: TLS in front, the connection driver behind.
pub struct RemoteListener {
    accepting: Accepting,
    resolver: Arc<SniResolver>,
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
        if !is_localhost(target.addr) {
            return Err(TransportError::NotLoopback { addr: target.addr });
        }
        let resolver = Arc::new(SniResolver::new(identity));
        let config = server_config(provider, Arc::clone(&resolver))?;
        let acceptor = Tls {
            acceptor: TlsAcceptor::from(Arc::new(config)),
            handshake: limits.handshake,
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
        )
        .await?;
        Ok(Self {
            accepting,
            resolver,
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
    acceptor: TlsAcceptor,
    handshake: Option<Duration>,
}

impl Acceptor for Tls {
    fn admit(&self, stream: TcpStream, _peer: Peer) -> Admitted {
        let acceptor = self.acceptor.clone();
        let handshake_limit = self.handshake;
        Box::pin(async move {
            let accepted = handshake::accept(&acceptor, stream, handshake_limit).await?;
            // The negotiated name reaches the hop in T1b.2; a connection keeps
            // the certificate it shook hands with.
            Some(Box::new(accepted.stream) as Box<dyn ConnIo>)
        })
    }
}
