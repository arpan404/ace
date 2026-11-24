// SPDX-License-Identifier: Apache-2.0
//! A provider installed before the daemon's own is accepted only when it puts
//! `X25519MLKEM768` first (T1b.1a). Its own test binary, because the install
//! happens once per process.

use ace_transport::{TransportError, process_provider};

#[test]
fn a_provider_without_post_quantum_first_is_refused() {
    // aws-lc-rs's own groups, reordered: the tests never build ring.
    let mut provider = rustls::crypto::aws_lc_rs::default_provider();
    provider.kx_groups = vec![
        rustls::crypto::aws_lc_rs::kx_group::X25519,
        rustls::crypto::aws_lc_rs::kx_group::X25519MLKEM768,
    ];
    let _ = provider.install_default();

    let error = match process_provider() {
        Ok(_) => panic!("a provider without the hybrid group first is refused"),
        Err(error) => error,
    };
    assert!(matches!(error, TransportError::CryptoProvider));
}
