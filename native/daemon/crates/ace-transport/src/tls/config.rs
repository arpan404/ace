// SPDX-License-Identifier: Apache-2.0
//! The remote listeners' server configuration (T1b.1a): TLS 1.2 and 1.3, no
//! client certificate, `http/1.1` only, in-memory tickets and no 0-RTT — what
//! `sni-listener.ts:106`–`:110` and `node:https`'s defaults serve, and nothing
//! more. It is built from the provider it is handed, never from the process
//! default, so a test's provider is the whole story.

use std::sync::Arc;

use rustls::ServerConfig;
use rustls::crypto::CryptoProvider;
use rustls::version::{TLS12, TLS13};

use crate::error::TransportError;
use crate::tls::resolver::SniResolver;

/// The configuration every remote connection's handshake runs against.
///
/// Key-exchange groups are the provider's `DEFAULT_KX_GROUPS` unchanged, with
/// `prefer-post-quantum` on: `X25519MLKEM768`, X25519, P-256, P-384. No key log
/// is ever configured.
pub fn server_config(
    provider: Arc<CryptoProvider>,
    resolver: Arc<SniResolver>,
) -> Result<ServerConfig, TransportError> {
    let builder = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(&[&TLS13, &TLS12])
        .map_err(TransportError::Tls)?;
    let mut config = builder.with_no_client_auth().with_cert_resolver(resolver);
    // `sni-listener.ts:107`, and `node:https`'s default.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    // In memory, as Node's session cache is; aws-lc-rs rotates the keys every
    // six hours and a ticket lives about twelve.
    config.ticketer = rustls::crypto::aws_lc_rs::Ticketer::new().map_err(TransportError::Tls)?;
    // No 0-RTT, as Node.
    config.max_early_data_size = 0;
    // Node's `honorCipherOrder` default is false: the client's order wins.
    config.ignore_client_order = false;
    Ok(config)
}
