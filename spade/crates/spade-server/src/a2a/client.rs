//! Reaching an outside A2A agent (A2A 1.0.1, JSON-RPC binding): its card and its publisher's
//! keys, and `SendMessage`, `GetTask` and `CancelTask`. Over https only (or plain http to this
//! machine's loopback, for an agent the person runs locally), redirects refused, answers bounded.

use std::time::Duration;

use reqwest::{Client, StatusCode, Url};
use serde_json::{Value, json};

use super::card::VERSION;

/// The most an answer (a card, a key set, a task) may be.
const MOST_BYTES: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

/// Why an agent couldn't be reached or answered badly.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Unreached {
    /// Nothing was sent, or the request was refused before it ran: safe to send again.
    #[error("{0}")]
    NotSent(String),
    /// Sent, and the answer was lost or unreadable: it may have run.
    #[error("{0}")]
    Unknown(String),
    /// The agent answered with a JSON-RPC error.
    #[error("{message}")]
    Refused { code: i64, message: String },
}

/// Whether `url` may be called: https anywhere, http only on loopback.
pub fn allowed(url: &str) -> Result<Url, String> {
    let url = Url::parse(url).map_err(|_| format!("{url} isn't an address"))?;
    let host = url.host_str().unwrap_or_default();
    let loopback = host == "localhost"
        || host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    match url.scheme() {
        "https" => Ok(url),
        "http" if loopback => Ok(url),
        _ => Err("Spade reaches agents over https only.".to_owned()),
    }
}

/// Where an agent's card is: the address itself when it names the card, or the spec's
/// well-known path on its origin.
pub fn card_address(address: &str) -> Result<Url, String> {
    let url = allowed(address.trim())?;
    if url.path().ends_with(".json") {
        return Ok(url);
    }
    url.join("/.well-known/agent-card.json")
        .map_err(|e| e.to_string())
}

/// Whether `jku` is on the same origin as the card it came with: only a key the card's own
/// publisher serves vouches for it.
pub fn same_origin(card: &Url, jku: &str) -> Option<Url> {
    let jku = allowed(jku).ok()?;
    (jku.origin() == card.origin()).then_some(jku)
}

#[derive(Clone)]
pub struct A2aClient {
    http: Client,
}

impl Default for A2aClient {
    fn default() -> Self {
        Self::new()
    }
}

impl A2aClient {
    pub fn new() -> Self {
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(TIMEOUT)
            .build()
            .unwrap_or_default();
        Self { http }
    }

    async fn body(response: reqwest::Response) -> Result<Value, String> {
        if response.status().is_redirection() {
            return Err("It answered with a redirect, which Spade doesn't follow.".to_owned());
        }
        if response.status() != StatusCode::OK {
            return Err(format!("It answered {}.", response.status()));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MOST_BYTES as u64)
        {
            return Err("Its answer is larger than 256 KiB.".to_owned());
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() > MOST_BYTES {
            return Err("Its answer is larger than 256 KiB.".to_owned());
        }
        serde_json::from_slice(&bytes).map_err(|_| "Its answer isn't JSON.".to_owned())
    }

    /// A JSON document at `url` (a card or a key set).
    pub async fn document(&self, url: &Url) -> Result<Value, String> {
        let response = self
            .http
            .get(url.clone())
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("It couldn't be reached: {e}"))?;
        Self::body(response).await
    }

    /// One JSON-RPC request to `endpoint`: its `result`.
    pub async fn call(
        &self,
        endpoint: &str,
        method: &str,
        params: Value,
    ) -> Result<Value, Unreached> {
        let url = allowed(endpoint).map_err(Unreached::NotSent)?;
        let request = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let sent = self
            .http
            .post(url)
            .header("A2A-Version", VERSION)
            .json(&request)
            .send()
            .await;
        let response = match sent {
            Ok(response) => response,
            Err(error) if error.is_connect() => {
                return Err(Unreached::NotSent(format!(
                    "It couldn't be reached: {error}"
                )));
            }
            Err(error) => return Err(Unreached::Unknown(error.to_string())),
        };
        let answer = Self::body(response).await.map_err(Unreached::Unknown)?;
        if let Some(error) = answer.get("error") {
            return Err(Unreached::Refused {
                code: error["code"].as_i64().unwrap_or_default(),
                message: error["message"]
                    .as_str()
                    .unwrap_or("it refused")
                    .chars()
                    .take(400)
                    .collect(),
            });
        }
        answer
            .get("result")
            .cloned()
            .ok_or_else(|| Unreached::Unknown("Its answer has no result.".to_owned()))
    }
}
