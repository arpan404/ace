//! Sealing a token response to Spade's one-time X25519 key.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::aead::{Aad, CHACHA20_POLY1305, LessSafeKey, Nonce, UnboundKey};
use ring::agreement::{self, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::hkdf::{HKDF_SHA256, Salt};
use ring::rand::SecureRandom;

use crate::Sealed;

const SALT: &[u8] = b"spade-cloud/v1 seal";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SealError {
    #[error("the public key is not an X25519 key")]
    BadKey,
    #[error("the sealed answer did not open")]
    Unopened,
    #[error("no random bytes from the system")]
    Random,
}

/// What a sealed message is for; bound into it, so one sealed for a refresh of one app can't be
/// passed off as a sign-in to another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Finish,
    Refresh,
}

#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    pub app: &'a str,
    pub purpose: Purpose,
}

impl Context<'_> {
    fn aad(&self) -> Vec<u8> {
        let purpose = match self.purpose {
            Purpose::Finish => "finish",
            Purpose::Refresh => "refresh",
        };
        format!("spade-cloud/v1 {} {purpose}", self.app).into_bytes()
    }
}

/// Spade's one-time key: made for one sign-in or refresh, used to open its answer, then gone.
pub struct OneTimeKey {
    private: EphemeralPrivateKey,
    public: [u8; 32],
}

impl OneTimeKey {
    pub fn generate(random: &dyn SecureRandom) -> Result<Self, SealError> {
        let private =
            EphemeralPrivateKey::generate(&X25519, random).map_err(|_| SealError::Random)?;
        let public = private
            .compute_public_key()
            .map_err(|_| SealError::Random)?
            .as_ref()
            .try_into()
            .map_err(|_| SealError::Random)?;
        Ok(Self { private, public })
    }

    /// The public half, base64url, as the requests carry it.
    pub fn public_key(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public)
    }

    /// Opens an answer sealed to this key. Uses the key up.
    pub fn open(self, sealed: &Sealed, context: Context<'_>) -> Result<Vec<u8>, SealError> {
        let epk = decode_key(&sealed.epk)?;
        let mut data = URL_SAFE_NO_PAD
            .decode(&sealed.ciphertext)
            .map_err(|_| SealError::Unopened)?;
        let key = agreement::agree_ephemeral(
            self.private,
            &UnparsedPublicKey::new(&X25519, epk),
            |shared| derive(shared, &epk, &self.public),
        )
        .map_err(|_| SealError::Unopened)?
        .ok_or(SealError::Unopened)?;
        let opened = key
            .open_in_place(nonce(), Aad::from(context.aad()), &mut data)
            .map_err(|_| SealError::Unopened)?;
        Ok(opened.to_vec())
    }
}

impl std::fmt::Debug for OneTimeKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OneTimeKey")
            .field("public", &self.public_key())
            .finish_non_exhaustive()
    }
}

/// Seals `plaintext` to `recipient` (base64url X25519 public key) with a fresh key of our own.
pub fn seal(
    random: &dyn SecureRandom,
    recipient: &str,
    plaintext: &[u8],
    context: Context<'_>,
) -> Result<Sealed, SealError> {
    let recipient = decode_key(recipient)?;
    let ours = EphemeralPrivateKey::generate(&X25519, random).map_err(|_| SealError::Random)?;
    let epk: [u8; 32] = ours
        .compute_public_key()
        .map_err(|_| SealError::Random)?
        .as_ref()
        .try_into()
        .map_err(|_| SealError::Random)?;
    let key = agreement::agree_ephemeral(ours, &UnparsedPublicKey::new(&X25519, recipient), |s| {
        derive(s, &epk, &recipient)
    })
    .map_err(|_| SealError::BadKey)?
    .ok_or(SealError::BadKey)?;
    let mut data = plaintext.to_vec();
    key.seal_in_place_append_tag(nonce(), Aad::from(context.aad()), &mut data)
        .map_err(|_| SealError::BadKey)?;
    Ok(Sealed {
        epk: URL_SAFE_NO_PAD.encode(epk),
        ciphertext: URL_SAFE_NO_PAD.encode(data),
    })
}

/// Whether `text` is a base64url X25519 public key, for checking requests before keeping them.
pub fn is_public_key(text: &str) -> bool {
    decode_key(text).is_ok()
}

fn decode_key(text: &str) -> Result<[u8; 32], SealError> {
    URL_SAFE_NO_PAD
        .decode(text)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or(SealError::BadKey)
}

/// The one-message key: HKDF-SHA256 over the shared secret, bound to both public keys. An
/// all-zero shared secret (a low-order peer key) derives nothing.
fn derive(shared: &[u8], sender: &[u8; 32], recipient: &[u8; 32]) -> Option<LessSafeKey> {
    if shared.iter().all(|b| *b == 0) {
        return None;
    }
    let info = [sender.as_slice(), recipient.as_slice()];
    let prk = Salt::new(HKDF_SHA256, SALT).extract(shared);
    let okm = prk.expand(&info, &CHACHA20_POLY1305).ok()?;
    Some(LessSafeKey::new(UnboundKey::from(okm)))
}

/// Each derived key seals one message, so a fixed nonce never repeats under a key.
fn nonce() -> Nonce {
    Nonce::assume_unique_for_key([0; 12])
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::rand::SystemRandom;

    const FINISH: Context<'static> = Context {
        app: "asana",
        purpose: Purpose::Finish,
    };

    #[test]
    fn a_sealed_answer_opens_only_with_the_key_it_was_sealed_to() -> Result<(), SealError> {
        let random = SystemRandom::new();
        let spade = OneTimeKey::generate(&random)?;
        let other = OneTimeKey::generate(&random)?;
        let sealed = seal(
            &random,
            &spade.public_key(),
            br#"{"access_token":"a"}"#,
            FINISH,
        )?;
        assert!(!sealed.ciphertext.contains("access_token"));
        assert_eq!(other.open(&sealed, FINISH), Err(SealError::Unopened));
        assert_eq!(spade.open(&sealed, FINISH)?, br#"{"access_token":"a"}"#);
        Ok(())
    }

    #[test]
    fn a_sealed_answer_does_not_open_for_another_app_or_purpose() -> Result<(), SealError> {
        let random = SystemRandom::new();
        for wrong in [
            Context {
                app: "box",
                purpose: Purpose::Finish,
            },
            Context {
                app: "asana",
                purpose: Purpose::Refresh,
            },
        ] {
            let spade = OneTimeKey::generate(&random)?;
            let sealed = seal(&random, &spade.public_key(), b"tokens", FINISH)?;
            assert_eq!(spade.open(&sealed, wrong), Err(SealError::Unopened));
        }
        Ok(())
    }

    #[test]
    fn a_tampered_answer_does_not_open() -> Result<(), SealError> {
        let random = SystemRandom::new();
        let spade = OneTimeKey::generate(&random)?;
        let mut sealed = seal(&random, &spade.public_key(), b"tokens", FINISH)?;
        let mut bytes = URL_SAFE_NO_PAD
            .decode(&sealed.ciphertext)
            .map_err(|_| SealError::Unopened)?;
        bytes[0] ^= 1;
        sealed.ciphertext = URL_SAFE_NO_PAD.encode(bytes);
        assert_eq!(spade.open(&sealed, FINISH), Err(SealError::Unopened));
        Ok(())
    }

    #[test]
    fn sealing_to_something_that_is_not_a_key_or_a_low_order_point_is_refused() {
        let random = SystemRandom::new();
        assert_eq!(seal(&random, "short", b"x", FINISH), Err(SealError::BadKey));
        let zero = URL_SAFE_NO_PAD.encode([0u8; 32]);
        assert_eq!(seal(&random, &zero, b"x", FINISH), Err(SealError::BadKey));
    }

    #[derive(serde::Deserialize)]
    struct Vectors {
        cases: Vec<Vector>,
    }

    #[derive(serde::Deserialize)]
    struct Vector {
        spade_private_key: String,
        spade_public_key: String,
        cloud_private_key: String,
        app: String,
        purpose: String,
        plaintext: String,
        sealed: Sealed,
    }

    fn hex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap_or_else(|e| panic!("{e}")))
            .collect()
    }

    /// The vectors ace cloud's Worker (`apps/cloud/src/broker/seal.ts`) checks too: with the same
    /// one-time keys, both seal to the same bytes and open each other's answers.
    #[test]
    #[allow(deprecated)] // ring's fixed "random", the only way to give it a known private key
    fn the_shared_vectors_seal_and_open_byte_for_byte_as_ace_cloud_does() -> Result<(), SealError> {
        use ring::test::rand::FixedSliceRandom;
        let vectors: Vectors = serde_json::from_str(include_str!("../test-vectors.json"))
            .unwrap_or_else(|e| panic!("{e}"));
        assert!(!vectors.cases.is_empty());
        for case in &vectors.cases {
            let purpose = match case.purpose.as_str() {
                "finish" => Purpose::Finish,
                _ => Purpose::Refresh,
            };
            let context = Context {
                app: &case.app,
                purpose,
            };
            let cloud_key = hex(&case.cloud_private_key);
            let sealed = seal(
                &FixedSliceRandom { bytes: &cloud_key },
                &case.spade_public_key,
                case.plaintext.as_bytes(),
                context,
            )?;
            assert_eq!(sealed, case.sealed, "{} {}", case.app, case.purpose);
            let spade_key = hex(&case.spade_private_key);
            let spade = OneTimeKey::generate(&FixedSliceRandom { bytes: &spade_key })?;
            assert_eq!(spade.public_key(), case.spade_public_key);
            assert_eq!(
                spade.open(&case.sealed, context)?,
                case.plaintext.as_bytes()
            );
        }
        Ok(())
    }
}
