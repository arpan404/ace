// SPDX-License-Identifier: Apache-2.0
//! Standard Webhooks signing and checking, ported from
//! `packages/automations/src/webhook-signature.ts` (ADR 0173). HMAC-SHA256 over
//! `<id>.<seconds>.` followed by the request body's raw bytes; `v1,<base64>` entries compared
//! in constant time. The clock comes in from the caller.

use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::webhook_secret_box::decode_base64_lenient;

/// How far a request's timestamp may be from the daemon's clock, either way.
pub const WEBHOOK_TOLERANCE_MS: i64 = 5 * 60_000;
const SECRET_PREFIX: &str = "whsec_";
const MAX_SIGNATURES: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookHeaders {
    pub id: String,
    pub timestamp: i64,
    pub signatures: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebhookCheck {
    Ok,
    StaleTimestamp,
    BadSignature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderError {
    BadHeaders,
}

fn delivery_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    (1..=256).contains(&bytes.len()) && bytes.iter().all(|byte| (0x21..=0x7e).contains(byte))
}

fn timestamp(value: &str) -> bool {
    (1..=12).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_digit())
}

/// `readWebhookHeaders`: the `webhook-*` headers, or `bad_headers` when one is missing or
/// malformed. The caller reads them with its HTTP library.
pub fn read_webhook_headers(
    id: Option<&str>,
    time: Option<&str>,
    signature: Option<&str>,
) -> Result<WebhookHeaders, HeaderError> {
    let id = id
        .filter(|value| delivery_id(value))
        .ok_or(HeaderError::BadHeaders)?;
    let time = time
        .filter(|value| timestamp(value))
        .ok_or(HeaderError::BadHeaders)?;
    let parsed: i64 = time.parse().map_err(|_| HeaderError::BadHeaders)?;
    let signatures: Vec<String> = signature
        .unwrap_or("")
        .split(' ')
        .filter(|entry| !entry.is_empty())
        .map(str::to_owned)
        .collect();
    if signatures.is_empty() || signatures.len() > MAX_SIGNATURES {
        return Err(HeaderError::BadHeaders);
    }
    Ok(WebhookHeaders {
        id: id.to_owned(),
        timestamp: parsed,
        signatures,
    })
}

fn key(secret: &str) -> Vec<u8> {
    let encoded = secret.strip_prefix(SECRET_PREFIX).unwrap_or(secret);
    decode_base64_lenient(encoded)
}

fn digest(secret: &str, id: &str, seconds: i64, body: &[u8]) -> [u8; 32] {
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(&key(secret)) else {
        return [0; 32];
    };
    mac.update(format!("{id}.{seconds}.").as_bytes());
    mac.update(body);
    mac.finalize().into_bytes().into()
}

/// The `webhook-signature` value a sender puts on `body`.
pub fn sign_webhook(secret: &str, id: &str, seconds: i64, body: &[u8]) -> String {
    use base64::Engine;
    format!(
        "v1,{}",
        base64::engine::general_purpose::STANDARD.encode(digest(secret, id, seconds, body))
    )
}

/// Whether a request is signed with `secret` and recent. One matching `v1` entry is enough.
pub fn verify_webhook(
    secret: &str,
    headers: &WebhookHeaders,
    body: &[u8],
    now: i64,
) -> WebhookCheck {
    if (now - headers.timestamp * 1000).abs() > WEBHOOK_TOLERANCE_MS {
        return WebhookCheck::StaleTimestamp;
    }
    let expected = digest(secret, &headers.id, headers.timestamp, body);
    for entry in &headers.signatures {
        let Some(encoded) = entry.strip_prefix("v1,") else {
            continue;
        };
        let given = decode_base64_lenient(encoded);
        if given.len() == expected.len() && given.ct_eq(&expected).into() {
            return WebhookCheck::Ok;
        }
    }
    WebhookCheck::BadSignature
}

#[cfg(test)]
mod tests {
    use super::*;

    // The example in the Standard Webhooks specification and its reference libraries.
    const SECRET: &str = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
    const ID: &str = "msg_p5jXN8AQM9LWM0D4loKWxJek";
    const TIMESTAMP: i64 = 1_614_265_330;
    const BODY: &str = r#"{"test": 2432232314}"#;
    const SIGNATURE: &str = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";

    fn headers(signature: &str) -> WebhookHeaders {
        read_webhook_headers(Some(ID), Some("1614265330"), Some(signature)).expect("headers")
    }

    #[test]
    fn signs_the_specifications_example_to_its_published_signature() {
        assert_eq!(
            sign_webhook(SECRET, ID, TIMESTAMP, BODY.as_bytes()),
            SIGNATURE
        );
    }

    #[test]
    fn accepts_the_specifications_example_request() {
        assert_eq!(
            verify_webhook(
                SECRET,
                &headers(SIGNATURE),
                BODY.as_bytes(),
                TIMESTAMP * 1000
            ),
            WebhookCheck::Ok
        );
    }

    #[test]
    fn accepts_a_request_when_any_one_of_several_signatures_matches() {
        assert_eq!(
            verify_webhook(
                SECRET,
                &headers(&format!("v1,bm90IGl0 v2,abc {SIGNATURE}")),
                BODY.as_bytes(),
                TIMESTAMP * 1000
            ),
            WebhookCheck::Ok
        );
    }

    #[test]
    fn refuses_a_body_with_one_byte_changed() {
        assert_eq!(
            verify_webhook(
                SECRET,
                &headers(SIGNATURE),
                br#"{"test": 2432232315}"#,
                TIMESTAMP * 1000
            ),
            WebhookCheck::BadSignature
        );
    }

    #[test]
    fn refuses_a_request_signed_with_another_secret() {
        let other = crate::webhook_secret_box::new_webhook_secret([0; 32]);
        assert_eq!(
            verify_webhook(
                &other,
                &headers(SIGNATURE),
                BODY.as_bytes(),
                TIMESTAMP * 1000
            ),
            WebhookCheck::BadSignature
        );
    }

    #[test]
    fn refuses_a_signature_replayed_under_another_delivery_id() {
        let headers = read_webhook_headers(Some("msg_other"), Some("1614265330"), Some(SIGNATURE))
            .expect("headers");
        assert_eq!(
            verify_webhook(SECRET, &headers, BODY.as_bytes(), TIMESTAMP * 1000),
            WebhookCheck::BadSignature
        );
    }

    #[test]
    fn refuses_timestamps_more_than_five_minutes_from_now_either_way() {
        let headers = headers(SIGNATURE);
        assert_eq!(
            verify_webhook(
                SECRET,
                &headers,
                BODY.as_bytes(),
                TIMESTAMP * 1000 + 5 * 60_000
            ),
            WebhookCheck::Ok
        );
        assert_eq!(
            verify_webhook(
                SECRET,
                &headers,
                BODY.as_bytes(),
                TIMESTAMP * 1000 + 5 * 60_000 + 1000
            ),
            WebhookCheck::StaleTimestamp
        );
        assert_eq!(
            verify_webhook(
                SECRET,
                &headers,
                BODY.as_bytes(),
                TIMESTAMP * 1000 - 5 * 60_000 - 1000
            ),
            WebhookCheck::StaleTimestamp
        );
    }

    #[test]
    fn refuses_missing_or_malformed_headers() {
        assert_eq!(
            read_webhook_headers(None, Some("1614265330"), Some(SIGNATURE)),
            Err(HeaderError::BadHeaders)
        );
        assert_eq!(
            read_webhook_headers(Some(ID), Some("soon"), Some(SIGNATURE)),
            Err(HeaderError::BadHeaders)
        );
        assert_eq!(
            read_webhook_headers(Some(&"x".repeat(257)), Some("1614265330"), Some(SIGNATURE)),
            Err(HeaderError::BadHeaders)
        );
        assert_eq!(
            read_webhook_headers(Some("has space"), Some("1614265330"), Some(SIGNATURE)),
            Err(HeaderError::BadHeaders)
        );
        assert_eq!(
            read_webhook_headers(Some(ID), Some("1614265330"), Some("")),
            Err(HeaderError::BadHeaders)
        );
    }

    #[test]
    fn makes_secrets_of_thirty_two_random_bytes_that_verify_their_own_signatures() {
        let secret = crate::webhook_secret_box::new_webhook_secret([7; 32]);
        assert!(secret.starts_with("whsec_"));
        let signature = sign_webhook(&secret, "d1", 1_700_000_000, b"{}");
        let headers = read_webhook_headers(Some("d1"), Some("1700000000"), Some(&signature))
            .expect("headers");
        assert_eq!(
            verify_webhook(&secret, &headers, b"{}", 1_700_000_000_000),
            WebhookCheck::Ok
        );
    }
}
