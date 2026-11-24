// SPDX-License-Identifier: Apache-2.0
//! The remote listeners' server configuration (T1b.1a): TLS 1.2 and 1.3, no
//! client certificate, `http/1.1` only, in-memory tickets and no 0-RTT — what
//! `sni-listener.ts:106`–`:110` and `node:https`'s defaults serve, and nothing
//! more. It is built from the provider it is handed, never from the process
//! default, so a test's provider is the whole story.

use std::sync::Arc;

use rustls::crypto::CryptoProvider;
use rustls::version::{TLS12, TLS13};
use rustls::{CipherSuite, ServerConfig, SupportedCipherSuite};

use crate::error::TransportError;
use crate::tls::resolver::SniResolver;

/// The configuration every remote connection's handshake runs against.
///
/// **Cipher suites** keep Node's order — AES-256-GCM, ChaCha20-Poly1305, then
/// AES-128-GCM, for TLS 1.3 and 1.2 alike — and the server's order decides
/// (`ignore_client_order`): Node honours the server's order (a client that
/// offered ChaCha20 first still got AES-256-GCM), where rustls' default follows
/// the client's. The key exchange group is where the opposite holds: rustls
/// picks from the **client's** order (`server/hs.rs:557`–`:560`, `:645`–`:651`
/// in 0.23.46) and cannot prefer the server's, which is recorded as a
/// difference because the hybrid wins only for clients that name it first (all
/// of ace's do). No key log is ever configured.
pub fn server_config(
    provider: Arc<CryptoProvider>,
    resolver: Arc<SniResolver>,
) -> Result<ServerConfig, TransportError> {
    let provider = Arc::new(CryptoProvider {
        cipher_suites: node_cipher_order(&provider),
        kx_groups: provider.kx_groups.clone(),
        signature_verification_algorithms: provider.signature_verification_algorithms,
        secure_random: provider.secure_random,
        key_provider: provider.key_provider,
    });
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
    // Node honours the server's cipher order (`honorCipherOrder` is not a Node
    // option at all: OpenSSL's default already prefers the server's list).
    config.ignore_client_order = true;
    Ok(config)
}

/// `provider`'s suites in Node's order: AES-256-GCM, ChaCha20-Poly1305, then
/// AES-128-GCM, TLS 1.3 before TLS 1.2, keeping the provider's order inside each
/// step.
fn node_cipher_order(provider: &CryptoProvider) -> Vec<SupportedCipherSuite> {
    let mut suites = provider.cipher_suites.clone();
    suites.sort_by_key(node_rank);
    suites
}

fn node_rank(suite: &SupportedCipherSuite) -> u8 {
    match suite.suite() {
        CipherSuite::TLS13_AES_256_GCM_SHA384 => 0,
        CipherSuite::TLS13_CHACHA20_POLY1305_SHA256 => 1,
        CipherSuite::TLS13_AES_128_GCM_SHA256 => 2,
        CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
        | CipherSuite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384 => 3,
        CipherSuite::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
        | CipherSuite::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256 => 4,
        CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        | CipherSuite::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 => 5,
        _ => 6,
    }
}
