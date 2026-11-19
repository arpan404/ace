//! A bot's turns on the person's subscriptions (ADR 0133, docs/cli-brains.md): the daemon runs
//! them in the bot's hidden provider session. Spade calls `<daemon>/spade/brains/*` with its
//! grant; a turn answers as JSON lines until it ends, and dropping the stream interrupts it.

use std::time::Duration;

use futures_util::{Stream, StreamExt};
use serde::{Deserialize, Serialize};

use crate::config::ToolsConfig;
use spade_mcp::Secret;

/// The longest a subscriptions listing may take.
const LIST_TIMEOUT: Duration = Duration::from_secs(10);
/// The most one JSON line of a turn may hold.
const MOST_LINE_BYTES: usize = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BrainError {
    /// ace isn't answering, or refused Spade's grant. The turn did not start.
    #[error("ace isn't reachable: {0}")]
    Unreachable(String),
    /// The answer stopped before the turn ended (ace went away mid-turn).
    #[error("ace stopped answering before the turn ended")]
    Cut,
    #[error("ace's answer could not be read: {0}")]
    Unreadable(String),
}

/// One turn, as the daemon takes it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnRequest {
    pub bot: String,
    pub provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub model: String,
    pub instructions: String,
    pub instructions_changed: bool,
    pub message: String,
}

/// Why a turn on a subscription failed (the daemon's reasons).
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Failure {
    NotInstalled,
    SignedOut,
    RateLimited,
    Quota,
    NeedsPermission,
    Unavailable,
    Failed,
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
}

/// One line of a turn's answer; the last is [`Frame::Finished`] or [`Frame::Failed`].
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Frame {
    Session {
        thread: String,
        fresh: bool,
    },
    Text {
        text: String,
    },
    Status {
        status: Option<String>,
    },
    /// The CLI read outside text with its own tools (`source`, such as "the web").
    Read {
        source: String,
    },
    Finished {
        usage: Usage,
    },
    Failed {
        reason: Failure,
        message: String,
    },
    /// A frame a newer daemon sends that this Spade does not know: kept, never fatal.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Subscription {
    pub provider: String,
    pub name: String,
    pub accounts: Vec<SubscriptionAccount>,
    pub models: Vec<SubscriptionModel>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SubscriptionAccount {
    pub id: String,
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct SubscriptionModel {
    pub id: String,
    pub name: String,
}

#[derive(Deserialize)]
struct Listing {
    providers: Vec<Subscription>,
}

/// Spade's client for the daemon's brain service, made from the same config as its ace tools.
#[derive(Clone)]
pub struct AceBrains {
    base: String,
    grant: Secret,
    http: reqwest::Client,
}

impl AceBrains {
    /// From the daemon's MCP address (`http://127.0.0.1:PORT/mcp`) and Spade's grant.
    pub fn new(tools: &ToolsConfig) -> Self {
        let url = tools.url().as_str();
        let base = url.strip_suffix("/mcp").unwrap_or(url).to_owned();
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .unwrap_or_default();
        Self {
            base,
            grant: tools.token().clone(),
            http,
        }
    }

    /// The providers, accounts and models a bot can think with now.
    pub async fn subscriptions(&self) -> Result<Vec<Subscription>, BrainError> {
        let response = self
            .http
            .get(format!("{}/spade/brains/subscriptions", self.base))
            .bearer_auth(self.grant.expose())
            .timeout(LIST_TIMEOUT)
            .send()
            .await
            .map_err(|e| BrainError::Unreachable(self.grant.scrub(e.to_string())))?;
        if !response.status().is_success() {
            return Err(BrainError::Unreachable(format!(
                "ace answered {}",
                response.status().as_u16()
            )));
        }
        let listing: Listing = response
            .json()
            .await
            .map_err(|e| BrainError::Unreadable(e.to_string()))?;
        Ok(listing.providers)
    }

    /// Starts a turn and streams its frames. Dropping the stream closes the request, which
    /// interrupts the CLI's turn.
    pub async fn turn(
        &self,
        request: &TurnRequest,
    ) -> Result<impl Stream<Item = Result<Frame, BrainError>> + Send + use<>, BrainError> {
        let response = self
            .http
            .post(format!("{}/spade/brains/turn", self.base))
            .bearer_auth(self.grant.expose())
            .json(request)
            .send()
            .await
            .map_err(|e| BrainError::Unreachable(self.grant.scrub(e.to_string())))?;
        if !response.status().is_success() {
            return Err(BrainError::Unreachable(format!(
                "ace answered {}",
                response.status().as_u16()
            )));
        }
        Ok(lines(response.bytes_stream()))
    }
}

/// JSON lines from a byte stream, one frame each; ending before a last frame is [`BrainError::Cut`].
fn lines<S, B, E>(bytes: S) -> impl Stream<Item = Result<Frame, BrainError>> + Send
where
    S: Stream<Item = Result<B, E>> + Send + Unpin + 'static,
    B: AsRef<[u8]>,
    E: std::fmt::Display,
{
    futures_util::stream::unfold(
        (bytes, Vec::<u8>::new(), false),
        |(mut bytes, mut buffer, ended)| async move {
            if ended {
                return None;
            }
            loop {
                if let Some(at) = buffer.iter().position(|b| *b == b'\n') {
                    let line: Vec<u8> = buffer.drain(..=at).collect();
                    let line = &line[..line.len() - 1];
                    if line.iter().all(u8::is_ascii_whitespace) {
                        continue;
                    }
                    let frame = serde_json::from_slice::<Frame>(line)
                        .map_err(|e| BrainError::Unreadable(e.to_string()));
                    let last = matches!(frame, Ok(Frame::Finished { .. } | Frame::Failed { .. }))
                        || frame.is_err();
                    return Some((frame, (bytes, buffer, last)));
                }
                if buffer.len() > MOST_LINE_BYTES {
                    let error = Err(BrainError::Unreadable("a line was too long".to_owned()));
                    return Some((error, (bytes, buffer, true)));
                }
                match bytes.next().await {
                    Some(Ok(chunk)) => buffer.extend_from_slice(chunk.as_ref()),
                    Some(Err(_)) | None => {
                        return Some((Err(BrainError::Cut), (bytes, buffer, true)));
                    }
                }
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn frames(chunks: &[&str]) -> Vec<Result<Frame, BrainError>> {
        let owned: Vec<Result<Vec<u8>, String>> =
            chunks.iter().map(|c| Ok(c.as_bytes().to_vec())).collect();
        lines(futures_util::stream::iter(owned)).collect().await
    }

    #[tokio::test]
    async fn a_turn_reads_lines_split_anywhere_and_stops_at_its_end() {
        let read = frames(&[
            "{\"type\":\"session\",\"thread\":\"t\",\"fresh\":true}\n{\"type\":\"te",
            "xt\",\"text\":\"Hi\"}\n{\"type\":\"newer\"}\n",
            "{\"type\":\"finished\",\"usage\":{\"input\":3,\"output\":2}}\n{\"type\":\"text\",\"text\":\"late\"}\n",
        ])
        .await;
        assert_eq!(
            read,
            vec![
                Ok(Frame::Session {
                    thread: "t".into(),
                    fresh: true
                }),
                Ok(Frame::Text { text: "Hi".into() }),
                Ok(Frame::Unknown),
                Ok(Frame::Finished {
                    usage: Usage {
                        input: 3,
                        output: 2
                    }
                }),
            ]
        );
    }

    #[tokio::test]
    async fn an_answer_that_stops_before_its_end_is_cut() {
        let read = frames(&["{\"type\":\"text\",\"text\":\"Hi\"}\n"]).await;
        assert_eq!(
            read,
            vec![Ok(Frame::Text { text: "Hi".into() }), Err(BrainError::Cut)]
        );
    }
}
