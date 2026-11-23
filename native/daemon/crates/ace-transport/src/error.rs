// SPDX-License-Identifier: Apache-2.0
//! The transport's typed errors, mapped in the binding. T0 names only the
//! bind failure and the closed listener; later tasks add their own variants.

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
}
