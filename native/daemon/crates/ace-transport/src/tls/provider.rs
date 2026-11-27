// SPDX-License-Identifier: Apache-2.0
//! The crate's one boundary to rustls' crypto provider (T1b.1a, decision 4).
//! aws-lc-rs with post-quantum preferred is installed once, by the binding's
//! `process_provider`; logic code is handed a provider and builds its
//! configuration from it, so tests pass their own and nothing here is reached
//! from a handshake.

use std::sync::Arc;

use rustls::NamedGroup;
use rustls::crypto::{CryptoProvider, KeyProvider};

use crate::error::TransportError;

/// The process's crypto provider: aws-lc-rs with `X25519MLKEM768` first in its
/// key-exchange groups.
///
/// On its first call it installs `rustls::crypto::aws_lc_rs::default_provider()`
/// as the process provider (the only process-wide value this crate sets). A
/// provider installed before it is accepted only when its groups start with
/// `X25519MLKEM768`; anything else is refused, and no remote listener starts.
pub fn process_provider() -> Result<Arc<CryptoProvider>, TransportError> {
    if CryptoProvider::get_default().is_none() {
        // A provider installed between the two calls wins; the loser's result
        // carries the winner, so both paths end at `get_default`.
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    }
    let installed = CryptoProvider::get_default()
        .cloned()
        .ok_or(TransportError::CryptoProvider)?;
    if !post_quantum_first(&installed) {
        return Err(TransportError::CryptoProvider);
    }
    Ok(installed)
}

/// The provider identities are parsed with. Parsing installs nothing: the
/// daemon's server configuration is built from the same aws-lc-rs provider, so
/// a key that loads here is one the handshake can sign with.
pub(crate) fn key_provider() -> &'static dyn KeyProvider {
    rustls::crypto::aws_lc_rs::default_provider().key_provider
}

fn post_quantum_first(provider: &CryptoProvider) -> bool {
    provider
        .kx_groups
        .first()
        .is_some_and(|group| group.name() == NamedGroup::X25519MLKEM768)
}
