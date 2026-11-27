// SPDX-License-Identifier: Apache-2.0
//! One TLS handshake on an accepted TCP connection (T1b.1a). The ClientHello is
//! read first, so a client that offers the post-quantum group gets a
//! configuration whose only key-exchange group is that hybrid: rustls then uses
//! the client's hybrid share or asks for one with a HelloRetryRequest, whatever
//! order the client named the groups in. A stall, a failure or the handshake
//! limit drops the TCP stream, as Node's `tlsClientError` destroys the socket
//! (`sni-listener.ts:136`).

use std::sync::Arc;
use std::time::Duration;

use rustls::NamedGroup;
use rustls::ServerConfig;
use rustls::server::Acceptor;
use tokio::net::TcpStream;
use tokio_rustls::LazyConfigAcceptor;
use tokio_rustls::server::TlsStream;

/// The two configurations an accepted connection chooses between: one whose
/// only key-exchange group is `X25519MLKEM768`, and the normal one. Both are
/// built once per listener and share one certificate resolver, so a pushed
/// trusted certificate serves either choice.
pub struct Configs {
    pub preferring_hybrid: Arc<ServerConfig>,
    pub normal: Arc<ServerConfig>,
}

impl Configs {
    pub fn new(preferring_hybrid: Arc<ServerConfig>, normal: Arc<ServerConfig>) -> Self {
        Self {
            preferring_hybrid,
            normal,
        }
    }

    /// One configuration for both choices, for the tests that are not about key
    /// exchange.
    pub fn same(config: Arc<ServerConfig>) -> Self {
        Self {
            preferring_hybrid: Arc::clone(&config),
            normal: config,
        }
    }

    /// What a ClientHello that named `X25519MLKEM768` (and no other group, since
    /// this is the only one checked) gets.
    fn for_hello(&self, groups: Option<&[NamedGroup]>) -> Arc<ServerConfig> {
        let hybrid = groups.is_some_and(|groups| groups.contains(&NamedGroup::X25519MLKEM768));
        if hybrid {
            Arc::clone(&self.preferring_hybrid)
        } else {
            Arc::clone(&self.normal)
        }
    }
}

/// A connection that finished its TLS handshake.
pub struct Accepted {
    /// The decrypted connection, served exactly as a loopback one.
    pub stream: TlsStream<TcpStream>,
    /// The name the client asked for, as rustls normalised it (lower case, no
    /// trailing dot). `None` with no SNI or an IP literal.
    pub servername: Option<String>,
}

/// Finish the handshake, or close the connection with no byte written. The one
/// limit bounds both halves: the ClientHello and the rest.
pub async fn accept(
    configs: &Configs,
    stream: TcpStream,
    limit: Option<Duration>,
) -> Option<Accepted> {
    let handed = match limit {
        Some(limit) => tokio::time::timeout(limit, handshake(configs, stream))
            .await
            .ok()?,
        None => handshake(configs, stream).await,
    }?;
    let servername = handed.get_ref().1.server_name().and_then(forwardable);
    Some(Accepted {
        stream: handed,
        servername,
    })
}

/// The name the hop may carry: the guard's alphabet (`[a-z0-9.-]{1,253}`,
/// as rustls normalises it), so a name it would refuse is treated as no SNI
/// rather than failing a handshake Node completes with the pinned identity.
pub(crate) fn forwardable(name: &str) -> Option<String> {
    let valid = !name.is_empty()
        && name.len() <= 253
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.' || byte == b'-'
        });
    valid.then(|| name.to_owned())
}

async fn handshake(configs: &Configs, stream: TcpStream) -> Option<TlsStream<TcpStream>> {
    let start = LazyConfigAcceptor::new(Acceptor::default(), stream)
        .await
        .ok()?;
    let config = configs.for_hello(start.client_hello().named_groups());
    start.into_stream(config).await.ok()
}
