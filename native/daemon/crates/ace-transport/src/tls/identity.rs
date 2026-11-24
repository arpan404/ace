// SPDX-License-Identifier: Apache-2.0
//! A TLS identity exactly as TypeScript loaded it (T1b.1a, decision 3): the
//! chain leaf first and the private key, parsed from the same `tls/cert.pem` and
//! `tls/key.pem` bytes `tls-identity.ts` reads. Nothing here generates, rewrites
//! or re-encodes an identity; the pinned fingerprint stays TypeScript's
//! (`tls-identity.ts:6`–`:9`), computed from the same certificate.

use std::sync::Arc;

use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::sign::CertifiedKey;
use zeroize::Zeroizing;

use crate::error::TransportError;
use crate::tls::provider;

/// One server certificate chain and its key, ready for a handshake.
pub struct TlsIdentity(Arc<CertifiedKey>);

impl TlsIdentity {
    /// The chain (leaf first) and the key exactly as `tls/cert.pem` and
    /// `tls/key.pem` hold them.
    ///
    /// The key may be PKCS#8, PKCS#1 or SEC1, which covers OpenSSL's and
    /// LibreSSL's `req -newkey rsa:2048` output, `node-tls-identity.ts`, and
    /// Tailscale's ECDSA keys. A key that does not belong to the certificate is
    /// refused here, not on the first handshake. No error ever carries key
    /// bytes.
    pub fn from_pem(cert_pem: &[u8], key_pem: &[u8]) -> Result<Self, TransportError> {
        let chain: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(cert_pem)
            .collect::<Result<_, _>>()
            .map_err(|_| {
                TransportError::Identity("the certificate PEM cannot be read as a certificate")
            })?;
        if chain.is_empty() {
            return Err(TransportError::Identity(
                "the certificate PEM holds no certificate",
            ));
        }
        // Copied into a buffer this function wipes, and parsed from that copy;
        // the caller's bytes are TypeScript's and are never modified.
        let key_bytes = Zeroizing::new(key_pem.to_vec());
        let key = PrivateKeyDer::from_pem_slice(key_bytes.as_slice())
            .map_err(|_| TransportError::Identity("the key PEM holds no private key"))?;
        let signing = provider::key_provider()
            .load_private_key(key)
            .map_err(|_| {
                TransportError::Identity("the private key is not one aws-lc-rs can sign with")
            })?;
        let certified = CertifiedKey::new(chain, signing);
        certified.keys_match().map_err(|error| match error {
            // A key that is not the certificate's is refused here, not on the
            // first handshake.
            rustls::Error::InconsistentKeys(_) => {
                TransportError::Identity("the private key does not match the certificate")
            }
            // webpki reads X.509 v3 only; an identity it cannot check is
            // refused rather than served unverified.
            rustls::Error::InvalidCertificate(_) => {
                TransportError::Identity("the certificate is not a usable X.509 certificate")
            }
            _ => TransportError::Identity("the certificate and key could not be checked"),
        })?;
        Ok(Self(Arc::new(certified)))
    }

    /// The chain and key, for the resolver and the tests.
    pub(crate) fn key(&self) -> Arc<CertifiedKey> {
        Arc::clone(&self.0)
    }
}
