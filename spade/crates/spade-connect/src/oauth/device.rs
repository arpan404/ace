//! The OAuth device authorization grant (RFC 8628), for apps that let a public client sign in
//! without a browser redirect and without a secret (GitHub's "device flow"). Spade asks the
//! authorization server for a code, the person enters it on the app's own page, and Spade polls
//! the token endpoint at the interval the server set, slowing down when told to, until the person
//! approves, declines, or the code expires.

use reqwest::StatusCode;
use serde_json::Value;

use super::{Client, Net, OauthError, Tokens, described, post_token_form, tokens_from};

/// The grant type of a device-code token request.
pub const GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

/// How long a code lasts when the server doesn't say (RFC 8628 leaves it to the server; GitHub's
/// default).
const DEFAULT_EXPIRES_IN: u64 = 900;
/// RFC 8628 section 3.2: five seconds when the server gives no interval.
const DEFAULT_INTERVAL: u64 = 5;
/// RFC 8628 section 3.5: each `slow_down` adds five seconds to the interval.
pub const SLOW_DOWN_STEP: u64 = 5;
/// The longest user code shown; anything longer is not a code a person types.
const MOST_CODE_CHARS: usize = 64;

/// A started device sign-in: what the person is shown, and what Spade polls with.
#[derive(Clone, PartialEq, Eq)]
pub struct Authorization {
    /// Sent only to the token endpoint, never shown.
    pub device_code: String,
    /// What the person types on the app's page.
    pub user_code: String,
    /// The app's page for entering the code.
    pub verification_uri: String,
    /// The same page with the code filled in, when the server offers one.
    pub verification_uri_complete: Option<String>,
    pub expires_in: u64,
    /// Seconds between polls.
    pub interval: u64,
}

impl std::fmt::Debug for Authorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Authorization")
            .field("verification_uri", &self.verification_uri)
            .field("expires_in", &self.expires_in)
            .field("interval", &self.interval)
            .finish_non_exhaustive()
    }
}

/// What one poll of the token endpoint answered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Poll {
    Done(Tokens),
    /// The person hasn't finished yet: poll again after the interval.
    Pending,
    /// Polling too fast: add [`SLOW_DOWN_STEP`] to the interval, then poll again.
    SlowDown,
    /// The code expired before the person finished.
    Expired,
    /// The person declined.
    Denied,
    /// Anything else ends the sign-in; the server's words are not passed on.
    Failed(String),
}

/// The interval after a poll's answer, in seconds.
pub fn next_interval(current: u64, poll: &Poll) -> u64 {
    match poll {
        Poll::SlowDown => current.saturating_add(SLOW_DOWN_STEP),
        _ => current,
    }
}

/// Asks `endpoint` (the server's `device_authorization_endpoint`) for a code. The page it names
/// for the person is held to the same address rules as every other sign-in address.
pub async fn start(
    net: &Net,
    endpoint: &str,
    client: &Client,
    scopes: &[String],
    resource: &str,
) -> Result<Authorization, OauthError> {
    let mut form = vec![("resource", resource.to_owned())];
    if !scopes.is_empty() {
        form.push(("scope", scopes.join(" ")));
    }
    let (status, answer) = post_token_form(net, endpoint, client, form).await?;
    if !status.is_success() || answer.get("error").is_some() {
        let code = answer.get("error").and_then(Value::as_str).unwrap_or("");
        return Err(match code {
            "" => OauthError::Network(format!("the sign-in server answered HTTP {status}")),
            code => OauthError::Refused(format!("{code}{}", described(&answer))),
        });
    }
    let text = |key: &str| {
        answer
            .get(key)
            .and_then(Value::as_str)
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    };
    let number = |key: &str| match answer.get(key) {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    };
    let unusable = |what: &str| OauthError::Unsupported(format!("the device sign-in gave {what}"));
    let device_code = text("device_code").ok_or_else(|| unusable("no device code"))?;
    let user_code = text("user_code")
        .filter(|code| {
            code.chars().count() <= MOST_CODE_CHARS
                && code.chars().all(|c| c.is_ascii_graphic() || c == ' ')
        })
        .ok_or_else(|| unusable("no code a person can type"))?;
    // RFC 8628 names it `verification_uri`; some servers wrote `verification_url`.
    let verification_uri = text("verification_uri")
        .or_else(|| text("verification_url"))
        .ok_or_else(|| unusable("no page to enter the code on"))?;
    net.check(&verification_uri).await?;
    let verification_uri_complete = match text("verification_uri_complete") {
        Some(complete) if net.check(&complete).await.is_ok() => Some(complete),
        _ => None,
    };
    Ok(Authorization {
        device_code,
        user_code,
        verification_uri,
        verification_uri_complete,
        expires_in: number("expires_in")
            .filter(|s| *s > 0)
            .unwrap_or(DEFAULT_EXPIRES_IN),
        interval: number("interval")
            .filter(|s| *s > 0)
            .unwrap_or(DEFAULT_INTERVAL),
    })
}

/// Polls the token endpoint once. Some servers (GitHub) answer `200` with an `error`, so the
/// `error` decides, whatever the status.
pub async fn poll(
    net: &Net,
    token_endpoint: &str,
    client: &Client,
    device_code: &str,
    resource: &str,
) -> Poll {
    let form = vec![
        ("grant_type", GRANT.to_owned()),
        ("device_code", device_code.to_owned()),
        ("resource", resource.to_owned()),
    ];
    let (status, answer) = match post_token_form(net, token_endpoint, client, form).await {
        Ok(answer) => answer,
        // A network blip is not the person's answer: poll again.
        Err(OauthError::Network(_)) => return Poll::Pending,
        Err(error) => return Poll::Failed(error.to_string()),
    };
    match answer.get("error").and_then(Value::as_str) {
        Some("authorization_pending") => Poll::Pending,
        Some("slow_down") => Poll::SlowDown,
        // GitHub's prose calls it `token_expired`; RFC 8628 and its table say `expired_token`.
        Some("expired_token" | "token_expired") => Poll::Expired,
        Some("access_denied") => Poll::Denied,
        Some(_) => Poll::Failed("the app refused the sign-in".into()),
        None if status.is_success() => match tokens_from(&answer) {
            Ok(tokens) => Poll::Done(tokens),
            Err(error) => Poll::Failed(error.to_string()),
        },
        None if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS => {
            Poll::Pending
        }
        None => Poll::Failed(format!("the sign-in server answered HTTP {status}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slow_down_adds_five_seconds_and_nothing_else_changes_the_interval() {
        assert_eq!(next_interval(5, &Poll::SlowDown), 10);
        assert_eq!(next_interval(10, &Poll::SlowDown), 15);
        assert_eq!(next_interval(5, &Poll::Pending), 5);
        assert_eq!(next_interval(u64::MAX, &Poll::SlowDown), u64::MAX);
    }

    #[test]
    fn the_device_code_never_shows_in_debug_output() {
        let started = Authorization {
            device_code: "dc-secret".into(),
            user_code: "ABCD-1234".into(),
            verification_uri: "https://example.com/device".into(),
            verification_uri_complete: None,
            expires_in: 900,
            interval: 5,
        };
        assert!(!format!("{started:?}").contains("dc-secret"));
    }
}
