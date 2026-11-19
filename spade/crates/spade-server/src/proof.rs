//! Spade proves it holds its token without revealing it: `GET /health?nonce=N` answers
//! `proof = hex(HMAC-SHA256(key = token, message = N))`. Whoever reads the token file can check the
//! answer, and only the real Spade can give it, so the daemon and the desktop app never hand the
//! token or a grant to another process that took Spade's old port.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;

/// The proof for `nonce`, or `None` when the nonce is not 16 to 64 hex characters.
pub fn answer(token: &str, nonce: &str) -> Option<String> {
    let valid = (16..=64).contains(&nonce.len()) && nonce.bytes().all(|b| b.is_ascii_hexdigit());
    if !valid {
        return None;
    }
    let mut mac = Hmac::<Sha256>::new_from_slice(token.as_bytes()).ok()?;
    mac.update(nonce.as_bytes());
    Some(
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_proof_is_hmac_sha256_of_the_nonce_keyed_by_the_token() {
        // Computed independently: hmac.new(b"Jefe", b"0123456789abcdef", sha256).hexdigest()
        assert_eq!(
            answer("Jefe", "0123456789abcdef").as_deref(),
            Some("fce640f778b7b3e2fdfaf0b98d6be8cd45776ca7a9b04f0272e2004d76b2db42")
        );
        assert_ne!(
            answer("other", "0123456789abcdef").as_deref(),
            Some("fce640f778b7b3e2fdfaf0b98d6be8cd45776ca7a9b04f0272e2004d76b2db42")
        );
    }

    #[test]
    fn a_short_long_or_non_hex_nonce_gets_no_proof() {
        assert_eq!(answer("t", "abc"), None);
        assert_eq!(answer("t", &"a".repeat(65)), None);
        assert_eq!(answer("t", "zzzzzzzzzzzzzzzz"), None);
    }
}
