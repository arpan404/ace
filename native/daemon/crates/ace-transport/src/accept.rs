// SPDX-License-Identifier: Apache-2.0
//! Both listeners' accepting side (T1b.1a): one loop that accepts TCP
//! connections behind a cap, hands each to its listener's acceptor (a boxed
//! loopback stream, or a TLS handshake), and runs the connection driver in its
//! own task; and one close that stops accepting, drains until its deadline, and
//! cancels every connection whose upgrade has not reached `Writing`.

use std::collections::HashMap;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Semaphore, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use crate::conn_state::Accepted;
use crate::driver::{self, Grace, UpgradeHandler};
use crate::error::TransportError;
use crate::limits::ConnectionLimits;
use crate::peer::Peer;
use crate::proxy::ProxyTarget;
use crate::stats::Stats;

/// How long an accept that failed waits before trying again, so a transient
/// failure (file descriptors exhausted) never spins the loop.
const ACCEPT_RETRY: Duration = Duration::from_millis(10);

/// Where a listener's accept failures go after it bound (T1b.1b): the binding
/// throttles them per OS error code. The loopback listener names no sink, as
/// Node's loopback server has no such report today.
pub type ErrorSink = Arc<dyn Fn(&std::io::Error) + Send + Sync>;

/// The TCP connection cap when the caller has no reason to choose another.
///
/// This guards the daemon's file descriptors against a slowloris holding
/// connections whose first head never arrives. It is **not** the WebSocket cap:
/// that is the TypeScript server's 256 sockets (`apps/daemon/src/server.ts:289`,
/// `:393`) and T1a.7's admission decides it.
pub const DEFAULT_MAX_TCP_CONNECTIONS: usize = 1024;

/// What an acceptor produces for one connection: the stream the driver serves
/// and what its handshake learned, or None when the connection must close
/// without a byte.
pub type Admitted = Pin<Box<dyn Future<Output = Option<Accepted>> + Send>>;

/// How one listener turns an accepted TCP connection into the stream the driver
/// serves, or refuses it: loopback boxes the TCP stream, a remote listener ends
/// TLS.
pub trait Acceptor: Clone + Send + 'static {
    /// Whether this listener serves the peer at all: only 127.0.0.1 on
    /// loopback, every address on a remote listener.
    fn serves(&self, _peer: &Peer) -> bool {
        true
    }

    /// The connection's bytes, or None when it must be closed without a byte (a
    /// failed or timed-out handshake).
    fn admit(&self, stream: TcpStream, peer: Peer) -> Admitted;
}

/// A bound listener's accepting loop, shared by `LoopbackListener` and
/// `RemoteListener`.
pub(crate) struct Accepting {
    local: SocketAddr,
    shutdown: CancellationToken,
    /// The close deadline, handed to the accept loop as it starts draining.
    deadline: oneshot::Sender<Duration>,
    accept: JoinHandle<()>,
    stats: Arc<Stats>,
}

impl Accepting {
    /// Bind `addr` and serve it with `acceptor`, proxying ordinary HTTP to
    /// `target` and handing every upgrade candidate to `upgrades`. At most
    /// `max_tcp_connections` TCP connections are held at once. `http_write`
    /// bounds the writes of an HTTP exchange; None leaves them unbounded, as
    /// Node does on a remote connection. `errors` receives every accept the OS
    /// refused after the bind.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn start<A: Acceptor>(
        addr: SocketAddr,
        acceptor: A,
        target: ProxyTarget,
        upgrades: Arc<dyn UpgradeHandler>,
        limits: ConnectionLimits,
        http_write: Option<Duration>,
        max_tcp_connections: usize,
        stats: Arc<Stats>,
        errors: Option<ErrorSink>,
    ) -> Result<Self, TransportError> {
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
            acceptor,
            target,
            upgrades,
            shutdown.clone(),
            Arc::new(Semaphore::new(max_tcp_connections)),
            closing_deadline,
            limits,
            http_write,
            Arc::clone(&stats),
            errors,
        ));
        Ok(Self {
            local,
            shutdown,
            deadline,
            accept,
            stats,
        })
    }

    /// The address the listener actually bound, with the port when `addr` asked
    /// for 0.
    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// The counters this listener has kept since it bound (T1b.1b).
    pub fn stats(&self) -> Arc<Stats> {
        Arc::clone(&self.stats)
    }

    /// Stop accepting, tell every connection and upgrade handler the listener is
    /// closing, and let what is in flight finish until `deadline`. At the
    /// deadline the accept loop cancels every connection whose upgrade has not
    /// reached `Writing`; a connection writing its `101` is waited for, bounded
    /// only by the stream's write timeout, so a deadline never splits a `101`
    /// from the socket it registers.
    ///
    /// The loop settles every connection it cancels: an upgrade still deciding
    /// is abandoned, and one that was accepted releases its reservation.
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

#[allow(clippy::too_many_arguments)]
async fn accept_connections<A: Acceptor>(
    listener: TcpListener,
    acceptor: A,
    target: ProxyTarget,
    upgrades: Arc<dyn UpgradeHandler>,
    shutdown: CancellationToken,
    permits: Arc<Semaphore>,
    closing_deadline: oneshot::Receiver<Duration>,
    limits: ConnectionLimits,
    http_write: Option<Duration>,
    stats: Arc<Stats>,
    errors: Option<ErrorSink>,
) {
    let connections = Arc::new(Mutex::new(HashMap::<u64, Connection>::new()));
    let mut tasks = JoinSet::new();
    let mut next = 0u64;
    loop {
        tokio::select! {
            _ = shutdown.cancelled() => break,
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    let Ok(peer) = Peer::of(&stream) else {
                        continue;
                    };
                    // The listener's own rule: loopback serves 127.0.0.1 only.
                    if !acceptor.serves(&peer) {
                        continue;
                    }
                    stats.connection();
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
                    let connection_acceptor = acceptor.clone();
                    let connection_limits = limits.clone();
                    let connection_stats = Arc::clone(&stats);
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
                            // not writing: its stream is dropped here, even while
                            // a handshake is still running.
                            _ = cancel.cancelled() => {}
                            io = connection_acceptor.admit(stream, peer) => {
                                if let Some(accepted) = io {
                                    tokio::select! {
                                        biased;
                                        _ = cancel.cancelled() => {}
                                        () = driver::serve(
                                            accepted,
                                            peer,
                                            connection_target,
                                            connection_upgrades,
                                            connection_shutdown,
                                            grace,
                                            connection_limits,
                                            http_write,
                                            connection_stats,
                                        ) => {}
                                    }
                                }
                            }
                        }
                        locked(&registry).remove(&id);
                    });
                }
                Err(error) => {
                    // A listener that bound still drains: an accept failure such
                    // as `EMFILE` repeats while it lasts, so the sink throttles.
                    if let Some(report) = &errors {
                        report(&error);
                    }
                    tokio::time::sleep(ACCEPT_RETRY).await;
                }
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
