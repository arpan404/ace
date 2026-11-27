// SPDX-License-Identifier: Apache-2.0
//! The one fingerprint rule ace's crates share: a pin is 64 lowercase hex characters
//! (`client-access.ts:87`, `tls-identity.ts:6`-`:9`), and a relay host id is the same rule's
//! value written as 52 uppercase base32 characters (`@ace/secure-channel`'s `fingerprint`). Its
//! home is here so the client, the transport and the relay compare one contract, not three.

use sha2::{Digest, Sha256};

/// Whether `text` is a 64-character lowercase hex fingerprint.
pub fn is_fingerprint(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// The fingerprint's 32 bytes, or `None` for text that isn't one.
pub fn parse_fingerprint(text: &str) -> Option<[u8; 32]> {
    if !is_fingerprint(text) {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (index, pair) in text.as_bytes().chunks_exact(2).enumerate() {
        let pair = std::str::from_utf8(pair).ok()?;
        bytes[index] = u8::from_str_radix(pair, 16).ok()?;
    }
    Some(bytes)
}

/// The 32-byte fingerprint as its 64 lowercase hex characters.
pub fn fingerprint_hex(bytes: &[u8; 32]) -> String {
    data_encoding::HEXLOWER.encode(bytes)
}

/// The host id (and pin) of a static public key: uppercase base32 of its SHA-256. TypeScript
/// refuses a key that isn't 32 bytes (`fingerprint`), so `None` is that refusal.
pub fn host_id(public_key: &[u8]) -> Option<String> {
    let bytes: [u8; 32] = public_key.try_into().ok()?;
    Some(data_encoding::BASE32_NOPAD.encode(&Sha256::digest(bytes)))
}

#[cfg(test)]
mod tests {
    //! The rule's own cases: the client's `/^[0-9a-f]{64}$/`, and the host id's 52 base32
    //! characters.

    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::{fingerprint_hex, host_id, is_fingerprint, parse_fingerprint};

    #[test]
    fn a_fingerprint_is_thirty_two_bytes_as_sixty_four_lowercase_hex_characters() {
        let bytes = [0xabu8; 32];
        let hex = fingerprint_hex(&bytes);
        assert_eq!(hex.len(), 64);
        assert!(is_fingerprint(&hex));
        assert_eq!(parse_fingerprint(&hex), Some(bytes));
        assert!(!is_fingerprint(&hex.to_uppercase()));
        assert!(!is_fingerprint(&hex[..63]));
        assert_eq!(parse_fingerprint("nope"), None);
    }

    #[test]
    fn a_host_id_is_fifty_two_base32_characters_of_the_key_s_digest() {
        let id = host_id(&[7u8; 32]).unwrap();
        assert_eq!(id.len(), 52);
        assert!(
            id.bytes()
                .all(|byte| byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte))
        );
        assert_eq!(host_id(&[7u8; 31]), None);
        // The same digest, as the hex pin pairing links carry.
        use sha2::{Digest, Sha256};
        let pin = fingerprint_hex(&Sha256::digest([7u8; 32]).into());
        assert!(is_fingerprint(&pin));
    }
}
