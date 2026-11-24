// SPDX-License-Identifier: Apache-2.0
//! TLS termination's tests (T1b.1a): the identity as TypeScript hands it over,
//! the certificate the resolver picks, and the handshakes a client can and
//! cannot complete. The listener's own timers are `sni-listener.process`'s
//! cases, run against the selected listener (T1b.4), never copied here.

use rustls::pki_types::CertificateDer;
use rustls::pki_types::pem::PemObject;

use crate::tls::identity::TlsIdentity;

use self::fixtures::{EC_LEAF_CERT, EC_LEAF_KEY, RSA_CERT, RSA_KEY_PKCS8};

pub(crate) mod client;
pub(crate) mod fixtures;
mod handshake;
mod identity;
mod resolver;

fn certs(pem: &str) -> Vec<CertificateDer<'static>> {
    CertificateDer::pem_slice_iter(pem.as_bytes())
        .collect::<Result<_, _>>()
        .expect("a test certificate")
}

fn rsa() -> TlsIdentity {
    TlsIdentity::from_pem(RSA_CERT.as_bytes(), RSA_KEY_PKCS8.as_bytes())
        .expect("the RSA fixture loads")
}

fn ec() -> TlsIdentity {
    TlsIdentity::from_pem(EC_LEAF_CERT.as_bytes(), EC_LEAF_KEY.as_bytes())
        .expect("the ECDSA fixture loads")
}
