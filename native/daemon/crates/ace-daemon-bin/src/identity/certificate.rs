// SPDX-License-Identifier: Apache-2.0
//! A self-signed RSA X.509 v3 certificate and its key, made in memory
//! (`apps/daemon/src/self-signed-certificate.ts`): the same shape ace has always
//! written — RSA-2048, SHA-256, `CN=ace`, ten years, no extensions — so a home
//! made by either daemon loads in the other and every paired device's pin still
//! matches. No OpenSSL, so this works on Windows too.

use rsa::pkcs1v15::SigningKey;
use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey, LineEnding};
use rsa::signature::{SignatureEncoding, Signer};
use rsa::{RsaPrivateKey, rand_core::OsRng};
use sha2::Sha256;

/// The identity's PEM pair, as `loadIdentity` reads it back.
pub(super) struct Pair {
    pub(super) key_pem: Vec<u8>,
    pub(super) cert_pem: Vec<u8>,
}

/// `selfSignedCertificate({ commonName: "ace", days: 3650, now })`.
pub(super) fn self_signed(now_ms: u64, days: u64) -> Option<Pair> {
    let key = RsaPrivateKey::new(&mut OsRng, 2048).ok()?;
    let mut serial = [0_u8; 16];
    getrandom::fill(&mut serial).ok()?;
    // A positive serial with no leading zero byte, as RFC 5280 asks.
    serial[0] = (serial[0] & 0x7f) | 0x40;
    let subject = name("ace");
    let sha256_with_rsa = sequence(&[oid("1.2.840.113549.1.1.11"), der(0x05, &[])]);
    let validity = sequence(&[time(now_ms), time(now_ms + days * 86_400_000)]);
    let spki = key.to_public_key().to_public_key_der().ok()?;
    let tbs = sequence(&[
        der(0xa0, &der(0x02, &[2])),
        der(0x02, &serial),
        sha256_with_rsa.clone(),
        subject.clone(),
        validity,
        subject,
        spki.as_bytes().to_vec(),
    ]);
    let signing = SigningKey::<Sha256>::new(key.clone());
    let signature = signing.sign(&tbs);
    let certificate = sequence(&[
        tbs,
        sha256_with_rsa,
        der(0x03, &[&[0_u8][..], signature.to_vec().as_slice()].concat()),
    ]);
    Some(Pair {
        key_pem: key.to_pkcs8_pem(LineEnding::LF).ok()?.as_bytes().to_vec(),
        cert_pem: pem("CERTIFICATE", &certificate),
    })
}

/// One DER element: tag, definite length, then the concatenated contents.
fn der(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    if body.len() < 0x80 {
        out.push(body.len() as u8);
    } else {
        let mut length = body.len();
        let mut bytes = Vec::new();
        while length > 0 {
            bytes.insert(0, (length % 256) as u8);
            length /= 256;
        }
        out.push(0x80 | bytes.len() as u8);
        out.extend_from_slice(&bytes);
    }
    out.extend_from_slice(body);
    out
}

fn sequence(parts: &[Vec<u8>]) -> Vec<u8> {
    der(0x30, &parts.concat())
}

fn oid(dotted: &str) -> Vec<u8> {
    let arcs: Vec<u64> = dotted
        .split('.')
        .filter_map(|arc| arc.parse().ok())
        .collect();
    let Some((first, rest)) = arcs.split_first() else {
        return der(0x06, &[]);
    };
    let mut bytes = vec![(first * 40 + rest.first().copied().unwrap_or(0)) as u8];
    for arc in rest.iter().skip(1) {
        let mut base128 = vec![(arc % 128) as u8];
        let mut high = arc / 128;
        while high > 0 {
            base128.insert(0, ((high % 128) as u8) | 0x80);
            high /= 128;
        }
        bytes.extend_from_slice(&base128);
    }
    der(0x06, &bytes)
}

/// `CN=<commonName>` as a UTF8String.
fn name(common_name: &str) -> Vec<u8> {
    sequence(&[der(
        0x31,
        &sequence(&[oid("2.5.4.3"), der(0x0c, common_name.as_bytes())]),
    )])
}

/// UTCTime through 2049, GeneralizedTime after, both to the second in UTC.
fn time(millis: u64) -> Vec<u8> {
    let seconds = millis / 1000;
    let days = (seconds / 86_400) as i64;
    let of_day = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let stamp = format!(
        "{year:04}{month:02}{day:02}{:02}{:02}{:02}Z",
        of_day / 3600,
        (of_day / 60) % 60,
        of_day % 60
    );
    if year < 2050 {
        der(0x17, &stamp.as_bytes()[2..])
    } else {
        der(0x18, stamp.as_bytes())
    }
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// A PEM block: `-----BEGIN <label>-----`, base64 in 64-character lines, `-----END`.
fn pem(label: &str, der: &[u8]) -> Vec<u8> {
    let encoded = base64_encode(der);
    let mut text = format!("-----BEGIN {label}-----\n");
    for line in encoded.as_bytes().chunks(64) {
        text.push_str(&String::from_utf8_lossy(line));
        text.push('\n');
    }
    text.push_str(&format!("-----END {label}-----\n"));
    text.into_bytes()
}

fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        out.push(ALPHABET[(first >> 2) as usize] as char);
        out.push(ALPHABET[((first & 0x03) << 4 | (second >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[((second & 0x0f) << 2 | (third >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(third & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}
