// SPDX-License-Identifier: Apache-2.0
//! The certificate each handshake gets (T1b.1a): the pushed trusted one for
//! exactly its name, the pinned one for everything else.

use std::sync::Arc;

use crate::tls::resolver::SniResolver;

use super::{ec, rsa};

#[test]
fn the_trusted_name_gets_the_trusted_certificate() {
    let pinned = rsa();
    let resolver = SniResolver::new(pinned);
    let trusted = ec();
    let trusted_key = trusted.key();
    resolver.set_trusted("ace.tail1234.ts.net", trusted);
    assert!(Arc::ptr_eq(
        &resolver.select(Some("ace.tail1234.ts.net")),
        &trusted_key
    ));
}

#[test]
fn the_trusted_name_matches_without_case_or_a_trailing_dot() {
    let resolver = SniResolver::new(rsa());
    let trusted = ec();
    let trusted_key = trusted.key();
    resolver.set_trusted("ACE.Tail1234.TS.NET.", trusted);
    // rustls hands a resolver the name lower-cased with one trailing dot gone.
    assert!(Arc::ptr_eq(
        &resolver.select(Some("ace.tail1234.ts.net")),
        &trusted_key
    ));
    assert!(Arc::ptr_eq(
        &resolver.select(Some("ACE.TAIL1234.TS.NET")),
        &trusted_key
    ));
}

#[test]
fn another_name_gets_the_pinned_certificate() {
    let pinned = rsa();
    let pinned_key = pinned.key();
    let resolver = SniResolver::new(pinned);
    resolver.set_trusted("ace.tail1234.ts.net", ec());
    assert!(Arc::ptr_eq(
        &resolver.select(Some("ace.tail9999.ts.net")),
        &pinned_key
    ));
}

#[test]
fn no_name_gets_the_pinned_certificate() {
    let pinned = rsa();
    let pinned_key = pinned.key();
    let resolver = SniResolver::new(pinned);
    resolver.set_trusted("ace.tail1234.ts.net", ec());
    assert!(Arc::ptr_eq(&resolver.select(None), &pinned_key));
}

#[test]
fn clearing_the_trusted_certificate_serves_the_pinned_one_again() {
    let pinned = rsa();
    let pinned_key = pinned.key();
    let resolver = SniResolver::new(pinned);
    resolver.set_trusted("ace.tail1234.ts.net", ec());
    resolver.clear_trusted();
    assert!(Arc::ptr_eq(
        &resolver.select(Some("ace.tail1234.ts.net")),
        &pinned_key
    ));
}

/// An expiry timer clears only the certificate it was armed for: a newer
/// certificate installed meanwhile stays served.
#[test]
fn an_expiry_timer_clears_only_its_own_generation() {
    let resolver = SniResolver::new(rsa());
    let first = resolver.set_trusted("ace.tail1234.ts.net", ec());
    let _second = resolver.set_trusted("ace.tail1234.ts.net", rsa());
    resolver.clear_trusted_if(first);
    assert_eq!(resolver.select(Some("ace.tail1234.ts.net")).cert.len(), 1);
    resolver.clear_trusted();
    assert_eq!(resolver.select(Some("ace.tail1234.ts.net")).cert.len(), 1);
}
