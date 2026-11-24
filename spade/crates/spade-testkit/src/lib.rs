//! Test-only helpers. `FakeProvider` stands in for a model endpoint: it answers OpenAI Chat
//! Completions, OpenAI Responses and Anthropic Messages, plain or streamed, following a
//! [`Script`] (or a sequence of them, one per request), and records every request it receives.
//! [`FakeConnector`] stands in for an app's remote MCP server and its OAuth server.

pub mod a2a;
mod anthropic;
pub mod chatgpt;
pub mod client_document;
pub mod cloud;
pub mod connector;
pub mod media;
mod models;
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

pub use a2a::FakeAgent;
pub use chatgpt::FakeSignIn;
pub use client_document::ClientDocument;
pub use cloud::FakeCloud;
pub use connector::FakeConnector;
pub use media::{FakeMedia, SPEECH_REST, SPEECH_START};
pub use models::FakeModelList;

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
    /// Pause before answering at all, streamed or plain.
    pub hold: Duration,
    /// Answer with this HTTP status instead.
    pub fail: Option<u16>,
    /// With `fail`, the `retry-after` header sent with it.
    pub retry_after: Option<String>,
    /// A plain (non-streamed) call is answered with exactly this JSON body.
    pub raw: Option<Value>,
    /// Input tokens reported as read from the cache, and as written to it.
    pub cache_read: u32,
    pub cache_write: u32,
    /// Tool calls made after the text.
    pub calls: Vec<FakeCall>,
    /// Thinking before the text, in order.
    pub thoughts: Vec<FakeThought>,
    /// Holds this answer before its first frame until the gate opens.
    pub gate: Option<Gate>,
}

/// A gate a scripted answer waits behind, so a test can hold a stream open and know exactly what
/// had, or had not, happened while it was held. One-shot: once open, it stays open.
#[derive(Debug, Clone)]
pub struct Gate {
    open: tokio::sync::watch::Sender<bool>,
    holding: tokio::sync::watch::Sender<bool>,
}

impl Default for Gate {
    fn default() -> Self {
        Self::new()
    }
}

impl Gate {
    pub fn new() -> Self {
        Self {
            open: tokio::sync::watch::channel(false).0,
            holding: tokio::sync::watch::channel(false).0,
        }
    }

    /// Holds an answer until [`Gate::open`], saying that something is being held.
    async fn hold(&self) {
        let _ = self.holding.send_replace(true);
        let mut open = self.open.subscribe();
        while !*open.borrow() {
            if open.changed().await.is_err() {
                return;
            }
        }
    }

    /// Lets every answer held behind it go.
    pub fn open(&self) {
        let _ = self.open.send_replace(true);
    }

    /// Waits until something is held behind it: the request has arrived and its answer waits.
    pub async fn holding(&self) {
        let mut holding = self.holding.subscribe();
        while !*holding.borrow() {
            if holding.changed().await.is_err() {
                return;
            }
        }
    }
}

impl Script {
    pub fn reply(text: &str) -> Self {
        Self {
            reply: text.to_owned(),
            plain: text.to_owned(),
            chunks: 2,
            delay: Duration::ZERO,
            hold: Duration::ZERO,
            fail: None,
            retry_after: None,
            raw: None,
            cache_read: 0,
            cache_write: 0,
            calls: Vec::new(),
            thoughts: Vec::new(),
            gate: None,
        }
    }

    /// Holds this answer before its first frame until `gate` opens: what a test needs to see the
    /// world while a stream has begun but its words have not arrived.
    pub fn gated(mut self, gate: Gate) -> Self {
        self.gate = Some(gate);
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

    /// Waits `pause` before answering, streamed or plain: a model slower than a timeout.
    pub fn held(mut self, pause: Duration) -> Self {
        self.hold = pause;
        self
    }

    pub fn failing(status: u16) -> Self {
        Self {
            fail: Some(status),
            ..Self::reply("")
        }
    }

    /// Answers a plain call with `body` as it is, for answers no other script builds (an
    /// endpoint's own web search).
    pub fn raw(body: Value) -> Self {
        Self {
            raw: Some(body),
            ..Self::reply("")
        }
    }

    /// With `failing`, asks the caller to wait this long (`retry-after`, in seconds).
    pub fn retry_after(mut self, seconds: &str) -> Self {
        self.retry_after = Some(seconds.to_owned());
        self
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
    /// When it arrived, for tests of what starts only after something else began.
    pub at: std::time::Instant,
}

#[derive(Clone)]
struct Shared {
    scripts: Arc<Vec<Script>>,
    next: Arc<AtomicUsize>,
    seen: Arc<Mutex<Vec<Seen>>>,
    /// With `start_turns`: how every plain (non-streamed) call is answered, so only the model's
    /// turns take the scripts.
    plain: Option<Arc<Script>>,
    /// With `start_routed`: a request whose body holds a route's words takes that route's next
    /// script (its last repeating), so work that runs side by side gets its own answers whatever
    /// order its calls arrive in. Routes are tried in order; the rest take `scripts`.
    routes: Arc<Vec<Route>>,
}

/// One route of [`FakeProvider::start_routed`].
pub struct Route {
    words: String,
    scripts: Vec<Script>,
    next: AtomicUsize,
}

impl Route {
    /// Requests whose body holds `words` take `scripts` in order.
    pub fn when(words: &str, scripts: Vec<Script>) -> Self {
        Self {
            words: words.to_owned(),
            scripts: if scripts.is_empty() {
                vec![Script::reply("")]
            } else {
                scripts
            },
            next: AtomicUsize::new(0),
        }
    }
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
        Self::serve(scripts, None).await
    }

    /// The Nth streamed request (a turn's model step) gets the Nth script, the last repeating;
    /// every plain request (a title, a summary) gets `plain`, whenever it comes.
    pub async fn start_turns(turns: Vec<Script>, plain: Script) -> Result<Self, Error> {
        Self::serve(turns, Some(plain)).await
    }

    /// Requests matching a route take its scripts; the rest take `scripts` in order.
    pub async fn start_routed(routes: Vec<Route>, scripts: Vec<Script>) -> Result<Self, Error> {
        Self::serve_routed(scripts, None, routes).await
    }

    async fn serve(scripts: Vec<Script>, plain: Option<Script>) -> Result<Self, Error> {
        Self::serve_routed(scripts, plain, Vec::new()).await
    }

    async fn serve_routed(
        scripts: Vec<Script>,
        plain: Option<Script>,
        routes: Vec<Route>,
    ) -> Result<Self, Error> {
        let shared = Shared {
            scripts: Arc::new(if scripts.is_empty() {
                vec![Script::reply("")]
            } else {
                scripts
            }),
            next: Arc::default(),
            seen: Arc::default(),
            plain: plain.map(Arc::new),
            routes: Arc::new(routes),
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
    let text = body.to_string();
    let routed = shared
        .routes
        .iter()
        .find(|route| text.contains(&route.words))
        .map(|route| {
            let index = route.next.fetch_add(1, Ordering::SeqCst);
            route.scripts[index.min(route.scripts.len() - 1)].clone()
        });
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
            at: std::time::Instant::now(),
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
    let script = match (&routed, &shared.plain, streamed) {
        (Some(routed), _, _) => routed,
        (None, Some(plain), false) => &**plain,
        _ => {
            let index = shared.next.fetch_add(1, Ordering::SeqCst);
            &shared.scripts[index.min(shared.scripts.len() - 1)]
        }
    };
    if let Some(status) = script.fail {
        let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        let error = json!({ "error": { "message": "fake endpoint failure", "type": "fake" } });
        let mut response = (
            status,
            [("content-type", "application/json")],
            error.to_string(),
        )
            .into_response();
        if let Some(wait) = script
            .retry_after
            .as_deref()
            .and_then(|wait| axum::http::HeaderValue::from_str(wait).ok())
        {
            response.headers_mut().insert("retry-after", wait);
        }
        return response;
    }
    if !script.hold.is_zero() {
        tokio::time::sleep(script.hold).await;
    }
    if let Some(gate) = &script.gate {
        gate.hold().await;
    }
    if let (Some(body), false) = (&script.raw, streamed) {
        return json_response(body.clone());
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
