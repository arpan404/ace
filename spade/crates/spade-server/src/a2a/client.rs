//! Reaching an outside A2A agent (A2A 1.0.1, JSON-RPC binding): its card and its publisher's
//! keys, and `SendMessage`, `GetTask` and `CancelTask`. Every request is held to the connectors'
//! address rules (`spade_connect::oauth::Net`): https, every address its name resolves to public
//! and not this machine's, and the request connects only to the addresses checked (no proxy, no
//! second lookup), so a card, a key set or a task call can't be pointed into the local network by
//! DNS. Only an agent the person added as local (on their own machine or network) may reach local
//! or private addresses, or plain http on loopback; nothing a card says decides it. Redirects are
//! refused, and answers are counted as they arrive and cut off at 256 KiB.

use std::time::Duration;

use reqwest::{StatusCode, Url};
use serde_json::{Value, json};
use spade_connect::Addresses;
use spade_connect::oauth::{Net, wellknown};

use super::card::VERSION;

/// The most an answer (a card, a key set, a task) may be.
pub const MOST_BYTES: usize = 256 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);
const TOO_LARGE: &str = "Its answer is larger than 256 KiB.";

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

/// Where an agent's card is: the address itself when it names the card, or the spec's
/// well-known path on its origin. Whether it may be reached is checked when it is fetched.
pub fn card_address(address: &str) -> Result<Url, String> {
    let url = wellknown::checked(address)?;
    if url.path().ends_with(".json") {
        return Ok(url);
    }
    url.join("/.well-known/agent-card.json")
        .map_err(|e| e.to_string())
}

/// Whether `jku` is on the same origin as the card it came with: only a key the card's own
/// publisher serves vouches for it.
pub fn same_origin(card: &Url, jku: &str) -> Option<Url> {
    let jku = wellknown::checked(jku).ok()?;
    (jku.origin() == card.origin()).then_some(jku)
}

#[derive(Clone)]
pub struct A2aClient {
    addresses: Addresses,
    timeout: Duration,
}

impl A2aClient {
    /// A client resolving names with `addresses` (the system's in Spade, a test's own in tests).
    pub fn new(addresses: Addresses) -> Self {
        Self {
            addresses,
            timeout: TIMEOUT,
        }
    }

    fn net(&self, local: bool) -> Net {
        self.addresses.for_connector(local, self.timeout)
    }

    /// Whether `url` may be reached for an agent added as `local` or not: its scheme, and every
    /// address its name resolves to.
    pub async fn check(&self, url: &str, local: bool) -> Result<Url, String> {
        self.net(local)
            .check(url)
            .await
            .map(|(url, _)| url)
            .map_err(|e| e.to_string())
    }

    /// The answer's JSON, read only while it stays within [`MOST_BYTES`]: a larger one is cut off
    /// as it arrives, never held whole.
    async fn body(mut response: reqwest::Response) -> Result<Value, String> {
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
            return Err(TOO_LARGE.to_owned());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > MOST_BYTES {
                return Err(TOO_LARGE.to_owned());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "Its answer isn't JSON.".to_owned())
    }

    /// A JSON document at `url` (a card or a key set), for an agent added as `local` or not.
    pub async fn document(&self, url: &Url, local: bool) -> Result<Value, String> {
        let (http, url) = self
            .net(local)
            .client(url.as_str())
            .await
            .map_err(|e| e.to_string())?;
        let response = http
            .get(url)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("It couldn't be reached: {e}"))?;
        Self::body(response).await
    }

    /// One JSON-RPC request to `endpoint` of an agent added as `local` or not: its `result`.
    pub async fn call(
        &self,
        endpoint: &str,
        local: bool,
        method: &str,
        params: Value,
    ) -> Result<Value, Unreached> {
        let (http, url) = self
            .net(local)
            .client(endpoint)
            .await
            .map_err(|e| Unreached::NotSent(e.to_string()))?;
        let request = json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
        let sent = http
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

#[cfg(test)]
mod tests;
