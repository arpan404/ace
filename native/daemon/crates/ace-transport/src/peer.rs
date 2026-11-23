// SPDX-License-Identifier: Apache-2.0
//! Who a connection is talking to. Both ends come from the accepted socket's
//! own addresses, so the hop's peer fields can never be a client's claim.

use std::net::SocketAddr;

use tokio::net::TcpStream;

use crate::error::TransportError;

/// The accepted socket's two ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Peer {
    /// The client's address, as the kernel reports it.
    pub remote: SocketAddr,
    /// The address the client connected to.
    pub local: SocketAddr,
}

impl Peer {
    /// Read both ends of an accepted socket. This is the only constructor: the
    /// hop never takes a peer from a header or from the request.
    pub fn of(stream: &TcpStream) -> Result<Self, TransportError> {
        let remote = stream
            .peer_addr()
            .map_err(|source| TransportError::Peer { source })?;
        let local = stream
            .local_addr()
            .map_err(|source| TransportError::Peer { source })?;
        Ok(Self { remote, local })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn both_ends_are_the_accepted_sockets_own() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a loopback listener");
        let local = listener.local_addr().expect("its address");
        let client = tokio::net::TcpStream::connect(local)
            .await
            .expect("a loopback client");
        let (accepted, _) = listener.accept().await.expect("an accepted socket");
        let peer = Peer::of(&accepted).expect("both addresses");

        assert_eq!(peer.local, local);
        assert_eq!(
            peer.remote,
            client.local_addr().expect("the client's address")
        );
        assert_eq!(peer.remote.ip(), local.ip());
    }
}
