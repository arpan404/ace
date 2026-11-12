//! The person's ace account credential for Spade Cloud (ADR 0140): Spade asks its daemon, with
//! its grant, for a short-lived machine grant (`POST <daemon>/spade/account-grant`), the same
//! credential the relay takes (ADR 0111). It is a bearer for five minutes and is never stored.

use std::time::Duration;

use serde::Deserialize;

use crate::config::ToolsConfig;
use spade_mcp::Secret;

const TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AccountError {
    /// This machine isn't signed in to an ace account.
    #[error("this machine isn't signed in to an ace account")]
    SignedOut,
    /// The daemon, or ace's account backend behind it, didn't answer.
    #[error("ace couldn't be reached: {0}")]
    Unreachable(String),
}

/// A machine grant for this machine's ace account.
#[derive(Debug, Clone)]
pub struct AccountGrant {
    pub token: Secret,
    pub account: String,
    /// How long it was issued for.
    pub lifetime: Duration,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    token: String,
    account: String,
    #[serde(default)]
    expires_in_ms: u64,
}

/// Spade's client for its daemon's account-grant request, made from its ace tools config.
#[derive(Clone)]
pub struct AceAccount {
    url: String,
    grant: Secret,
    http: reqwest::Client,
}

impl AceAccount {
    pub fn new(tools: &ToolsConfig) -> Self {
        let url = tools.url().as_str();
        let base = url.strip_suffix("/mcp").unwrap_or(url);
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_default();
        Self {
            url: format!("{base}/spade/account-grant"),
            grant: tools.token().clone(),
            http,
        }
    }

    pub async fn grant(&self) -> Result<AccountGrant, AccountError> {
        let response = self
            .http
            .post(&self.url)
            .bearer_auth(self.grant.expose())
            .send()
            .await
            .map_err(|e| AccountError::Unreachable(self.grant.scrub(e.to_string())))?;
        match response.status().as_u16() {
            200 => {}
            409 => return Err(AccountError::SignedOut),
            status => {
                return Err(AccountError::Unreachable(format!("ace answered {status}")));
            }
        }
        let answer: Answer = response
            .json()
            .await
            .map_err(|_| AccountError::Unreachable("ace's answer didn't read".into()))?;
        Ok(AccountGrant {
            token: Secret::new(answer.token),
            account: answer.account,
            lifetime: Duration::from_millis(answer.expires_in_ms),
        })
    }
}
