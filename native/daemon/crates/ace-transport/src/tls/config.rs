// SPDX-License-Identifier: Apache-2.0
//! The remote listeners' server configuration (T1b.1a): TLS 1.2 and 1.3, no
//! client certificate, `http/1.1` only, in-memory tickets and no 0-RTT — what
//! `sni-listener.ts:106`–`:110` and `node:https`'s defaults serve, and nothing
//! more. It is built from the provider it is handed, never from the process
//! default, so a test's provider is the whole story.

use std::sync::Arc;

use rustls::crypto::{CryptoProvider, SupportedKxGroup};
use rustls::version::{TLS12, TLS13};
use rustls::{CipherSuite, ServerConfig, SupportedCipherSuite, SupportedProtocolVersion};

use crate::error::TransportError;
use crate::tls::resolver::SniResolver;

/// The configuration a client without `X25519MLKEM768` gets.
///
/// **Cipher suites** keep Node's order and the server's order decides
/// (`ignore_client_order`). Node leaves `honorCipherOrder` at its default, but
/// Node 26.8.1 still chose AES-256-GCM for a client that listed ChaCha20 first,
/// for TLS 1.3 and for TLS 1.2, and its TLS 1.2 list puts AES-128-GCM ahead of
/// AES-256-GCM. rustls' default follows the client's order, so the suites are
/// ordered explicitly. No key log is ever configured; the key exchange choice
/// is [`server_config_preferring_hybrid`]'s and the acceptor's.
pub fn server_config(
    provider: Arc<CryptoProvider>,
    resolver: Arc<SniResolver>,
) -> Result<ServerConfig, TransportError> {
    let kx_groups = provider.kx_groups.clone();
    let suites = node_cipher_order(&provider);
    let provider = Arc::new(configured(&provider, suites, kx_groups));
    build(provider, &[&TLS13, &TLS12], resolver)
}

/// The configuration a client that offers `X25519MLKEM768` gets: TLS 1.3 only,
/// and a provider whose only key-exchange group is that hybrid. rustls cannot
/// fall back to the classical group the client happened to list first
/// (`server/hs.rs:557`–`:560`, `:645`–`:651` in 0.23.46 picks from the client's
/// order), so it uses the client's hybrid key share, or asks for one with a
/// HelloRetryRequest (`server/tls13.rs:221`, RFC 8446 §4.2.8). A client without
/// the hybrid gets [`server_config`].
///
/// The hybrid is a TLS 1.3 group, so this configuration serves TLS 1.3 alone;
/// a client that offers it speaks 1.3 (a client that caps at 1.2, as Node does
/// with `maxVersion`, does not list it).
pub fn server_config_preferring_hybrid(
    provider: Arc<CryptoProvider>,
    resolver: Arc<SniResolver>,
) -> Result<ServerConfig, TransportError> {
    let suites = node_cipher_order(&provider)
        .into_iter()
        .filter(|suite| is_tls13(suite.suite()))
        .collect();
    let provider = Arc::new(configured(
        &provider,
        suites,
        vec![rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768],
    ));
    build(provider, &[&TLS13], resolver)
}

/// The suite list and groups one configuration uses.
fn configured(
    provider: &CryptoProvider,
    cipher_suites: Vec<SupportedCipherSuite>,
    kx_groups: Vec<&'static dyn SupportedKxGroup>,
) -> CryptoProvider {
    CryptoProvider {
        cipher_suites,
        kx_groups,
        signature_verification_algorithms: provider.signature_verification_algorithms,
        secure_random: provider.secure_random,
        key_provider: provider.key_provider,
    }
}

fn build(
    provider: Arc<CryptoProvider>,
    versions: &[&'static SupportedProtocolVersion],
    resolver: Arc<SniResolver>,
) -> Result<ServerConfig, TransportError> {
    let builder = ServerConfig::builder_with_provider(provider)
        .with_protocol_versions(versions)
        .map_err(TransportError::Tls)?;
    let mut config = builder.with_no_client_auth().with_cert_resolver(resolver);
    // `sni-listener.ts:107`, and `node:https`'s default.
    config.alpn_protocols = vec![b"http/1.1".to_vec()];
    // In memory, as Node's session cache is; aws-lc-rs rotates the keys every
    // six hours and a ticket lives about twelve.
    config.ticketer = rustls::crypto::aws_lc_rs::Ticketer::new().map_err(TransportError::Tls)?;
    // No 0-RTT, as Node.
    config.max_early_data_size = 0;
    // Node's default `honorCipherOrder` is false, but its negotiated suites
    // still follow the server's list (probed 2026-11-24); rustls' default
    // follows the client's, so the server's order is chosen explicitly.
    config.ignore_client_order = true;
    Ok(config)
}

/// `provider`'s suites in Node's order: for TLS 1.3, AES-256-GCM,
/// ChaCha20-Poly1305, then AES-128-GCM; for TLS 1.2, AES-128-GCM, AES-256-GCM,
/// then ChaCha20-Poly1305 (`tls.DEFAULT_CIPHERS` in Node 26.8.1). The provider's
/// order is kept inside each step.
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
        CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
        | CipherSuite::TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 => 3,
        CipherSuite::TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384
        | CipherSuite::TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384 => 4,
        CipherSuite::TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256
        | CipherSuite::TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256 => 5,
        _ => 6,
    }
}

fn is_tls13(suite: CipherSuite) -> bool {
    matches!(
        suite,
        CipherSuite::TLS13_AES_256_GCM_SHA384
            | CipherSuite::TLS13_CHACHA20_POLY1305_SHA256
            | CipherSuite::TLS13_AES_128_GCM_SHA256
    )
}
