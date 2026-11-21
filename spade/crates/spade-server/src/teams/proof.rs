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
    inbox_proof(key, time, sender, name, body).is_some_and(|expected| same(&expected, proof))
}

/// The headers a forwarded outside request carries that Spade acts on (ADR 0202 §3, §6), in the
/// order ace signs them.
pub const OUTSIDE_HEADERS: [&str; 4] = [
    "mcp-protocol-version",
    "mcp-method",
    "mcp-name",
    "a2a-version",
];

/// What ace's daemon signs on a request it forwards for one of the person's outside agents
/// (ADR 0202 amendment 2): more than an inbox stamp, so a captured stamp can't be replayed or
/// moved. `headers` are [`OUTSIDE_HEADERS`]' values as sent, `None` when absent.
#[derive(Debug, Clone, Copy)]
pub struct Forwarded<'a> {
    pub time: i64,
    /// Fresh for each request; Spade takes each once while the stamp's time verifies.
    pub nonce: &'a str,
    pub method: &'a str,
    /// The path on Spade it was sent to, such as `/v1/outside/mcp`.
    pub route: &'a str,
    pub sender: &'a str,
    /// As sent (percent-encoded).
    pub name: &'a str,
    pub headers: [Option<&'a str>; 4],
    pub body: &'a [u8],
}

/// `hex(HMAC-SHA256(key, "ace-spade-outside/1\n<time>\n<nonce>\n<METHOD>\n<route>\n<sender>\n
/// <name>\n" + "<header>=<value>\n" for each present header + "<hex sha256(body)>"))`.
pub fn outside_proof(key: &str, forwarded: &Forwarded<'_>) -> Option<String> {
    let digest = hex(&Sha256::digest(forwarded.body));
    let mut text = format!(
        "ace-spade-outside/1\n{}\n{}\n{}\n{}\n{}\n{}\n",
        forwarded.time,
        forwarded.nonce,
        forwarded.method.to_ascii_uppercase(),
        forwarded.route,
        forwarded.sender,
        forwarded.name,
    );
    for (name, value) in OUTSIDE_HEADERS.iter().zip(forwarded.headers) {
        if let Some(value) = value {
            text.push_str(&format!("{name}={value}\n"));
        }
    }
    text.push_str(&digest);
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).ok()?;
    mac.update(text.as_bytes());
    Some(hex(&mac.finalize().into_bytes()))
}

/// Whether `proof` signs `forwarded` with `key`, made within [`MOST_SKEW_MS`] of `now`. The
/// nonce's single use is the caller's to check, after this.
pub fn verify_outside(key: &str, proof: &str, now: i64, forwarded: &Forwarded<'_>) -> bool {
    if now.abs_diff(forwarded.time) > MOST_SKEW_MS.unsigned_abs() {
        return false;
    }
    outside_proof(key, forwarded).is_some_and(|expected| same(&expected, proof))
}

/// Whether a nonce is one ace makes: 16 to 128 URL-safe characters.
pub fn valid_nonce(nonce: &str) -> bool {
    (16..=128).contains(&nonce.len())
        && nonce
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// Compared in constant time.
fn same(expected: &str, proof: &str) -> bool {
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

    fn forwarded<'a>(route: &'a str, nonce: &'a str, body: &'a [u8]) -> Forwarded<'a> {
        Forwarded {
            time: 1_000,
            nonce,
            method: "POST",
            route,
            sender: "ace:outside:g1",
            name: "Claude%20Code",
            headers: [Some("2026-07-28"), Some("tools/call"), Some("a__b"), None],
            body,
        }
    }

    #[test]
    fn outside_proof_matches_the_daemons() {
        // The vector the daemon's `spade-contracts.test.ts` checks for its own signature.
        let key = "k".repeat(64);
        let body = br#"{"jsonrpc":"2.0"}"#;
        assert_eq!(
            outside_proof(
                &key,
                &forwarded("/v1/outside/mcp", "nonce-0123456789ab", body)
            )
            .as_deref(),
            Some("bc74f66040710da0dc6b7e0978f1ea6a12cd759a52f4052a2e153f2f0bc61029")
        );
    }

    #[test]
    fn an_outside_proof_binds_its_route_method_headers_and_nonce() {
        let key = "k".repeat(64);
        let body = br#"{"jsonrpc":"2.0"}"#;
        let signed = forwarded("/v1/outside/mcp", "nonce-0123456789ab", body);
        let proof = outside_proof(&key, &signed).unwrap_or_default();
        assert!(verify_outside(&key, &proof, 1_000, &signed));
        let moved = [
            forwarded("/v1/outside/a2a", "nonce-0123456789ab", body),
            forwarded("/v1/outside/mcp", "nonce-other-012345", body),
            Forwarded {
                method: "GET",
                ..signed
            },
            Forwarded {
                headers: [Some("2026-07-28"), Some("tools/list"), Some("a__b"), None],
                ..signed
            },
            // An empty header is not an absent one.
            Forwarded {
                headers: [
                    Some("2026-07-28"),
                    Some("tools/call"),
                    Some("a__b"),
                    Some(""),
                ],
                ..signed
            },
        ];
        for other in moved {
            assert!(!verify_outside(&key, &proof, 1_000, &other), "{other:?}");
        }
        assert!(!verify_outside(
            &key,
            &proof,
            1_000 + MOST_SKEW_MS + 1,
            &signed
        ));
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
