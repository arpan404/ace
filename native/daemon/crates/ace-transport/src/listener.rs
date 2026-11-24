// SPDX-License-Identifier: Apache-2.0
//! The loopback listener (behaviour.md §2): bound to 127.0.0.1 only, one task per
//! accepted connection behind a cap, and a close that stops accepting, closes
//! idle connections at once, and lets in-flight work finish until its deadline
//! before dropping the rest. The loop itself is shared with the remote listeners
//! (`accept.rs`, T1b.1a); this file only says what a loopback connection is.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpStream;

use crate::accept::{Accepting, Acceptor, Admitted, DEFAULT_MAX_TCP_CONNECTIONS};
use crate::conn_io::ConnIo;
use crate::driver::UpgradeHandler;
use crate::error::TransportError;
use crate::limits::ConnectionLimits;
use crate::peer::Peer;
use crate::proxy::{ProxyTarget, is_localhost};
use crate::stats::Stats;

/// The daemon's loopback listener.
pub struct LoopbackListener(Accepting);

impl LoopbackListener {
    /// Listen on `addr` (127.0.0.1 only, port 0 picks a free port) and forward
    /// ordinary HTTP to `target`, handing every upgrade candidate to `upgrades`.
    /// At most [`DEFAULT_MAX_TCP_CONNECTIONS`] TCP connections are held at once.
    pub async fn bind(
        addr: SocketAddr,
        target: ProxyTarget,
        upgrades: Arc<dyn UpgradeHandler>,
    ) -> Result<Self, TransportError> {
        Self::bind_with(addr, target, upgrades, DEFAULT_MAX_TCP_CONNECTIONS).await
    }

    /// The same, with the TCP connection cap chosen by the caller. It guards
    /// file descriptors, not the WebSocket cap: a connection over it is accepted
    /// and closed at once, so a local slowloris cannot hold descriptors while
    /// its first head is still owed.
    pub async fn bind_with(
        addr: SocketAddr,
        target: ProxyTarget,
        upgrades: Arc<dyn UpgradeHandler>,
        max_tcp_connections: usize,
    ) -> Result<Self, TransportError> {
        if !is_localhost(addr) {
            return Err(TransportError::NotLoopback { addr });
        }
        if !is_localhost(target.addr) {
            return Err(TransportError::NotLoopback { addr: target.addr });
        }
        let limits = ConnectionLimits::loopback();
        let accepting = Accepting::start(
            addr,
            Loopback,
            target,
            upgrades,
            limits.clone(),
            // T1a bounds every write on a loopback connection, hyper's HTTP
            // writes included.
            Some(limits.upgrade_write),
            max_tcp_connections,
            Stats::new(),
            // Node's loopback server reports no accept failures today.
            None,
        )
        .await?;
        Ok(Self(accepting))
    }

    /// The address the listener actually bound, with the port when `addr` asked
    /// for 0.
    pub fn local_addr(&self) -> SocketAddr {
        self.0.local_addr()
    }

    /// The counters this listener has kept since it bound (T1b.1b).
    pub fn stats(&self) -> Arc<Stats> {
        self.0.stats()
    }

    /// Stop accepting, tell every connection and upgrade handler the listener is
    /// closing, and let what is in flight finish until `deadline`. At the
    /// deadline the accept loop cancels every connection whose upgrade has not
    /// reached `Writing`; a connection writing its `101` is waited for, bounded
    /// only by the stream's write timeout (T1a.2's `TimedIo`), so a deadline
    /// never splits a `101` from the socket it registers.
    ///
    /// The loop settles every connection it cancels: an upgrade still deciding is
    /// abandoned, and one that was accepted releases its reservation.
    pub async fn close(self, deadline: Duration) {
        self.0.close(deadline).await;
    }
}

/// A loopback connection is the accepted socket itself, and only 127.0.0.1 is
/// served, never the rest of loopback.
#[derive(Clone, Copy)]
struct Loopback;

impl Acceptor for Loopback {
    fn serves(&self, peer: &Peer) -> bool {
        is_localhost(peer.remote)
    }

    fn admit(&self, stream: TcpStream, _peer: Peer) -> Admitted {
        Box::pin(async move { Some(Box::new(stream) as Box<dyn ConnIo>) })
    }
}
