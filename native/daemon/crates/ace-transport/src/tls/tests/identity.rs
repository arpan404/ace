// SPDX-License-Identifier: Apache-2.0
//! The identity as TypeScript hands it to Rust (T1b.1a): every key encoding the
//! daemon and Tailscale produce, a chain of two, and each refusal naming the
//! part that failed.

use crate::error::TransportError;
use crate::tls::identity::TlsIdentity;

use super::fixtures::{
    EC_LEAF_CERT, EC_LEAF_KEY, ROOT_CERT, RSA_CERT, RSA_KEY_PKCS1, RSA_KEY_PKCS8,
};
use super::{certs, ec, rsa};

#[test]
fn an_rsa_pkcs8_key_loads() {
    let identity = rsa();
    assert_eq!(identity.key().cert.len(), 1);
}

#[test]
fn an_rsa_pkcs1_key_loads() {
    let identity = TlsIdentity::from_pem(RSA_CERT.as_bytes(), RSA_KEY_PKCS1.as_bytes())
        .expect("PKCS#1 loads as PKCS#8 does");
    assert_eq!(identity.key().cert.len(), 1);
}

#[test]
fn an_ecdsa_sec1_key_loads() {
    let identity = ec();
    assert_eq!(identity.key().cert.len(), 1);
}

#[test]
fn a_chain_of_two_keeps_the_leaf_first() {
    let chain = format!("{EC_LEAF_CERT}{ROOT_CERT}");
    let identity = TlsIdentity::from_pem(chain.as_bytes(), EC_LEAF_KEY.as_bytes())
        .expect("a chain of two loads");
    let served = identity.key();
    assert_eq!(served.cert.len(), 2);
    assert_eq!(served.cert[0], certs(EC_LEAF_CERT)[0]);
    assert_eq!(served.cert[1], certs(ROOT_CERT)[0]);
}

#[test]
fn a_key_that_does_not_belong_to_the_certificate_is_refused_at_load() {
    let error = TlsIdentity::from_pem(RSA_CERT.as_bytes(), EC_LEAF_KEY.as_bytes())
        .err()
        .expect("another identity's key is not accepted");
    match error {
        TransportError::Identity(what) => assert!(what.contains("does not match"), "{what}"),
        other => panic!("expected an identity error, got {other}"),
    }
}

#[test]
fn an_empty_pem_holds_no_identity() {
    let error = TlsIdentity::from_pem(b"", RSA_KEY_PKCS8.as_bytes())
        .err()
        .expect("no certificate is no identity");
    match error {
        TransportError::Identity(what) => assert!(what.contains("no certificate"), "{what}"),
        other => panic!("expected an identity error, got {other}"),
    }
}

#[test]
fn a_key_with_no_certificate_is_refused() {
    let error = TlsIdentity::from_pem(b"", RSA_KEY_PKCS8.as_bytes())
        .err()
        .expect("a key alone is not an identity");
    assert!(matches!(error, TransportError::Identity(_)));
}

#[test]
fn a_certificate_with_no_key_is_refused() {
    let error = TlsIdentity::from_pem(RSA_CERT.as_bytes(), b"")
        .err()
        .expect("a certificate alone is not an identity");
    match error {
        TransportError::Identity(what) => assert!(what.contains("no private key"), "{what}"),
        other => panic!("expected an identity error, got {other}"),
    }
}
