// SPDX-License-Identifier: Apache-2.0
//! The Tailscale cases: `tailscale-certificate.test.ts` and `network.test.ts`.

use super::certificate::split_pem;
use super::parse;
use crate::test_support::TempDir;

/// A PEM document with no certificate, or one with no key, is unusable.
#[test]
fn a_document_without_a_chain_and_key_is_refused() {
    assert_eq!(split_pem(""), None);
    assert_eq!(
        split_pem("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n"),
        None
    );
}

/// `tailscale-certificate.test.ts`: "takes a chain and its key"; a key is
/// recognised by its PEM label.
#[test]
fn a_chain_and_its_key_are_split_out() {
    let output = "noise\n-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\nmore\n";
    let split = split_pem(output);
    let Some((chain, key)) = split else {
        panic!("a chain and key are found");
    };
    assert!(chain.starts_with("-----BEGIN CERTIFICATE-----"));
    assert!(chain.ends_with('\n'));
    assert_eq!(
        key,
        "-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\n"
    );
}

/// `tailscale-certificate.test.ts`: a certificate for another name is refused;
/// the identity is `CN=ace` and valid now.
#[test]
fn a_certificate_for_another_name_is_refused() {
    let home = TempDir::new("ace-tailscale");
    let identity = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()
        .and_then(|runtime| runtime.block_on(crate::identity::load(home.path())).ok());
    let Some(identity) = identity else {
        panic!("the identity is generated in memory");
    };
    let chain = String::from_utf8_lossy(&identity.cert_pem).into_owned();
    let key = String::from_utf8_lossy(&identity.key_pem).into_owned();
    let output = format!("{chain}{key}");
    let now = crate::home::now_ms();
    assert!(parse(&output, "ace", now).is_some());
    assert!(parse(&output, "mac.tailnet.ts.net", now).is_none());
    // Past the certificate's ten years, it is no longer valid.
    assert!(parse(&output, "ace", now + 20 * 365 * 86_400_000).is_none());
}
