// SPDX-License-Identifier: Apache-2.0
//! The per-connection certificate (T1b.1a): Tailscale's trusted certificate for
//! exactly its `ts.net` name, ace's pinned certificate for everything else, as
//! `remote-direct.ts:133`–`:139` and `tailscale-certificate.ts:135`–`:138`
//! decide today.

use std::sync::{Arc, RwLock};

use rustls::server::{ClientHello, ResolvesServerCert};
use rustls::sign::CertifiedKey;

use crate::tls::identity::TlsIdentity;

/// The certificate a handshake gets.
///
/// TypeScript pushes the trusted certificate whenever the one it serves changes
/// and clears it when it expires; this type holds what it was given and reads no
/// clock. A connection keeps the certificate it shook hands with.
#[derive(Debug)]
pub struct SniResolver {
    pinned: Arc<CertifiedKey>,
    trusted: RwLock<Option<Trusted>>,
}

#[derive(Debug)]
struct Trusted {
    /// Lower case, one trailing dot removed, as rustls normalises SNI.
    name: String,
    key: Arc<CertifiedKey>,
}

impl SniResolver {
    pub fn new(pinned: TlsIdentity) -> Self {
        Self {
            pinned: pinned.key(),
            trusted: RwLock::new(None),
        }
    }

    /// Serve `identity` for `name` from the next handshake on, replacing any
    /// trusted certificate served before.
    pub fn set_trusted(&self, name: &str, identity: TlsIdentity) {
        let mut trusted = self
            .trusted
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        *trusted = Some(Trusted {
            name: normalise(name),
            key: identity.key(),
        });
    }

    /// Serve the pinned certificate again from the next handshake on.
    pub fn clear_trusted(&self) {
        self.trusted
            .write()
            .unwrap_or_else(|poison| poison.into_inner())
            .take();
    }

    /// Which certificate a handshake that asked for `server_name` gets.
    pub(crate) fn select(&self, server_name: Option<&str>) -> Arc<CertifiedKey> {
        let Some(name) = server_name else {
            return Arc::clone(&self.pinned);
        };
        let trusted = self
            .trusted
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        match trusted.as_ref() {
            Some(trusted) if trusted.name.eq_ignore_ascii_case(name) => Arc::clone(&trusted.key),
            _ => Arc::clone(&self.pinned),
        }
    }
}

impl ResolvesServerCert for SniResolver {
    fn resolve(&self, client_hello: ClientHello<'_>) -> Option<Arc<CertifiedKey>> {
        Some(self.select(client_hello.server_name()))
    }
}

/// The name as rustls hands it to a resolver: lower case, no trailing dot.
fn normalise(name: &str) -> String {
    name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase()
}
