//! OpenAI's sign-in for ChatGPT accounts, as its Codex clients use it: an authorization code with
//! PKCE (S256) returned to a loopback address, or a device code, then refreshable tokens. The
//! endpoints and parameters were learned from OpenAI's Apache-2.0 Codex client; the code is
//! Spade's own. No error from here carries a token.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};

use crate::Config;

/// What a sign-in asks for: who the person is, and a refresh token.
pub const SCOPE: &str = "openid profile email offline_access";

/// The tokens a sign-in or a refresh gives.
#[derive(Clone, PartialEq, Eq, Deserialize)]
pub struct Tokens {
    #[serde(default)]
    pub id_token: Option<String>,
    pub access_token: String,
    pub refresh_token: String,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tokens(…)")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OauthError {
    /// The server refused for good: a refresh token that expired, was used or was revoked.
    #[error("{0}")]
    Refused(String),
    /// Anything that may pass: the network, the server's own trouble, an odd answer.
    #[error("{0}")]
    Failed(String),
}

/// The address the person's browser opens to sign in.
pub fn authorize_url(
    config: &Config,
    redirect: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(&format!("{}/oauth/authorize", config.issuer))
        .map_err(|_| "the sign-in address is not a URL".to_owned())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", redirect)
        .append_pair("scope", SCOPE)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("state", state)
        .append_pair("originator", &config.originator);
    Ok(url.into())
}

/// The HTTP client sign-in calls go through: no redirects (each carries a code or a token), and
/// bounded in time.
pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| format!("the sign-in client could not start: {e}"))
}

/// Trades an authorization code for tokens.
pub async fn exchange(
    http: &reqwest::Client,
    config: &Config,
    code: &str,
    redirect: &str,
    verifier: &str,
) -> Result<Tokens, OauthError> {
    let form = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", config.client_id.as_str()),
        ("code_verifier", verifier),
    ];
    let response = http
        .post(format!("{}/oauth/token", config.issuer))
        .form(&form)
        .send()
        .await
        .map_err(|e| {
            OauthError::Failed(format!(
                "OpenAI's sign-in could not be reached ({})",
                kind(&e)
            ))
        })?;
    let (status, body) = read(response).await?;
    if !status.is_success() {
        return Err(OauthError::Failed(format!(
            "OpenAI's sign-in refused the code ({}{})",
            status.as_u16(),
            said(&body)
        )));
    }
    serde_json::from_slice(&body)
        .map_err(|_| OauthError::Failed("OpenAI's sign-in sent no tokens".to_owned()))
}

/// What a refresh gives: a new access token, and new refresh and ID tokens when the server
/// rotates them.
#[derive(Clone, Deserialize)]
pub struct Refreshed {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub id_token: Option<String>,
}

/// Error codes that mean a refresh token is no good any more.
const DEAD_REFRESH: [&str; 4] = [
    "refresh_token_expired",
    "refresh_token_reused",
    "refresh_token_invalidated",
    "invalid_grant",
];

/// Gets a new access token with `refresh`.
pub async fn refresh(
    http: &reqwest::Client,
    config: &Config,
    refresh: &str,
) -> Result<Refreshed, OauthError> {
    let response = http
        .post(format!("{}/oauth/token", config.issuer))
        .json(&json!({
            "client_id": config.client_id,
            "grant_type": "refresh_token",
            "refresh_token": refresh,
        }))
        .send()
        .await
        .map_err(|e| {
            OauthError::Failed(format!(
                "OpenAI's sign-in could not be reached ({})",
                kind(&e)
            ))
        })?;
    let (status, body) = read(response).await?;
    if status.is_success() {
        return serde_json::from_slice(&body)
            .map_err(|_| OauthError::Failed("OpenAI's sign-in sent no access token".to_owned()));
    }
    let code = error_code(&body);
    if status.as_u16() == 401 || code.as_deref().is_some_and(|c| DEAD_REFRESH.contains(&c)) {
        return Err(OauthError::Refused(
            "This ChatGPT account is signed out. Sign in again in Settings › Spade › Models."
                .to_owned(),
        ));
    }
    Err(OauthError::Failed(format!(
        "OpenAI's sign-in could not refresh the account ({})",
        status.as_u16()
    )))
}

/// A device code: the person opens `url` on any device and enters `user_code`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeviceCode {
    pub device_auth_id: String,
    pub user_code: String,
    pub url: String,
    pub interval: Duration,
}

/// Asks for a device code.
pub async fn device_code(
    http: &reqwest::Client,
    config: &Config,
) -> Result<DeviceCode, OauthError> {
    let response = http
        .post(format!(
            "{}/api/accounts/deviceauth/usercode",
            config.issuer
        ))
        .json(&json!({ "client_id": config.client_id }))
        .send()
        .await
        .map_err(|e| {
            OauthError::Failed(format!(
                "OpenAI's sign-in could not be reached ({})",
                kind(&e)
            ))
        })?;
    let (status, body) = read(response).await?;
    if !status.is_success() {
        return Err(OauthError::Failed(format!(
            "OpenAI's sign-in gave no device code ({}{})",
            status.as_u16(),
            said(&body)
        )));
    }
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| OauthError::Failed("OpenAI's sign-in gave no device code".to_owned()))?;
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    let (Some(device_auth_id), Some(user_code)) = (
        text("device_auth_id"),
        text("user_code").or_else(|| text("usercode")),
    ) else {
        return Err(OauthError::Failed(
            "OpenAI's sign-in gave no device code".to_owned(),
        ));
    };
    // The interval may come as a number or as text; at least a second, at most a minute.
    let interval = value
        .get("interval")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        })
        .unwrap_or(5)
        .clamp(1, 60);
    Ok(DeviceCode {
        device_auth_id,
        user_code,
        url: format!("{}/codex/device", config.issuer),
        interval: Duration::from_secs(interval),
    })
}

/// What one poll of a device code found.
#[derive(Clone, PartialEq, Eq)]
pub enum Poll {
    /// The person hasn't finished yet.
    Waiting,
    /// They did: the code to trade, with the verifier the server made for it.
    Approved { code: String, verifier: String },
}

/// Asks once whether the person finished the device sign-in.
pub async fn poll_device(
    http: &reqwest::Client,
    config: &Config,
    device: &DeviceCode,
) -> Result<Poll, OauthError> {
    let response = http
        .post(format!("{}/api/accounts/deviceauth/token", config.issuer))
        .json(&json!({ "device_auth_id": device.device_auth_id, "user_code": device.user_code }))
        .send()
        .await
        .map_err(|e| {
            OauthError::Failed(format!(
                "OpenAI's sign-in could not be reached ({})",
                kind(&e)
            ))
        })?;
    let (status, body) = read(response).await?;
    // Not finished yet reads as 403 or 404.
    if matches!(status.as_u16(), 403 | 404) {
        return Ok(Poll::Waiting);
    }
    if !status.is_success() {
        return Err(OauthError::Failed(format!(
            "OpenAI's sign-in refused the device code ({})",
            status.as_u16()
        )));
    }
    let value: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    match (text("authorization_code"), text("code_verifier")) {
        (Some(code), Some(verifier)) => Ok(Poll::Approved { code, verifier }),
        _ => Err(OauthError::Failed(
            "OpenAI's sign-in approved the device but sent no code".to_owned(),
        )),
    }
}

/// Where a device sign-in's code is traded.
pub fn device_redirect(config: &Config) -> String {
    format!("{}/deviceauth/callback", config.issuer)
}

/// The most of an answer read.
const MOST_BODY: usize = 256 * 1024;

async fn read(
    mut response: reqwest::Response,
) -> Result<(reqwest::StatusCode, Vec<u8>), OauthError> {
    let status = response.status();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| {
        OauthError::Failed(format!(
            "OpenAI's sign-in answer did not arrive ({})",
            kind(&e)
        ))
    })? {
        body.extend_from_slice(&chunk);
        if body.len() > MOST_BODY {
            return Err(OauthError::Failed(
                "OpenAI's sign-in answer is too large".to_owned(),
            ));
        }
    }
    Ok((status, body))
}

fn error_code(body: &[u8]) -> Option<String> {
    let value: Value = serde_json::from_slice(body).ok()?;
    let code = value
        .pointer("/error/code")
        .or_else(|| value.get("code"))
        .or_else(|| value.get("error"))?;
    code.as_str().map(str::to_owned)
}

/// The server's error code, as `: code`, never anything else it sent (it may echo a secret).
fn said(body: &[u8]) -> String {
    error_code(body)
        .filter(|c| c.len() <= 60 && c.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '_'))
        .map(|c| format!(": {c}"))
        .unwrap_or_default()
}

fn kind(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        "it took too long"
    } else if error.is_connect() {
        "the connection failed"
    } else {
        "the request failed"
    }
}
