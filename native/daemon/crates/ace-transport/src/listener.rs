// SPDX-License-Identifier: Apache-2.0
//! The loopback listener (behaviour.md §2): bound to 127.0.0.1 only, one task per
//! accepted connection behind a cap, and a close that stops accepting, closes
//! idle connections at once, and lets in-flight work finish until its deadline
//! before dropping the rest.

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use crate::driver::{self, UpgradeHandler};
use crate::error::TransportError;
use crate::peer::Peer;
use crate::proxy::{ProxyTarget, is_localhost};

/// How long an accept that failed waits before trying again, so a transient
/// failure (file descriptors exhausted) never spins the loop.
const ACCEPT_RETRY: Duration = Duration::from_millis(10);

/// The TCP connection cap when the caller has no reason to choose another.
///
/// This guards the daemon's file descriptors against a local slowloris holding
/// connections whose first head never arrives. It is **not** the WebSocket cap:
/// that is the TypeScript server's 256 sockets (`apps/daemon/src/server.ts:289`,
/// `:393`) and T1a.7's admission decides it.
pub const DEFAULT_MAX_TCP_CONNECTIONS: usize = 1024;

/// The daemon's loopback listener.
pub struct LoopbackListener {
    local: SocketAddr,
    shutdown: CancellationToken,
    accept: JoinHandle<()>,
}

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
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|source| TransportError::Bind { addr, source })?;
        let local = listener
            .local_addr()
            .map_err(|source| TransportError::Bind { addr, source })?;
        let shutdown = CancellationToken::new();
        let accept = tokio::spawn(accept_connections(
            listener,
            target,
            upgrades,
            shutdown.clone(),
            Arc::new(Semaphore::new(max_tcp_connections)),
        ));
        Ok(Self {
            local,
            shutdown,
            accept,
        })
    }

    /// The address the listener actually bound, with the port when `addr` asked
    /// for 0.
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// Stop accepting, tell every connection and upgrade handler the listener is
    /// closing, and let what is in flight finish until `deadline`; then drop the
    /// rest.
    ///
    /// T1a.2 has no upgrade state machine, so a connection is simply dropped at
    /// the deadline. T1a.5 keeps a connection whose upgrade is in `Writing`.
    pub async fn close(mut self, deadline: Duration) {
        self.shutdown.cancel();
        if tokio::time::timeout(deadline, &mut self.accept)
            .await
            .is_err()
        {
            // Dropping the accept task drops its set of connection tasks, which
            // closes their streams.
            self.accept.abort();
        }
    }
}

async fn accept_connections(
    listener: TcpListener,
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    shutdown: CancellationToken,
    permits: Arc<Semaphore>,
) {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let peer = match Peer::of(&stream) {
                        Ok(peer) if is_localhost(peer.remote) => peer,
                        // Only 127.0.0.1 is served, never the rest of loopback.
                        Ok(_) | Err(_) => continue,
                    };
                    let permit = match Arc::clone(&permits).try_acquire_owned() {
                        Ok(permit) => permit,
                        Err(_) => {
                            // Over the cap: accepted and closed at once.
                            drop(stream);
                            continue;
                        }
                    };
                    let connection_target = target.clone();
                    let connection_upgrades = Arc::clone(&upgrades);
                    let connection_shutdown = shutdown.clone();
                    connections.spawn(async move {
                        // Held for the connection's whole life; released with it.
                        let _permit = permit;
                        driver::serve(
                            stream,
                            peer,
                            connection_target,
                            connection_upgrades,
                            connection_shutdown,
                        )
                        .await;
                    });
                }
                Err(_) => tokio::time::sleep(ACCEPT_RETRY).await,
            },
            joined = connections.join_next(), if !connections.is_empty() => {
                drop(joined);
            }
        }
    }
    // Stop accepting before waiting for what is in flight.
    drop(listener);
    while connections.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests;
