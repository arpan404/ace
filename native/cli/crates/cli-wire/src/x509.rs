// SPDX-License-Identifier: Apache-2.0
//! X.509 leaf certificate SPKI and validity extraction backed by `x509-parser` and `rustls`'s
//! `ring` SHA-256 provider.

use rustls::crypto::ring::cipher_suite::TLS13_AES_128_GCM_SHA256;
use x509_parser::parse_x509_certificate;

use crate::error::WireError;
use crate::types::Fingerprint;

/// Parsed pinning metadata from a DER-encoded X.509 certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CertificateInfo<'a> {
    /// Raw DER encoding (tag + length + contents) of `SubjectPublicKeyInfo`, matching Node's
    /// `cert.publicKey.export({ type: "spki", format: "der" })`.
    pub spki_der: &'a [u8],
    /// `notBefore` as UTC Unix epoch milliseconds.
    pub not_before_ms: u64,
    /// `notAfter` as UTC Unix epoch milliseconds.
    pub not_after_ms: u64,
}

/// Parses a DER-encoded X.509 certificate and returns its SPKI slice and validity window.
pub fn parse_leaf_certificate(der: &[u8]) -> Result<CertificateInfo<'_>, WireError> {
    let (rem, cert) = parse_x509_certificate(der).map_err(|err| WireError::Auth {
        detail: format!("Invalid X.509 certificate: {err}"),
        revoked: false,
    })?;
    if !rem.is_empty() {
        return Err(WireError::Auth {
            detail: "Trailing bytes after X.509 certificate".into(),
            revoked: false,
        });
    }

    let validity = cert.validity();
    Ok(CertificateInfo {
        spki_der: cert.subject_pki.raw,
        not_before_ms: unix_secs_to_millis(validity.not_before.timestamp())?,
        not_after_ms: unix_secs_to_millis(validity.not_after.timestamp())?,
    })
}

/// Computes the lowercase 64-hex SHA-256 fingerprint of the leaf certificate's SPKI DER bytes.
pub fn spki_sha256_fingerprint(der: &[u8]) -> Result<Fingerprint, WireError> {
    let info = parse_leaf_certificate(der)?;
    Ok(sha256_fingerprint(info.spki_der))
}

/// Computes the SHA-256 [`Fingerprint`] of an arbitrary byte slice using `rustls`'s `ring` hasher.
#[must_use]
pub fn sha256_fingerprint(bytes: &[u8]) -> Fingerprint {
    let hash_provider = match TLS13_AES_128_GCM_SHA256 {
        rustls::SupportedCipherSuite::Tls13(suite) => suite.common.hash_provider,
        rustls::SupportedCipherSuite::Tls12(suite) => suite.common.hash_provider,
    };
    let digest = hash_provider.hash(bytes);
    let mut out = [0_u8; 32];
    let slice = digest.as_ref();
    let copy_len = slice.len().min(32);
    out[..copy_len].copy_from_slice(&slice[..copy_len]);
    Fingerprint::from_bytes(out)
}

fn unix_secs_to_millis(secs: i64) -> Result<u64, WireError> {
    if secs <= 0 {
        return Ok(0);
    }
    u64::try_from(secs)
        .ok()
        .and_then(|s| s.checked_mul(1_000))
        .ok_or_else(|| WireError::Auth {
            detail: "X.509 certificate timestamp overflow".into(),
            revoked: false,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_nist_abc_vector() {
        let fp = sha256_fingerprint(b"abc");
        assert_eq!(
            fp.as_str(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn rejects_truncated_or_garbage_der() {
        assert!(parse_leaf_certificate(&[]).is_err());
        assert!(parse_leaf_certificate(b"not a certificate").is_err());
    }
}
