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
        // The key must be the leaf's, compared as SubjectPublicKeyInfo DER.
        // `CertifiedKey::keys_match` would do this through webpki, which refuses
        // an X.509 v1 certificate; LibreSSL (macOS's /usr/bin/openssl) writes v1
        // for `req -x509`, and the TypeScript daemon's home can hold one. The
        // comparison is the same bytes either way: the SPKI rustls signs with,
        // and the SPKI inside the leaf.
        let leaf = chain.first().ok_or(TransportError::Identity(
            "the certificate PEM holds no certificate",
        ))?;
        let certificate_key = spki_der(leaf.as_ref()).ok_or(TransportError::Identity(
            "the certificate has no readable public key",
        ))?;
        let signing_key = signing.public_key().ok_or(TransportError::Identity(
            "the private key has no public part",
        ))?;
        if signing_key.as_ref() != certificate_key {
            return Err(TransportError::Identity(
                "the private key does not match the certificate",
            ));
        }
        Ok(Self(Arc::new(CertifiedKey::new(chain, signing))))
    }

    /// The chain and key, for the resolver and the tests.
    pub(crate) fn key(&self) -> Arc<CertifiedKey> {
        Arc::clone(&self.0)
    }
}

/// The certificate's SubjectPublicKeyInfo, as the whole DER element.
pub fn spki_der(certificate: &[u8]) -> Option<&[u8]> {
    let (tag, value, _) = tlv(certificate)?;
    if tag != 0x30 {
        return None;
    }
    let (tag, tbs, _) = tlv(value)?;
    if tag != 0x30 {
        return None;
    }
    let mut rest = tbs;
    let (tag, _, after) = tlv(rest)?;
    if tag == 0xa0 {
        rest = after;
    }
    // serial, signature, issuer, validity and subject come before the key.
    for _ in 0..5 {
        let (_, _, after) = tlv(rest)?;
        rest = after;
    }
    let (tag, _, after) = tlv(rest)?;
    if tag != 0x30 {
        return None;
    }
    Some(&rest[..rest.len() - after.len()])
}

/// The DER bytes of the first certificate in a PEM document.
pub fn pem_certificate(pem: &[u8]) -> Option<Vec<u8>> {
    let text = String::from_utf8_lossy(pem);
    let begin = text.find("-----BEGIN CERTIFICATE-----")? + "-----BEGIN CERTIFICATE-----".len();
    let end = text[begin..].find("-----END CERTIFICATE-----")? + begin;
    base64_decode(&text[begin..end])
}

/// `publicKeyFingerprint` (`tls-identity.ts:6`): the SHA-256 of the leaf's SPKI,
/// lower-case hex. One owner, so the pin every paired device stores cannot drift.
pub fn public_key_fingerprint(cert_pem: &[u8]) -> Option<String> {
    use sha2::{Digest, Sha256};
    let der = pem_certificate(cert_pem)?;
    let spki = spki_der(&der)?;
    let mut hasher = Sha256::new();
    hasher.update(spki);
    Some(
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// Standard base64 with padding, whitespace ignored.
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut chunk = [0_u8; 4];
    let mut filled = 0;
    for byte in text.bytes() {
        if byte.is_ascii_whitespace() {
            continue;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => 64,
            _ => return None,
        };
        chunk[filled] = value;
        filled += 1;
        if filled == 4 {
            out.push((chunk[0] << 2) | (chunk[1] >> 4));
            if chunk[2] != 64 {
                out.push((chunk[1] << 4) | (chunk[2] >> 2));
            }
            if chunk[3] != 64 && chunk[2] != 64 {
                out.push((chunk[2] << 6) | chunk[3]);
            }
            filled = 0;
        }
    }
    (filled == 0).then_some(out)
}

/// One DER element: its tag, its value and what follows it.
pub fn tlv(input: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = input.split_first()?;
    let (&first, after_first) = rest.split_first()?;
    let (length, body) = if first < 0x80 {
        (usize::from(first), after_first)
    } else {
        let count = usize::from(first & 0x7f);
        if count == 0 || count > 4 || after_first.len() < count {
            return None;
        }
        let mut length = 0_usize;
        for byte in &after_first[..count] {
            length = length.checked_mul(256)?.checked_add(usize::from(*byte))?;
        }
        (length, &after_first[count..])
    };
    if body.len() < length {
        return None;
    }
    Some((tag, &body[..length], &body[length..]))
}
