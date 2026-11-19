//! The daemon's signature on an inbox request (ADR 0132, docs/teams.md "What ace adds"). The
//! daemon that forwards a request from another machine signs it with its own local token; Spade
//! reads that token from ace's home and checks the signature, so Spade's bearer token alone
//! never reaches the inbox, and the sender stamp is bound to the daemon that checked the caller.

use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};

/// How far the signing time may be from Spade's clock.
pub const MOST_SKEW_MS: i64 = 5 * 60_000;

/// `hex(HMAC-SHA256(key, "ace-spade-inbox/1\n<time>\n<sender>\n<name>\n<hex sha256(body)>"))`,
/// with `name` as sent (percent-encoded).
pub fn inbox_proof(key: &str, time: i64, sender: &str, name: &str, body: &[u8]) -> Option<String> {
    let digest = hex(&Sha256::digest(body));
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).ok()?;
    mac.update(format!("ace-spade-inbox/1\n{time}\n{sender}\n{name}\n{digest}").as_bytes());
    Some(hex(&mac.finalize().into_bytes()))
}

/// Whether `proof` signs this request with `key`, made within [`MOST_SKEW_MS`] of `now`.
pub fn verify(
    key: &str,
    proof: &str,
    time: i64,
    now: i64,
    sender: &str,
    name: &str,
    body: &[u8],
) -> bool {
    // `abs_diff` can't overflow, whatever time a request claims.
    if now.abs_diff(time) > MOST_SKEW_MS.unsigned_abs() {
        return false;
    }
    let Some(expected) = inbox_proof(key, time, sender, name, body) else {
        return false;
    };
    // Compared in constant time.
    expected.len() == proof.len()
        && expected
            .bytes()
            .zip(proof.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

/// A percent-encoded stamp, decoded as UTF-8; `None` when it isn't.
pub fn decode_name(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let pair = raw.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(pair, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inbox_proof_matches_the_daemons() {
        // The vector the daemon's `target-spade.test.ts` checks for its own signature.
        let key = "k".repeat(64);
        assert_eq!(
            inbox_proof(&key, 1_000, "laptop-device", "Laptop", br#"{"op":"bots"}"#).as_deref(),
            Some("9326fdb7539c287a4116cc8be088e4e560fa39f64ddd273f9c3d8dac96818a75")
        );
    }

    #[test]
    fn a_proof_for_another_body_sender_key_or_an_old_time_does_not_verify() {
        let key = "k".repeat(64);
        let body = br#"{"op":"bots"}"#;
        let proof = inbox_proof(&key, 1_000, "d", "N", body).unwrap_or_default();
        assert!(verify(&key, &proof, 1_000, 1_000, "d", "N", body));
        assert!(!verify(
            &key,
            &proof,
            1_000,
            1_000,
            "d",
            "N",
            br#"{"op":"ask"}"#
        ));
        assert!(!verify(&key, &proof, 1_000, 1_000, "other", "N", body));
        assert!(!verify("x", &proof, 1_000, 1_000, "d", "N", body));
        assert!(!verify(
            &key,
            &proof,
            1_000,
            1_000 + MOST_SKEW_MS + 1,
            "d",
            "N",
            body
        ));
    }

    #[test]
    fn a_time_at_either_end_of_the_range_is_refused_not_a_panic() {
        let key = "k".repeat(64);
        let body = br#"{"op":"bots"}"#;
        for time in [i64::MIN, i64::MAX] {
            let proof = inbox_proof(&key, time, "d", "N", body).unwrap_or_default();
            assert!(!verify(&key, &proof, time, 1_000, "d", "N", body));
        }
    }

    #[test]
    fn a_stamped_name_is_decoded_from_percent_encoding() {
        assert_eq!(
            decode_name("Arpan%E2%80%99s%20Mac").as_deref(),
            Some("Arpan\u{2019}s Mac")
        );
        assert_eq!(decode_name("bad%zz"), None);
    }
}
