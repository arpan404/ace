//! A local stand-in for model gateways. It answers OpenAI Chat Completions and Anthropic
//! Messages, plain or streamed, with a fixed reply, and records every request it receives.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde_json::{Value, json};
use tokio::net::TcpListener;

/// A request the fake received.
#[derive(Debug, Clone)]
pub struct Seen {
    pub path: String,
    /// `Authorization` for OpenAI-style calls, `x-api-key` for Anthropic.
    pub key: Option<String>,
    pub body: Value,
}

#[derive(Clone)]
struct Shared {
    reply: Arc<String>,
    seen: Arc<Mutex<Vec<Seen>>>,
}

pub struct FakeProvider {
    pub root: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl FakeProvider {
    /// Starts a fake that answers every call with `reply`.
    pub async fn start(reply: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let shared = Shared {
            reply: Arc::new(reply.to_owned()),
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
    let stream = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    if let Ok(mut seen) = shared.seen.lock() {
        seen.push(Seen {
            path: path.clone(),
            key: if anthropic {
                header("x-api-key")
            } else {
                header("authorization")
            },
            body,
        });
    }
    let reply = shared.reply.as_str();
    match (anthropic, stream) {
        (false, false) => json_response(openai_reply(reply)),
        (false, true) => sse(&openai_stream(reply)),
        (true, false) => json_response(anthropic_reply(reply)),
        (true, true) => sse(&anthropic_stream(reply)),
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

fn sse(body: &str) -> Response {
    (
        StatusCode::OK,
        [("content-type", "text/event-stream")],
        body.to_owned(),
    )
        .into_response()
}

/// The reply split into two chunks, so streaming has more than one delta.
fn halves(reply: &str) -> (&str, &str) {
    let middle = reply
        .char_indices()
        .nth(reply.chars().count() / 2)
        .map_or(0, |(i, _)| i);
    reply.split_at(middle)
}

fn openai_reply(reply: &str) -> Value {
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
        "usage": { "prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18 }
    })
}

fn openai_stream(reply: &str) -> String {
    let (first, second) = halves(reply);
    let chunk = |content: &str| {
        json!({
            "id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0, "model": "fake",
            "choices": [{ "index": 0, "delta": { "content": content }, "finish_reason": null }]
        })
    };
    let stop = json!({
        "id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0, "model": "fake",
        "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
    });
    let usage = json!({
        "id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0, "model": "fake",
        "choices": [],
        "usage": { "prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18 }
    });
    [chunk(first), chunk(second), stop, usage]
        .iter()
        .map(|event| format!("data: {event}\n\n"))
        .chain(std::iter::once("data: [DONE]\n\n".to_owned()))
        .collect()
}

fn anthropic_reply(reply: &str) -> Value {
    json!({
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "fake",
        "content": [{ "type": "text", "text": reply }],
        "stop_reason": "end_turn",
        "stop_sequence": null,
        "usage": { "input_tokens": 11, "output_tokens": 7 }
    })
}

fn anthropic_stream(reply: &str) -> String {
    let (first, second) = halves(reply);
    let delta = |text: &str| json!({ "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": text } });
    let events = [
        (
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": "msg_1", "type": "message", "role": "assistant", "model": "fake",
                    "content": [], "stop_reason": null, "stop_sequence": null,
                    "usage": { "input_tokens": 11, "output_tokens": 0 }
                }
            }),
        ),
        (
            "content_block_start",
            json!({
                "type": "content_block_start", "index": 0, "content_block": { "type": "text", "text": "" }
            }),
        ),
        ("content_block_delta", delta(first)),
        ("content_block_delta", delta(second)),
        (
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": 0 }),
        ),
        (
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": "end_turn", "stop_sequence": null },
                "usage": { "output_tokens": 7 }
            }),
        ),
        ("message_stop", json!({ "type": "message_stop" })),
    ];
    events
        .iter()
        .map(|(name, data)| format!("event: {name}\ndata: {data}\n\n"))
        .collect()
}
