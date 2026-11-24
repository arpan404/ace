// SPDX-License-Identifier: Apache-2.0
//! The loopback listener (behaviour.md §2): bound to 127.0.0.1 only, one task per
//! accepted connection behind a cap, and a close that stops accepting, closes
//! idle connections at once, and lets in-flight work finish until its deadline
//! before dropping the rest.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::TcpListener;
use tokio::sync::{Semaphore, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use crate::driver::{self, Grace, UpgradeHandler};
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
    /// The close deadline, handed to the accept loop as it starts draining.
    deadline: oneshot::Sender<Duration>,
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
        let (deadline, closing_deadline) = oneshot::channel();
        let accept = tokio::spawn(accept_connections(
            listener,
            target,
            upgrades,
            shutdown.clone(),
            Arc::new(Semaphore::new(max_tcp_connections)),
            closing_deadline,
        ));
        Ok(Self {
            local,
            shutdown,
            deadline,
            accept,
        })
    }

    /// The address the listener actually bound, with the port when `addr` asked
    /// for 0.
    pub fn local_addr(&self) -> SocketAddr {
        self.local
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
    pub async fn close(mut self, deadline: Duration) {
        // The deadline reaches the accept loop before the stop does, so it
        // always has the window to drain with.
        let _ = self.deadline.send(deadline);
        self.shutdown.cancel();
        let _ = (&mut self.accept).await;
    }
}

/// One connection's close-deadline state: the token that cancels it, and the
/// guard its upgrade arms when it starts writing its `101`.
#[derive(Clone)]
struct Connection {
    cancel: CancellationToken,
    grace: Grace,
}

fn locked<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

async fn accept_connections(
    listener: TcpListener,
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    shutdown: CancellationToken,
    permits: Arc<Semaphore>,
    closing_deadline: oneshot::Receiver<Duration>,
) {
    let connections = Arc::new(Mutex::new(HashMap::<u64, Connection>::new()));
    let mut tasks = JoinSet::new();
    let mut next = 0u64;
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
                    let cancel = CancellationToken::new();
                    let grace = Grace::new();
                    let id = next;
                    next += 1;
                    locked(&connections).insert(
                        id,
                        Connection {
                            cancel: cancel.clone(),
                            grace: grace.clone(),
                        },
                    );
                    let registry = Arc::clone(&connections);
                    tasks.spawn(async move {
                        // Held for the connection's whole life; released with it.
                        let _permit = permit;
                        tokio::select! {
                            biased;
                            // The close deadline reached a connection that was
                            // not writing: its stream is dropped here.
                            _ = cancel.cancelled() => {}
                            () = driver::serve(
                                stream,
                                peer,
                                connection_target,
                                connection_upgrades,
                                connection_shutdown,
                                grace,
                            ) => {}
                        }
                        locked(&registry).remove(&id);
                    });
                }
                Err(_) => tokio::time::sleep(ACCEPT_RETRY).await,
            },
            joined = tasks.join_next(), if !tasks.is_empty() => {
                drop(joined);
            }
        }
    }
    // Stop accepting before waiting for what is in flight.
    drop(listener);
    let deadline = closing_deadline.await.unwrap_or(Duration::ZERO);
    deadline_drain(&mut tasks, &connections, deadline).await;
}

/// Waits for the connection set until `deadline`; then cancels every connection
/// whose upgrade has not armed its grace, and waits for the rest. An armed
/// connection is writing its `101`, whose only bound is the stream's write
/// timeout.
async fn deadline_drain(
    tasks: &mut JoinSet<()>,
    connections: &Mutex<HashMap<u64, Connection>>,
    deadline: Duration,
) {
    if tokio::time::timeout(deadline, async {
        while tasks.join_next().await.is_some() {}
    })
    .await
    .is_ok()
    {
        return;
    }
    let open: Vec<Connection> = locked(connections).values().cloned().collect();
    for connection in open {
        connection.grace.cancel(&connection.cancel);
    }
    while tasks.join_next().await.is_some() {}
}

#[cfg(test)]
mod tests;
