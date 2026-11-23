// SPDX-License-Identifier: Apache-2.0
//! The transport's typed errors, mapped in the binding. T0 declared the bind
//! failure and the closed listener; T1a.2 adds the loopback guard, the hop's
//! secret and the accepted socket's addresses.

/// What a transport call failed with.
#[derive(Debug, thiserror::Error)]
pub enum TransportError {
    /// Binding the listener failed.
    #[error("bind {addr}: {source}")]
    Bind {
        addr: std::net::SocketAddr,
        source: std::io::Error,
    },
    /// The listener is closed.
    #[error("listener closed")]
    Closed,
    /// A listener or hop address that is not loopback was refused: the
    /// transport binds and connects on 127.0.0.1 and nowhere else.
    #[error("not a loopback address: {addr}")]
    NotLoopback { addr: std::net::SocketAddr },
    /// The OS CSPRNG did not produce the hop secret.
    #[error("the OS CSPRNG failed: {source}")]
    SecretUnavailable {
        #[source]
        source: getrandom::Error,
    },
    /// A hop secret that is not 32 bytes written as 64 hex characters.
    #[error("a hop secret must be 32 bytes as 64 hex characters")]
    SecretEncoding,
    /// The accepted socket's own addresses could not be read.
    #[error("the accepted socket has no addresses: {source}")]
    Peer {
        #[source]
        source: std::io::Error,
    },
}
