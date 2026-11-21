//! The backend's signed statement over one version of an organization's policy (ADR 0206 §3),
//! as `signOrgPolicy` in `@ace/account-grant` makes it: `<base64url JSON>.<base64url Ed25519>`
//! over the claims `{v: 1, kid, kind: "org-policy", org, version, body_sha256, set_by, set_at}`,
//! signed with the grant key. A host verifies it with the grant keys it pinned, checks the body
//! it came with is the one signed, and applies only a higher version than it holds.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

/// One of the account backend's grant keys, as `GET /v1/keys` publishes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantKey {
    pub id: String,
    /// Ed25519, base64url, 32 bytes.
    pub public_key: String,
}

/// What a verified statement says.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Statement {
    pub v: u8,
    pub kid: String,
    pub kind: String,
    pub org: String,
    pub version: u64,
    pub body_sha256: String,
    pub set_by: String,
    pub set_at: u64,
}

/// Why a policy version isn't applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("the policy's statement isn't one")]
    Malformed,
    #[error("the policy is signed with a key this host doesn't know")]
    UnknownKey,
    #[error("the policy's signature isn't the backend's")]
    Signature,
    #[error("the policy's text isn't the one its statement signs")]
    Body,
    #[error("the policy is another organization's")]
    OtherOrg,
    #[error("the policy is no newer than the one this host holds")]
    NotNewer,
}

/// The longest statement taken, as every grant parser has it.
const LONGEST: usize = 2048;

/// The statement in `token` over `body` for `org`, verified with `keys`, if it is one.
pub fn verify(token: &str, keys: &[GrantKey], body: &str, org: &str) -> Result<Statement, Refused> {
    let mut parts = token.split('.');
    let (Some(claims), Some(signature), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(Refused::Malformed);
    };
    if token.len() > LONGEST || claims.is_empty() || signature.is_empty() {
        return Err(Refused::Malformed);
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(claims)
        .map_err(|_| Refused::Malformed)?;
    let statement: Statement = serde_json::from_slice(&bytes).map_err(|_| Refused::Malformed)?;
    if statement.v != 1 || statement.kind != "org-policy" {
        return Err(Refused::Malformed);
    }
    let key = keys
        .iter()
        .find(|key| key.id == statement.kid)
        .ok_or(Refused::UnknownKey)?;
    let public = URL_SAFE_NO_PAD
        .decode(&key.public_key)
        .map_err(|_| Refused::UnknownKey)?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| Refused::Signature)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &public)
        .verify(&bytes, &signature)
        .map_err(|_| Refused::Signature)?;
    if statement.body_sha256 != spade_core::org::audit::digest(body.as_bytes()) {
        return Err(Refused::Body);
    }
    if statement.org != org {
        return Err(Refused::OtherOrg);
    }
    Ok(statement)
}

#[cfg(test)]
mod tests;
