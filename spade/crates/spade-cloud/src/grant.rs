//! ace account grants (ADR 0111), verified as `@ace/account-grant` verifies them: base64url claims
//! JSON, a dot, an Ed25519 signature over those bytes by a key the account backend publishes;
//! the right kind; unexpired; issued no more than a minute ahead; living at most five minutes.
//! Pure: callers pass the keys and the time. `test-vectors.json` in that package pins both
//! implementations to the same verdicts.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{ED25519, UnparsedPublicKey};
use serde::Deserialize;

pub const GRANT_LIFETIME_MS: u64 = 5 * 60_000;
pub const GRANT_SKEW_MS: u64 = 60_000;
const MOST_TOKEN_BYTES: usize = 2048;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Machine,
    Device,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Claims {
    pub v: u8,
    pub kid: String,
    pub kind: Kind,
    /// The account's id at the account backend.
    pub account: String,
    /// The machine's host id, or the device's id.
    pub subject: String,
    pub iat: u64,
    pub exp: u64,
    #[serde(default)]
    pub aud: Option<String>,
    #[serde(default)]
    pub purpose: Option<String>,
}

/// `GET /v1/keys` on the account backend.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct KeySet {
    pub keys: Vec<PublishedKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedKey {
    pub id: String,
    pub public_key: String,
}

impl KeySet {
    /// The published set as `@ace/account-grant` accepts it: one to eight keys, each id plain and
    /// each key 32 bytes.
    pub fn checked(self) -> Result<Self, String> {
        if self.keys.is_empty() || self.keys.len() > 8 {
            return Err("the key set must hold one to eight keys".into());
        }
        for key in &self.keys {
            if !plain_id(&key.id) || decode(&key.public_key).map(|k| k.len()) != Some(32) {
                return Err("a published key is malformed".into());
            }
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GrantError {
    #[error("malformed grant")]
    Malformed,
    /// Signed by a key id the set doesn't hold; the set may be stale.
    #[error("unknown grant key")]
    UnknownKey(String),
    #[error("invalid grant signature")]
    BadSignature,
    #[error("wrong grant kind")]
    WrongKind,
    #[error("grant expired")]
    Expired,
    #[error("grant lifetime invalid")]
    Lifetime,
}

/// Verifies `token` against `keys` at `now` (ms since the epoch) for `kind`.
pub fn verify(token: &str, keys: &KeySet, now: u64, kind: &Kind) -> Result<Claims, GrantError> {
    let mut parts = token.split('.');
    let (Some(body), Some(signature), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(GrantError::Malformed);
    };
    if body.is_empty() || signature.is_empty() || token.len() > MOST_TOKEN_BYTES {
        return Err(GrantError::Malformed);
    }
    let bytes = decode(body).ok_or(GrantError::Malformed)?;
    let claims: Claims = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|text| serde_json::from_str(text).ok())
        .ok_or(GrantError::Malformed)?;
    if claims.v != 1
        || !plain_id(&claims.kid)
        || !(1..=256).contains(&claims.account.chars().count())
        || !(1..=128).contains(&claims.subject.chars().count())
        || claims.exp == 0
    {
        return Err(GrantError::Malformed);
    }
    let key = keys
        .keys
        .iter()
        .find(|key| key.id == claims.kid)
        .ok_or_else(|| GrantError::UnknownKey(claims.kid.clone()))?;
    let public = decode(&key.public_key).ok_or(GrantError::BadSignature)?;
    let signature = decode(signature).ok_or(GrantError::BadSignature)?;
    UnparsedPublicKey::new(&ED25519, public)
        .verify(&bytes, &signature)
        .map_err(|_| GrantError::BadSignature)?;
    if &claims.kind != kind {
        return Err(GrantError::WrongKind);
    }
    if claims.exp <= now {
        return Err(GrantError::Expired);
    }
    if claims.iat > now + GRANT_SKEW_MS || claims.exp.saturating_sub(claims.iat) > GRANT_LIFETIME_MS
    {
        return Err(GrantError::Lifetime);
    }
    Ok(claims)
}

/// Cloud requests never accept a general relay grant.
pub fn verify_cloud(
    token: &str,
    keys: &KeySet,
    now: u64,
    kind: &Kind,
) -> Result<Claims, GrantError> {
    let claims = verify(token, keys, now, kind)?;
    if claims.aud.as_deref() != Some("cloud.acehq.dev")
        || claims.purpose.as_deref() != Some("spade-cloud")
    {
        return Err(GrantError::WrongKind);
    }
    Ok(claims)
}

fn plain_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn decode(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    struct Vectors {
        keys: KeySet,
        now: u64,
        valid: Vec<Valid>,
        invalid: Vec<Invalid>,
    }
    #[derive(Deserialize)]
    struct Valid {
        token: String,
        kind: Kind,
        account: String,
        subject: String,
    }
    #[derive(Deserialize)]
    struct Invalid {
        why: String,
        token: String,
        kind: Kind,
        now: Option<u64>,
    }

    #[test]
    fn the_shared_test_vectors_give_the_same_verdicts_as_the_account_grant_package() {
        let vectors: Vectors = serde_json::from_str(include_str!(
            "../../../../packages/account-grant/test-vectors.json"
        ))
        .unwrap_or_else(|e| panic!("{e}"));
        let keys = vectors.keys.checked().unwrap_or_else(|e| panic!("{e}"));
        for each in &vectors.valid {
            let claims = verify(&each.token, &keys, vectors.now, &each.kind)
                .unwrap_or_else(|e| panic!("{e}"));
            assert_eq!(claims.account, each.account);
            assert_eq!(claims.subject, each.subject);
        }
        assert!(vectors.invalid.len() >= 8);
        for each in &vectors.invalid {
            let now = each.now.unwrap_or(vectors.now);
            assert!(
                verify(&each.token, &keys, now, &each.kind).is_err(),
                "{} was accepted",
                each.why
            );
        }
    }
}
