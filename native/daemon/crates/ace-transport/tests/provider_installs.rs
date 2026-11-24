// SPDX-License-Identifier: Apache-2.0
//! The process provider's install-once rule (T1b.1a). Its own test binary,
//! because the install happens once per process.

use std::sync::Arc;

use rustls::NamedGroup;
use rustls::crypto::CryptoProvider;

use ace_transport::process_provider;

#[test]
fn the_provider_installs_once_with_post_quantum_first() {
    let first = process_provider().expect("the process provider installs");
    assert_eq!(
        first.kx_groups.first().map(|group| group.name()),
        Some(NamedGroup::X25519MLKEM768),
        "X25519MLKEM768 is offered first"
    );
    assert!(
        first
            .kx_groups
            .iter()
            .any(|group| group.name() == NamedGroup::X25519),
        "the classical group every client has stays offered"
    );

    let second = process_provider().expect("a second call returns the installed provider");
    assert!(Arc::ptr_eq(&first, &second));
    let installed = CryptoProvider::get_default().expect("a provider is installed");
    assert!(Arc::ptr_eq(&first, installed));
}
