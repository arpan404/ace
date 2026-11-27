// SPDX-License-Identifier: Apache-2.0
//! Webhook secrets at rest, ported from `packages/automations/src/webhook-secret-box.ts`
//! (ADR 0173, decision 11): AES-256-GCM under a key kept outside the store, with the
//! automation's id as associated data so a sealed secret moved to another row never opens. The
//! envelope is `v1.<iv>.<tag>.<ciphertext>`, every part standard base64, and each part after the
//! fourth is ignored on open exactly as the TypeScript's `split` does.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;

const VERSION: &str = "v1";
/// The tag AES-GCM appends, which the envelope carries as its own part.
const TAG_BYTES: usize = 16;

/// A box over the machine's 32-byte key. The caller owns the key file and the per-seal IV.
pub struct SecretBox {
    key: [u8; 32],
}

impl SecretBox {
    pub fn new(key: [u8; 32]) -> SecretBox {
        SecretBox { key }
    }

    fn cipher(&self) -> Option<Aes256Gcm> {
        Aes256Gcm::new_from_slice(&self.key).ok()
    }

    /// Seal `secret` for `automation_id` with a fresh IV from the caller.
    pub fn seal(&self, secret: &str, automation_id: &str, iv: [u8; 12]) -> Option<String> {
        let cipher = self.cipher()?;
        let mut sealed = cipher
            .encrypt(
                &Nonce::from(iv),
                Payload {
                    msg: secret.as_bytes(),
                    aad: automation_id.as_bytes(),
                },
            )
            .ok()?;
        if sealed.len() < TAG_BYTES {
            return None;
        }
        let tag = sealed.split_off(sealed.len() - TAG_BYTES);
        Some(format!(
            "{VERSION}.{}.{}.{}",
            STANDARD.encode(iv),
            STANDARD.encode(tag),
            STANDARD.encode(sealed)
        ))
    }

    /// The secret, or none when it was sealed under another key or for another automation.
    pub fn open(&self, sealed: &str, automation_id: &str) -> Option<String> {
        let parts: Vec<&str> = sealed.split('.').collect();
        let (Some(version), Some(iv), Some(tag), Some(data)) =
            (parts.first(), parts.get(1), parts.get(2), parts.get(3))
        else {
            return None;
        };
        if *version != VERSION || iv.is_empty() || tag.is_empty() || data.is_empty() {
            return None;
        }
        let cipher = self.cipher()?;
        let mut ciphertext = decode_base64_lenient(data);
        ciphertext.extend_from_slice(&decode_base64_lenient(tag));
        let plain = cipher
            .decrypt(
                &Nonce::from(<[u8; 12]>::try_from(decode_base64_lenient(iv)).ok()?),
                Payload {
                    msg: &ciphertext,
                    aad: automation_id.as_bytes(),
                },
            )
            .ok()?;
        String::from_utf8(plain).ok()
    }
}

/// `Buffer.from(…, "base64")`'s decoding: both alphabets, padding optional, decoding stops at
/// the first `=`, other characters are skipped. A strict decoder would refuse rows the
/// TypeScript opens.
pub fn decode_base64_lenient(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut accumulator: u32 = 0;
    let mut bits = 0u32;
    for byte in text.bytes() {
        if byte == b'=' {
            break;
        }
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        accumulator = (accumulator << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((accumulator >> bits) as u8);
        }
    }
    out
}

/// `newWebhookSecret`: `whsec_` and 32 random bytes in standard base64.
pub fn new_webhook_secret(random: [u8; 32]) -> String {
    format!("whsec_{}", STANDARD.encode(random))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(fill: u8) -> SecretBox {
        SecretBox::new([fill; 32])
    }

    #[test]
    fn a_sealed_secret_opens_with_its_key_and_automation_and_not_once_changed_or_moved() {
        let box_ = key(3);
        let sealed = box_.seal("whsec_abc", "deploy", [9; 12]).expect("seal");
        assert_eq!(box_.open(&sealed, "deploy").as_deref(), Some("whsec_abc"));
        assert_eq!(box_.open(&sealed, "other"), None);
        let parts: Vec<&str> = sealed.split('.').collect();
        let mut data = decode_base64_lenient(parts[3]);
        data[0] ^= 1;
        let changed = format!(
            "{}.{}.{}.{}",
            parts[0],
            parts[1],
            parts[2],
            STANDARD.encode(data)
        );
        assert_eq!(box_.open(&changed, "deploy"), None);
        assert_eq!(key(4).open(&sealed, "deploy"), None);
    }

    #[test]
    fn the_envelope_is_standard_base64_with_a_fresh_twelve_byte_iv() {
        let box_ = key(1);
        let sealed = box_.seal("secret", "a", [2; 12]).expect("seal");
        let parts: Vec<&str> = sealed.split('.').collect();
        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], "v1");
        assert_eq!(decode_base64_lenient(parts[1]).len(), 12);
        assert_eq!(decode_base64_lenient(parts[2]).len(), 16);
        assert_eq!(parts[1], STANDARD.encode([2u8; 12]));
    }

    #[test]
    fn opening_ignores_parts_after_the_fourth_and_refuses_short_or_empty_ones() {
        let box_ = key(5);
        let sealed = box_.seal("secret", "a", [1; 12]).expect("seal");
        assert_eq!(
            box_.open(&format!("{sealed}.ignored"), "a").as_deref(),
            Some("secret")
        );
        assert_eq!(box_.open("v2.a.b.c", "a"), None);
        assert_eq!(box_.open("v1..b.c", "a"), None);
        assert_eq!(box_.open("v1.a", "a"), None);
    }

    #[test]
    fn lenient_base64_matches_buffers_decoding() {
        assert_eq!(decode_base64_lenient("aGVsbG8="), b"hello");
        assert_eq!(decode_base64_lenient("aGVsbG8"), b"hello");
        assert_eq!(decode_base64_lenient("aGVs bG8="), b"hello");
        assert_eq!(decode_base64_lenient("_-8="), decode_base64_lenient("/+8="));
        assert_eq!(decode_base64_lenient("aGVsbG8=trailing"), b"hello");
    }

    #[test]
    fn a_new_secret_is_the_prefix_plus_thirty_two_bytes() {
        let secret = new_webhook_secret([7; 32]);
        assert!(secret.starts_with("whsec_"));
        let encoded = secret.trim_start_matches("whsec_");
        assert_eq!(decode_base64_lenient(encoded), vec![7; 32]);
        assert_eq!(encoded.len(), 44);
    }
}
