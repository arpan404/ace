//! PKCE (RFC 7636, S256 only) and the `state` value, from injected randomness. Pure apart from it.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

/// Where random bytes come from: the OS in Spade, fixed bytes in tests.
pub trait Random: Send + Sync {
    fn fill(&self, buf: &mut [u8]) -> Result<(), String>;
}

/// The operating system's random source.
pub struct OsRandom;

impl Random for OsRandom {
    fn fill(&self, buf: &mut [u8]) -> Result<(), String> {
        getrandom::fill(buf).map_err(|error| format!("no random bytes from the system: {error}"))
    }
}

/// 32 random bytes as base64url: a code verifier (43 characters) or a state. Without randomness
/// no sign-in starts.
pub fn random_value(random: &dyn Random) -> Result<String, String> {
    let mut bytes = [0u8; 32];
    random.fill(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

/// The S256 challenge for `verifier`.
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_challenge_is_the_rfc_7636_s256_of_the_verifier() {
        // RFC 7636 appendix B.
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_random_value_is_43_url_safe_characters() -> Result<(), String> {
        let value = random_value(&OsRandom)?;
        assert_eq!(value.len(), 43);
        assert!(
            value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        assert_ne!(value, random_value(&OsRandom)?);
        Ok(())
    }
}
