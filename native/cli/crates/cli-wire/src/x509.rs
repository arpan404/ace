// SPDX-License-Identifier: Apache-2.0
//! Minimal pure-Rust ASN.1 DER X.509 leaf certificate parser for SPKI pinning and validity checks.
//!
//! Extracts the exact `SubjectPublicKeyInfo` DER bytes (matching Node's
//! `cert.publicKey.export({ type: "spki", format: "der" })`) and the `Validity` timestamps
//! (`notBefore`, `notAfter`) without adding an external X.509 crate.

use rustls::crypto::ring::cipher_suite::TLS13_AES_128_GCM_SHA256;

use crate::error::WireError;
use crate::types::Fingerprint;

const TAG_SEQUENCE: u8 = 0x30;
const TAG_UTC_TIME: u8 = 0x17;
const TAG_GENERALIZED_TIME: u8 = 0x18;
const TAG_VERSION_EXPLICIT: u8 = 0xA0;

/// Parsed pinning metadata from a DER-encoded X.509 certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CertificateInfo<'a> {
    /// Raw DER encoding (tag + length + contents) of `SubjectPublicKeyInfo`.
    pub spki_der: &'a [u8],
    /// `notBefore` as UTC Unix epoch milliseconds.
    pub not_before_ms: u64,
    /// `notAfter` as UTC Unix epoch milliseconds.
    pub not_after_ms: u64,
}

/// Parses a DER-encoded X.509 certificate and returns its SPKI slice and validity window.
pub fn parse_leaf_certificate(der: &[u8]) -> Result<CertificateInfo<'_>, WireError> {
    let cert_tlv = read_tlv(der)?;
    if cert_tlv.tag != TAG_SEQUENCE || !cert_tlv.rest.is_empty() {
        return Err(bad_cert("Certificate must be a single DER SEQUENCE"));
    }

    let tbs_tlv = read_tlv(cert_tlv.value)?;
    if tbs_tlv.tag != TAG_SEQUENCE {
        return Err(bad_cert("TBSCertificate must be a DER SEQUENCE"));
    }

    // TBSCertificate fields (RFC 5280 §4.1):
    //   [0] EXPLICIT Version OPTIONAL
    //   serialNumber         CertificateSerialNumber
    //   signature            AlgorithmIdentifier
    //   issuer               Name
    //   validity             Validity
    //   subject              Name
    //   subjectPublicKeyInfo SubjectPublicKeyInfo
    let mut cursor = tbs_tlv.value;

    let first = read_tlv(cursor)?;
    if first.tag == TAG_VERSION_EXPLICIT {
        cursor = first.rest;
        cursor = skip_tlv(cursor)?; // serialNumber
    } else {
        cursor = first.rest; // v1 cert: first element was serialNumber
    }
    cursor = skip_tlv(cursor)?; // signature
    cursor = skip_tlv(cursor)?; // issuer

    let validity_tlv = read_tlv(cursor)?;
    if validity_tlv.tag != TAG_SEQUENCE {
        return Err(bad_cert("Validity must be a DER SEQUENCE"));
    }
    let (not_before_ms, not_after_ms) = parse_validity(validity_tlv.value)?;

    cursor = skip_tlv(validity_tlv.rest)?; // subject

    let spki_tlv = read_tlv(cursor)?;
    if spki_tlv.tag != TAG_SEQUENCE {
        return Err(bad_cert("SubjectPublicKeyInfo must be a DER SEQUENCE"));
    }

    Ok(CertificateInfo {
        spki_der: spki_tlv.raw,
        not_before_ms,
        not_after_ms,
    })
}

/// Computes the lowercase 64-hex SHA-256 fingerprint of the leaf certificate's SPKI DER bytes.
pub fn spki_sha256_fingerprint(der: &[u8]) -> Result<Fingerprint, WireError> {
    let info = parse_leaf_certificate(der)?;
    Ok(sha256_fingerprint(info.spki_der))
}

/// Computes the SHA-256 [`Fingerprint`] of an arbitrary byte slice using `rustls`'s ring hasher.
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

struct Tlv<'a> {
    tag: u8,
    raw: &'a [u8],
    value: &'a [u8],
    rest: &'a [u8],
}

fn read_tlv(input: &[u8]) -> Result<Tlv<'_>, WireError> {
    let &tag = input
        .first()
        .ok_or_else(|| bad_cert("Truncated DER element"))?;
    let &len_byte = input
        .get(1)
        .ok_or_else(|| bad_cert("Truncated DER length"))?;

    let (header_len, value_len) = if len_byte & 0x80 == 0 {
        (2_usize, usize::from(len_byte))
    } else {
        let count = usize::from(len_byte & 0x7F);
        if count == 0 || count > 4 {
            return Err(bad_cert("Unsupported DER length encoding"));
        }
        let len_bytes = input
            .get(2..2 + count)
            .ok_or_else(|| bad_cert("Truncated DER long length"))?;
        let mut len = 0_usize;
        for &b in len_bytes {
            len = (len << 8) | usize::from(b);
        }
        (2 + count, len)
    };

    let end = header_len
        .checked_add(value_len)
        .ok_or_else(|| bad_cert("DER length overflow"))?;
    if end > input.len() {
        return Err(bad_cert("DER element exceeds buffer"));
    }

    Ok(Tlv {
        tag,
        raw: &input[..end],
        value: &input[header_len..end],
        rest: &input[end..],
    })
}

fn skip_tlv(input: &[u8]) -> Result<&[u8], WireError> {
    Ok(read_tlv(input)?.rest)
}

fn parse_validity(input: &[u8]) -> Result<(u64, u64), WireError> {
    let not_before_tlv = read_tlv(input)?;
    let not_after_tlv = read_tlv(not_before_tlv.rest)?;
    if !not_after_tlv.rest.is_empty() {
        return Err(bad_cert("Trailing data in Validity"));
    }
    let not_before_ms = parse_asn1_time(not_before_tlv.tag, not_before_tlv.value)?;
    let not_after_ms = parse_asn1_time(not_after_tlv.tag, not_after_tlv.value)?;
    Ok((not_before_ms, not_after_ms))
}

fn parse_asn1_time(tag: u8, bytes: &[u8]) -> Result<u64, WireError> {
    let s = std::str::from_utf8(bytes).map_err(|_| bad_cert("Non-UTF-8 ASN.1 time"))?;
    let (year, rest) = match tag {
        TAG_UTC_TIME => {
            if s.len() != 13 || !s.ends_with('Z') {
                return Err(bad_cert("Invalid UTCTime format"));
            }
            let yy = parse_2_digits(&s[0..2])?;
            let year = if yy >= 50 { 1900 + yy } else { 2000 + yy };
            (year, &s[2..12])
        }
        TAG_GENERALIZED_TIME => {
            if s.len() != 15 || !s.ends_with('Z') {
                return Err(bad_cert("Invalid GeneralizedTime format"));
            }
            let yyyy = parse_4_digits(&s[0..4])?;
            (yyyy, &s[4..14])
        }
        _ => return Err(bad_cert("Unexpected ASN.1 time tag")),
    };

    let month = parse_2_digits(&rest[0..2])?;
    let day = parse_2_digits(&rest[2..4])?;
    let hour = parse_2_digits(&rest[4..6])?;
    let minute = parse_2_digits(&rest[6..8])?;
    let second = parse_2_digits(&rest[8..10])?;

    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return Err(bad_cert("Out-of-range ASN.1 time component"));
    }

    let days = days_from_civil(year, month, day);
    if days < 0 {
        return Ok(0);
    }
    let secs = u64::try_from(days)
        .map_err(|_| bad_cert("ASN.1 time overflow"))?
        .checked_mul(86_400)
        .and_then(|d| d.checked_add(u64::from(hour) * 3_600))
        .and_then(|d| d.checked_add(u64::from(minute) * 60))
        .and_then(|d| d.checked_add(u64::from(second)))
        .and_then(|s_total| s_total.checked_mul(1_000))
        .ok_or_else(|| bad_cert("ASN.1 time overflow"))?;
    Ok(secs)
}

fn parse_2_digits(s: &str) -> Result<u32, WireError> {
    let bytes = s.as_bytes();
    if bytes.len() != 2 || !bytes[0].is_ascii_digit() || !bytes[1].is_ascii_digit() {
        return Err(bad_cert("Invalid numeric field in ASN.1 time"));
    }
    Ok(u32::from(bytes[0] - b'0') * 10 + u32::from(bytes[1] - b'0'))
}

fn parse_4_digits(s: &str) -> Result<u32, WireError> {
    Ok(parse_2_digits(&s[0..2])? * 100 + parse_2_digits(&s[2..4])?)
}

/// Howard Hinnant's civil-from-days inverse: days since 1970-01-01.
const fn days_from_civil(year: u32, month: u32, day: u32) -> i64 {
    let y = year as i64 - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let m = month as i64;
    let d = day as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

fn bad_cert(detail: &'static str) -> WireError {
    WireError::Auth {
        detail: detail.into(),
        revoked: false,
    }
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
    fn asn1_time_parses_utc_and_generalized_times() {
        // 2026-01-01T00:00:00Z = 1767225600000 ms
        assert_eq!(
            parse_asn1_time(TAG_UTC_TIME, b"260101000000Z").unwrap(),
            1_767_225_600_000
        );
        // 2050-06-15T12:30:45Z = 2538909045000 ms
        assert_eq!(
            parse_asn1_time(TAG_GENERALIZED_TIME, b"20500615123045Z").unwrap(),
            2_538_909_045_000
        );
        // 1970-01-01T00:00:00Z = 0 ms
        assert_eq!(parse_asn1_time(TAG_UTC_TIME, b"700101000000Z").unwrap(), 0);
        assert!(parse_asn1_time(TAG_UTC_TIME, b"260101000000").is_err());
    }

    #[test]
    fn parses_synthetic_v3_der_certificate_spki_and_validity() {
        // Minimal valid DER structure for TBSCertificate with [0] version, serial, alg, issuer,
        // validity, subject, and SPKI.
        fn wrap(tag: u8, body: &[u8]) -> Vec<u8> {
            let mut out = vec![tag];
            if body.len() < 128 {
                out.push(u8::try_from(body.len()).unwrap());
            } else {
                out.push(0x81);
                out.push(u8::try_from(body.len()).unwrap());
            }
            out.extend_from_slice(body);
            out
        }

        let version = wrap(TAG_VERSION_EXPLICIT, &[0x02, 0x01, 0x02]);
        let serial = vec![0x02, 0x01, 0x01];
        let alg = wrap(TAG_SEQUENCE, &[0x06, 0x03, 0x2B, 0x65, 0x70]);
        let issuer = wrap(TAG_SEQUENCE, &[]);
        let mut validity_body = wrap(TAG_UTC_TIME, b"260101000000Z");
        validity_body.extend_from_slice(&wrap(TAG_UTC_TIME, b"360101000000Z"));
        let validity = wrap(TAG_SEQUENCE, &validity_body);
        let subject = wrap(TAG_SEQUENCE, &[]);
        let spki = wrap(TAG_SEQUENCE, &[0x03, 0x05, 0x00, 0xDE, 0xAD, 0xBE, 0xEF]);

        let mut tbs_body = Vec::new();
        for part in [&version, &serial, &alg, &issuer, &validity, &subject, &spki] {
            tbs_body.extend_from_slice(part);
        }
        let tbs = wrap(TAG_SEQUENCE, &tbs_body);
        let mut cert_body = tbs;
        cert_body.extend_from_slice(&alg);
        cert_body.extend_from_slice(&[0x03, 0x02, 0x00, 0x00]);
        let cert = wrap(TAG_SEQUENCE, &cert_body);

        let info = parse_leaf_certificate(&cert).unwrap();
        assert_eq!(info.spki_der, spki.as_slice());
        assert_eq!(info.not_before_ms, 1_767_225_600_000);
        assert_eq!(info.not_after_ms, 2_082_758_400_000);
        assert_eq!(
            spki_sha256_fingerprint(&cert).unwrap(),
            sha256_fingerprint(&spki)
        );
    }
}
