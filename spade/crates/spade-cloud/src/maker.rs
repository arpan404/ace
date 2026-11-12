//! Requests to an app maker's token endpoint, as the cloud's client with its secret: exchanging a
//! code and refreshing. The answer is passed on to Spade as the maker's JSON, cut to the fields a
//! token response has, and is never logged or kept.

use std::time::Duration;

use serde_json::{Map, Value};

use crate::apps::{App, Client, ClientAuth};

/// The fields of a token response (RFC 6749 section 5.1, plus OpenID's `id_token`) passed on.
const TOKEN_FIELDS: [&str; 6] = [
    "access_token",
    "token_type",
    "expires_in",
    "refresh_token",
    "scope",
    "id_token",
];
const MOST_ANSWER_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MakerError {
    /// The maker refused the code or the refresh token: the person must sign in again.
    #[error("the app refused")]
    Refused,
    /// The maker couldn't be reached or answered something unusable.
    #[error("the app's sign-in server didn't answer usably")]
    Upstream,
}

pub struct Maker {
    http: reqwest::Client,
}

impl Maker {
    pub fn new(timeout: Duration) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .build()
            .unwrap_or_default();
        Self { http }
    }

    /// The authorization code grant with PKCE, back to `redirect`.
    pub async fn exchange(
        &self,
        app: &App,
        client: &Client,
        code: &str,
        verifier: &str,
        redirect: &str,
    ) -> Result<Vec<u8>, MakerError> {
        let form = vec![
            ("grant_type", "authorization_code".to_owned()),
            ("code", code.to_owned()),
            ("redirect_uri", redirect.to_owned()),
            ("code_verifier", verifier.to_owned()),
            ("resource", app.resource.clone()),
        ];
        self.token(app, client, form).await
    }

    pub async fn refresh(
        &self,
        app: &App,
        client: &Client,
        refresh_token: &str,
    ) -> Result<Vec<u8>, MakerError> {
        let form = vec![
            ("grant_type", "refresh_token".to_owned()),
            ("refresh_token", refresh_token.to_owned()),
            ("resource", app.resource.clone()),
        ];
        self.token(app, client, form).await
    }

    async fn token(
        &self,
        app: &App,
        client: &Client,
        mut form: Vec<(&'static str, String)>,
    ) -> Result<Vec<u8>, MakerError> {
        let mut request = self
            .http
            .post(&app.token_endpoint)
            .header("accept", "application/json");
        match app.client_auth {
            ClientAuth::ClientSecretBasic => {
                request = request.basic_auth(encode(&client.id), Some(encode(&client.secret)));
            }
            ClientAuth::ClientSecretPost => {
                form.push(("client_id", client.id.clone()));
                form.push(("client_secret", client.secret.clone()));
            }
        }
        // Only the status is ever looked at on failure: an error's text may quote the request.
        let response = request
            .form(&form)
            .send()
            .await
            .map_err(|_| MakerError::Upstream)?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|_| MakerError::Upstream)?;
        if status == reqwest::StatusCode::BAD_REQUEST || status == reqwest::StatusCode::UNAUTHORIZED
        {
            return Err(MakerError::Refused);
        }
        if !status.is_success() || bytes.len() > MOST_ANSWER_BYTES {
            return Err(MakerError::Upstream);
        }
        token_response(&bytes)
    }
}

/// The token fields of a successful answer, as JSON. One without an access token is unusable.
fn token_response(bytes: &[u8]) -> Result<Vec<u8>, MakerError> {
    let Ok(Value::Object(answer)) = serde_json::from_slice::<Value>(bytes) else {
        return Err(MakerError::Upstream);
    };
    if answer
        .get("access_token")
        .and_then(Value::as_str)
        .is_none_or(str::is_empty)
    {
        return Err(MakerError::Upstream);
    }
    let kept: Map<String, Value> = answer
        .into_iter()
        .filter(|(key, _)| TOKEN_FIELDS.contains(&key.as_str()))
        .collect();
    serde_json::to_vec(&Value::Object(kept)).map_err(|_| MakerError::Upstream)
}

/// RFC 6749 section 2.3.1: the client ID and secret are form-encoded before Basic.
fn encode(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_token_fields_are_passed_on_and_an_answer_without_a_token_is_unusable() {
        let kept = token_response(
            br#"{"access_token":"a","refresh_token":"r","expires_in":60,"user":{"email":"x"},"token_type":"bearer"}"#,
        )
        .unwrap_or_default();
        let kept: Value = serde_json::from_slice(&kept).unwrap_or_default();
        assert_eq!(
            kept,
            serde_json::json!({"access_token":"a","refresh_token":"r","expires_in":60,"token_type":"bearer"})
        );
        assert_eq!(
            token_response(br#"{"error":"x"}"#),
            Err(MakerError::Upstream)
        );
        assert_eq!(token_response(b"<html>"), Err(MakerError::Upstream));
    }
}
