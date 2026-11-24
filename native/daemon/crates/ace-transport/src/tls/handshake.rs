// SPDX-License-Identifier: Apache-2.0
//! One TLS handshake on an accepted TCP connection (T1b.1a). A stall, a failure
//! or the handshake limit drops the TCP stream, as Node's `tlsClientError`
//! destroys the socket (`sni-listener.ts:136`).

use std::time::Duration;

use tokio::net::TcpStream;
use tokio_rustls::TlsAcceptor;
use tokio_rustls::server::TlsStream;

/// A connection that finished its TLS handshake.
pub struct Accepted {
    /// The decrypted connection, served exactly as a loopback one.
    pub stream: TlsStream<TcpStream>,
    /// The name the client asked for, as rustls normalised it (lower case, no
    /// trailing dot). `None` with no SNI or an IP literal.
    pub servername: Option<String>,
}

/// Finish the handshake, or close the connection with no byte written.
pub async fn accept(
    acceptor: &TlsAcceptor,
    stream: TcpStream,
    limit: Option<Duration>,
) -> Option<Accepted> {
    let stream = match limit {
        Some(limit) => tokio::time::timeout(limit, acceptor.accept(stream))
            .await
            .ok()?
            .ok()?,
        None => acceptor.accept(stream).await.ok()?,
    };
    let servername = stream.get_ref().1.server_name().map(str::to_owned);
    Some(Accepted { stream, servername })
}
