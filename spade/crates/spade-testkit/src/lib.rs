//! Test-only helpers. `FakeProvider` stands in for a model endpoint: it answers OpenAI Chat
//! Completions, OpenAI Responses and Anthropic Messages, plain or streamed, following a
//! [`Script`], and records every request it receives.

use std::net::SocketAddr;
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

/// How the fake answers.
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
    /// Answer every call with this HTTP status instead.
    pub fail: Option<u16>,
    /// Input tokens reported as read from the cache, and as written to it.
    pub cache_read: u32,
    pub cache_write: u32,
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
        }
    }

    /// Reports `read` input tokens served from the cache and `write` written to it.
    pub fn cached(mut self, read: u32, write: u32) -> Self {
        self.cache_read = read;
        self.cache_write = write;
        self
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
    script: Arc<Script>,
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
        let shared = Shared {
            script: Arc::new(script),
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
    let script = &shared.script;
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
    let pieces = split(&script.reply, script.chunks);
    let usage = Tokens {
        read: script.cache_read,
        write: script.cache_write,
    };
    match (anthropic, responses, streamed) {
        (true, _, false) => json_response(anthropic_reply(&script.plain, usage)),
        (true, _, true) => sse(anthropic_stream(&pieces, usage), script.delay),
        (false, true, false) => json_response(responses_reply(&script.plain, usage)),
        (false, true, true) => sse(responses_stream(&pieces, usage), script.delay),
        (false, false, false) => json_response(openai_reply(&script.plain, usage)),
        (false, false, true) => sse(openai_stream(&pieces, usage), script.delay),
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

/// Sends `events` as a server-sent event stream, pausing `delay` before each piece of text.
fn sse(events: Vec<(bool, String)>, delay: Duration) -> Response {
    let body = stream::unfold(events.into_iter(), move |mut events| async move {
        let (is_text, frame) = events.next()?;
        if is_text && !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        Some((Ok::<_, std::convert::Infallible>(frame), events))
    });
    (
        StatusCode::OK,
        [("content-type", "text/event-stream")],
        Body::from_stream(body),
    )
        .into_response()
}

/// `reply` cut into `count` pieces of about equal length (by characters).
fn split(reply: &str, count: usize) -> Vec<String> {
    let chars: Vec<char> = reply.chars().collect();
    let size = chars.len().div_ceil(count.max(1)).max(1);
    chars
        .chunks(size)
        .map(|piece| piece.iter().collect())
        .collect()
}

/// Cached input tokens to report: 11 input and 7 output tokens are always reported on top.
#[derive(Clone, Copy)]
struct Tokens {
    read: u32,
    write: u32,
}

impl Tokens {
    /// OpenAI counts cached tokens inside `prompt_tokens`.
    fn openai(self) -> Value {
        json!({
            "prompt_tokens": 11 + self.read, "completion_tokens": 7,
            "total_tokens": 18 + self.read,
            "prompt_tokens_details": { "cached_tokens": self.read }
        })
    }

    fn responses(self) -> Value {
        json!({
            "input_tokens": 11 + self.read, "output_tokens": 7, "total_tokens": 18 + self.read,
            "input_tokens_details": { "cached_tokens": self.read }
        })
    }

    /// Anthropic reports uncached input apart from cache reads and writes.
    fn anthropic(self) -> Value {
        json!({
            "input_tokens": 11, "output_tokens": 7,
            "cache_read_input_tokens": self.read, "cache_creation_input_tokens": self.write
        })
    }
}

fn openai_reply(reply: &str, tokens: Tokens) -> Value {
    json!({
        "id": "chatcmpl-1",
        "object": "chat.completion",
        "created": 0,
        "model": "fake",
        "choices": [{
            "index": 0,
            "message": { "role": "assistant", "content": reply },
            "finish_reason": "stop"
        }],
        "usage": tokens.openai()
    })
}

/// `(is_text, frame)` pairs.
fn openai_stream(pieces: &[String], tokens: Tokens) -> Vec<(bool, String)> {
    let frame = |value: Value| format!("data: {value}\n\n");
    let mut frames: Vec<(bool, String)> = pieces
        .iter()
        .map(|content| {
            (
                true,
                frame(json!({
                    "id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0,
                    "model": "fake",
                    "choices": [{ "index": 0, "delta": { "content": content }, "finish_reason": null }]
                })),
            )
        })
        .collect();
    frames.push((
        false,
        frame(json!({
            "id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0, "model": "fake",
            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
        })),
    ));
    frames.push((
        false,
        frame(json!({
            "id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0, "model": "fake",
            "choices": [],
            "usage": tokens.openai()
        })),
    ));
    frames.push((false, "data: [DONE]\n\n".to_owned()));
    frames
}

fn anthropic_reply(reply: &str, tokens: Tokens) -> Value {
    json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "fake",
        "content": [{ "type": "text", "text": reply }],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": tokens.anthropic()
    })
}

fn anthropic_stream(pieces: &[String], tokens: Tokens) -> Vec<(bool, String)> {
    let frame = |name: &str, data: Value| format!("event: {name}\ndata: {data}\n\n");
    let mut frames = vec![
        (
            false,
            frame(
                "message_start",
                json!({
                    "type": "message_start",
                    "message": {
                        "id": "msg_1", "type": "message", "role": "assistant", "model": "fake",
                        "content": [], "stop_reason": null, "stop_sequence": null,
                        "usage": { "input_tokens": 11, "output_tokens": 0,
                                   "cache_read_input_tokens": tokens.read,
                                   "cache_creation_input_tokens": tokens.write }
                    }
                }),
            ),
        ),
        (
            false,
            frame(
                "content_block_start",
                json!({ "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" } }),
            ),
        ),
    ];
    for text in pieces {
        frames.push((
            true,
            frame(
                "content_block_delta",
                json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": text } }),
            ),
        ));
    }
    frames.push((
        false,
        frame(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 0 }),
        ),
    ));
    frames.push((
        false,
        frame(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn", "stop_sequence": null },
                "usage": { "output_tokens": 7 }
            }),
        ),
    ));
    frames.push((
        false,
        frame("message_stop", json!({ "type": "message_stop" })),
    ));
    frames
}

fn responses_message(text: &str) -> Value {
    json!({
        "type": "message", "id": "msg_1", "status": "completed", "role": "assistant",
        "content": [{ "type": "output_text", "text": text, "annotations": [] }]
    })
}

fn responses_reply(reply: &str, tokens: Tokens) -> Value {
    json!({
        "id": "resp_1", "object": "response", "status": "completed", "model": "fake",
        "output": [responses_message(reply)],
        "usage": tokens.responses()
    })
}

fn responses_stream(pieces: &[String], tokens: Tokens) -> Vec<(bool, String)> {
    let frame = |name: &str, data: Value| format!("event: {name}\ndata: {data}\n\n");
    let full: String = pieces.concat();
    let mut frames = vec![(
        false,
        frame(
            "response.created",
            json!({ "type": "response.created",
                    "response": { "id": "resp_1", "status": "in_progress", "model": "fake", "output": [] } }),
        ),
    )];
    for text in pieces {
        frames.push((
            true,
            frame(
                "response.output_text.delta",
                json!({ "type": "response.output_text.delta", "output_index": 0,
                        "content_index": 0, "delta": text }),
            ),
        ));
    }
    frames.push((
        false,
        frame(
            "response.completed",
            json!({ "type": "response.completed",
                    "response": { "id": "resp_1", "status": "completed", "model": "fake",
                                  "output": [responses_message(&full)], "usage": tokens.responses() } }),
        ),
    ));
    frames
}
