//! What Spade and Spade Cloud say to each other (ADR 0140, `spade/docs/cloud.md`): the shapes of
//! the broker's requests and answers, and [`seal`] / [`OneTimeKey::open`], which carry an app's
//! token response from the cloud to Spade so only the Spade that started the sign-in can read it.
//!
//! Sealing is X25519 with a fresh key on each side, HKDF-SHA256 over the shared secret and both
//! public keys, and ChaCha20-Poly1305 with the app and purpose as associated data. Each derived
//! key seals exactly one message, so the nonce is fixed.

mod seal;

pub use seal::{Context, OneTimeKey, Purpose, SealError, is_public_key, seal};

use serde::{Deserialize, Serialize};

/// The path every maker redirects back to, under the cloud's public address.
pub const CALLBACK_PATH: &str = "/v1/oauth/callback";

/// How long a sign-in may take from start to finish, in seconds.
pub const SIGN_IN_SECONDS: u64 = 600;

/// `POST /v1/oauth/{app}/start`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartRequest {
    /// The PKCE S256 challenge (RFC 7636); Spade keeps the verifier.
    pub code_challenge: String,
    /// Spade's one-time X25519 public key, base64url.
    pub public_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StartAnswer {
    /// Names this sign-in when Spade finishes it. Not the OAuth `state`.
    pub sign_in: String,
    /// Where the person signs in, in their browser.
    pub authorization_url: String,
    pub expires_in: u64,
    /// The maker's authorization server, and the client the cloud signs in as. Shown, never
    /// secret.
    pub issuer: String,
    pub client_id: String,
}

/// `POST /v1/oauth/{app}/finish`.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FinishRequest {
    pub sign_in: String,
    pub code_verifier: String,
}

impl std::fmt::Debug for FinishRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FinishRequest").finish_non_exhaustive()
    }
}

/// What finishing answered: still waiting for the person (HTTP 202), or the tokens, sealed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum FinishAnswer {
    Waiting,
    Done { sealed: Sealed },
}

/// `POST /v1/oauth/{app}/refresh`. The refresh token travels over TLS only.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RefreshRequest {
    pub refresh_token: String,
    /// A fresh one-time X25519 public key, base64url, for the answer.
    pub public_key: String,
}

impl std::fmt::Debug for RefreshRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RefreshRequest").finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RefreshAnswer {
    pub sealed: Sealed,
}

/// A token response sealed to Spade's one-time key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sealed {
    /// The cloud's one-time X25519 public key, base64url.
    pub epk: String,
    /// The JSON token response, encrypted, with its tag, base64url.
    pub ciphertext: String,
}

/// Every refusal: `{"error": "<code>"}`, with fixed codes from [`Refusal`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorAnswer {
    pub error: String,
}

/// The codes in [`ErrorAnswer::error`].
pub mod refusal {
    /// No grant, or one that didn't verify (401).
    pub const UNAUTHORIZED: &str = "unauthorized";
    /// The cloud couldn't read ace's account keys to check the grant; try later (503).
    pub const ACCOUNT_UNAVAILABLE: &str = "account_unavailable";
    /// Too many requests from this account or address (429).
    pub const RATE_LIMITED: &str = "rate_limited";
    /// The cloud doesn't sign in to this app (404).
    pub const UNKNOWN_APP: &str = "unknown_app";
    /// The cloud lists the app but its client isn't set up (503).
    pub const APP_UNAVAILABLE: &str = "app_unavailable";
    /// The request didn't read (400).
    pub const INVALID: &str = "invalid_request";
    /// No sign-in by that name for this account and app, or it was used (404).
    pub const UNKNOWN_SIGN_IN: &str = "unknown_sign_in";
    /// The sign-in ran out of time (410).
    pub const EXPIRED: &str = "expired";
    /// The verifier doesn't match the challenge; the sign-in is dropped (400).
    pub const WRONG_VERIFIER: &str = "wrong_verifier";
    /// The person declined at the maker, or the answer came from the wrong issuer (409).
    pub const DECLINED: &str = "declined";
    /// The maker refused the code or the refresh token: sign in again (400).
    pub const REFUSED: &str = "refused";
    /// The maker couldn't be reached or answered something unusable (502).
    pub const UPSTREAM: &str = "upstream";
}
