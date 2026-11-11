//! Test-only helpers. `FakeProvider` stands in for a model endpoint: it answers OpenAI Chat
//! Completions, OpenAI Responses and Anthropic Messages, plain or streamed, following a
//! [`Script`] (or a sequence of them, one per request), and records every request it receives.

mod anthropic;
mod openai;
mod responses;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use futures_util::stream;
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// A tool call the fake makes.
#[derive(Debug, Clone)]
pub struct FakeCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

/// Thinking the fake does before it answers.
#[derive(Debug, Clone)]
pub enum FakeThought {
    /// Anthropic: a `thinking` block with its signature. OpenAI Chat: `reasoning_content`.
    Signed { thinking: String, signature: String },
    /// Anthropic: a `redacted_thinking` block.
    Redacted { data: String },
}

/// How the fake answers one request.
#[derive(Debug, Clone)]
pub struct Script {
    /// Streamed replies.
    pub reply: String,
    /// Plain (non-streamed) replies, such as typed output. Defaults to `reply`.
    pub plain: String,
    /// How many pieces a streamed reply arrives in.
    pub chunks: usize,
    /// Pause before each streamed piece.
    pub delay: Duration,
    /// Answer with this HTTP status instead.
    pub fail: Option<u16>,
    /// Input tokens reported as read from the cache, and as written to it.
    pub cache_read: u32,
    pub cache_write: u32,
    /// Tool calls made after the text.
    pub calls: Vec<FakeCall>,
    /// Thinking before the text, in order.
    pub thoughts: Vec<FakeThought>,
}

impl Script {
    pub fn reply(text: &str) -> Self {
        Self {
            reply: text.to_owned(),
            plain: text.to_owned(),
            chunks: 2,
            delay: Duration::ZERO,
            fail: None,
            cache_read: 0,
            cache_write: 0,
            calls: Vec::new(),
            thoughts: Vec::new(),
        }
    }

    pub fn plain(mut self, text: &str) -> Self {
        self.plain = text.to_owned();
        self
    }

    pub fn chunks(mut self, count: usize) -> Self {
        self.chunks = count.max(1);
        self
    }

    pub fn delay(mut self, pause: Duration) -> Self {
        self.delay = pause;
        self
    }

    pub fn failing(status: u16) -> Self {
        Self {
            fail: Some(status),
            ..Self::reply("")
        }
    }

    /// Reports `read` input tokens served from the cache and `write` written to it.
    pub fn cached(mut self, read: u32, write: u32) -> Self {
        self.cache_read = read;
        self.cache_write = write;
        self
    }

    /// Adds a tool call after the text.
    pub fn call(mut self, id: &str, name: &str, arguments: Value) -> Self {
        self.calls.push(FakeCall {
            id: id.to_owned(),
            name: name.to_owned(),
            arguments,
        });
        self
    }

    /// Adds a signed thinking block before the text.
    pub fn thinking(mut self, thinking: &str, signature: &str) -> Self {
        self.thoughts.push(FakeThought::Signed {
            thinking: thinking.to_owned(),
            signature: signature.to_owned(),
        });
        self
    }

    /// Adds a redacted thinking block before the text (Anthropic only).
    pub fn redacted(mut self, data: &str) -> Self {
        self.thoughts.push(FakeThought::Redacted {
            data: data.to_owned(),
        });
        self
    }

    fn pieces(&self) -> Vec<String> {
        let chars: Vec<char> = self.reply.chars().collect();
        if chars.is_empty() {
            return Vec::new();
        }
        let size = chars.len().div_ceil(self.chunks.max(1)).max(1);
        chars
            .chunks(size)
            .map(|piece| piece.iter().collect())
            .collect()
    }
}

/// A request the fake received.
#[derive(Debug, Clone)]
pub struct Seen {
    pub path: String,
    /// `Authorization` for OpenAI-style calls, `x-api-key` for Anthropic.
    pub key: Option<String>,
    pub headers: Vec<(String, String)>,
    pub body: Value,
}

#[derive(Clone)]
struct Shared {
    scripts: Arc<Vec<Script>>,
    next: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

pub struct FakeProvider {
    /// The fake's address, to use as an endpoint's base URL.
    pub root: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

type Error = Box<dyn std::error::Error + Send + Sync>;

impl FakeProvider {
    /// A fake that answers every call with `reply` in two streamed pieces.
    pub async fn start(reply: &str) -> Result<Self, Error> {
        Self::start_with(Script::reply(reply)).await
    }

    pub async fn start_with(script: Script) -> Result<Self, Error> {
        Self::start_sequence(vec![script]).await
    }

    /// The Nth request gets the Nth script; the last one repeats.
    pub async fn start_sequence(scripts: Vec<Script>) -> Result<Self, Error> {
        let shared = Shared {
            scripts: Arc::new(if scripts.is_empty() {
                vec![Script::reply("")]
            } else {
                scripts
            }),
            next: Arc::default(),
            seen: Arc::default(),
        };
        let app = Router::new()
            .route("/{*path}", post(answer))
            .with_state(shared.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address: SocketAddr = listener.local_addr()?;
        tokio::spawn(async move { axum::serve(listener, app).await });
        Ok(Self {
            root: format!("http://{address}/"),
            seen: shared.seen,
        })
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen
            .lock()
            .map(|seen| seen.clone())
            .unwrap_or_default()
    }
}

async fn answer(
    State(shared): State<Shared>,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned)
    };
    let path = uri.path().to_owned();
    let anthropic = path.ends_with("/messages");
    let responses = path.ends_with("/responses");
    let streamed = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if let Ok(mut seen) = shared.seen.lock() {
        seen.push(Seen {
            path: path.clone(),
            key: if anthropic {
                header("x-api-key")
            } else {
                header("authorization")
            },
            headers: headers
                .iter()
                .filter_map(|(k, v)| Some((k.as_str().to_owned(), v.to_str().ok()?.to_owned())))
                .collect(),
            body,
        });
    }
    let index = shared.next.fetch_add(1, Ordering::SeqCst);
    let script = &shared.scripts[index.min(shared.scripts.len() - 1)];
    if let Some(status) = script.fail {
        let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let error = json!({ "error": { "message": "fake endpoint failure", "type": "fake" } });
        return (
            status,
            [("content-type", "application/json")],
            error.to_string(),
        )
            .into_response();
    }
    let tokens = Tokens {
        read: script.cache_read,
        write: script.cache_write,
    };
    match (anthropic, responses, streamed) {
        (true, _, false) => json_response(anthropic::reply(script, tokens)),
        (true, _, true) => sse(anthropic::stream(script, tokens), script.delay),
        (false, true, false) => json_response(responses::reply(script, tokens)),
        (false, true, true) => sse(responses::stream(script, tokens), script.delay),
        (false, false, false) => json_response(openai::reply(script, tokens)),
        (false, false, true) => sse(openai::stream(script, tokens), script.delay),
    }
}

fn json_response(value: Value) -> Response {
    (
        StatusCode::OK,
        [("content-type", "application/json")],
        value.to_string(),
    )
        .into_response()
}

/// A server-sent event frame and whether it carries text (and so waits for `delay` first).
pub(crate) struct Frame {
    pub text: bool,
    pub data: String,
}

/// Sends `frames` as a server-sent event stream, pausing `delay` before each piece of text.
fn sse(frames: Vec<Frame>, delay: Duration) -> Response {
    let body = stream::unfold(frames.into_iter(), move |mut frames| async move {
        let frame = frames.next()?;
        if frame.text && !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        Some((Ok::<_, std::convert::Infallible>(frame.data), frames))
    });
    (
        StatusCode::OK,
        [("content-type", "text/event-stream")],
        Body::from_stream(body),
    )
        .into_response()
}

/// Cached input tokens to report: 11 input and 7 output tokens are always reported on top.
#[derive(Clone, Copy)]
pub(crate) struct Tokens {
    pub read: u32,
    pub write: u32,
}
