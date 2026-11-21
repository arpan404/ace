//! The HTTP client under the MCP transport. Every request goes through the SDK's own reqwest
//! client except `tools/call`, which this sends itself so that:
//!
//! - the answer's raw JSON goes straight to the call that asked (the SDK's typed content drops
//!   fields it doesn't know), and
//! - a 404 for an expired session comes back as `SessionExpired` and nothing is replayed.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures_util::{StreamExt, TryStreamExt};
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderName, HeaderValue};
use rmcp::model::{ClientJsonRpcMessage, ServerJsonRpcMessage};
use rmcp::transport::streamable_http_client::{
    SseError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
};
use serde_json::Value;
use sse_stream::{Sse, SseStream};
use tokio::sync::{oneshot, watch};

use crate::ask::Asker;

const SESSION_HEADER: &str = "Mcp-Session-Id";
/// The most bytes one `tools/call` answer may take, as JSON or as an event stream.
const MOST_ANSWER_BYTES: usize = 32 * 1024 * 1024;
/// The `_meta` key carrying a call's route token, so its POST knows where its answer goes.
pub(crate) const ROUTE_KEY: &str = "dev.acehq.spade/call";

/// One session's calls waiting for their raw answers, by route token. A token is never reused,
/// and the table belongs to one session, so an answer can only reach the call that asked.
#[derive(Clone, Default)]
pub(crate) struct CallRoutes(Arc<Mutex<Table>>);

#[derive(Default)]
struct Table {
    answers: HashMap<u64, oneshot::Sender<Value>>,
    /// The calls that may ask the person, by route token.
    askers: HashMap<u64, Asking>,
    /// A server's request (by its JSON-RPC id as JSON text) sent on a call's own answer stream:
    /// it belongs to that call.
    related: HashMap<String, u64>,
}

/// A call that may ask the person: who shows its forms, and how many are open now.
#[derive(Clone)]
pub(crate) struct Asking {
    pub(crate) asker: Arc<dyn Asker>,
    pub(crate) open: Arc<watch::Sender<usize>>,
}

impl CallRoutes {
    /// Registers `token` before its call is sent. The answer arrives on the receiver.
    pub(crate) fn register(&self, token: u64) -> oneshot::Receiver<Value> {
        let (tx, rx) = oneshot::channel();
        lock(&self.0).answers.insert(token, tx);
        rx
    }

    /// Lets `token`'s call ask the person through `asker`. The receiver counts its open forms.
    pub(crate) fn asking(&self, token: u64, asker: Arc<dyn Asker>) -> watch::Receiver<usize> {
        let open = Arc::new(watch::channel(0).0);
        let counted = open.subscribe();
        lock(&self.0).askers.insert(token, Asking { asker, open });
        counted
    }

    pub(crate) fn forget(&self, token: u64) {
        let mut table = lock(&self.0);
        table.answers.remove(&token);
        table.askers.remove(&token);
        table.related.retain(|_, call| *call != token);
    }

    fn deliver(&self, token: u64, envelope: Value) {
        if let Some(waiter) = lock(&self.0).answers.remove(&token) {
            let _ = waiter.send(envelope);
        }
    }

    fn relate(&self, request: String, token: u64) {
        lock(&self.0).related.insert(request, token);
    }

    /// Who may answer the server's request `id` for the person: the call whose answer stream it
    /// came on, else the one call in flight that may ask. `None` when no call may, or several
    /// may and the request names none of them.
    pub(crate) fn asker_for(&self, id: &str) -> Option<Asking> {
        let table = lock(&self.0);
        if let Some(token) = table.related.get(id) {
            return table.askers.get(token).cloned();
        }
        let mut askers = table.askers.values();
        match (askers.next(), askers.next()) {
            (Some(only), None) => Some(only.clone()),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub(crate) struct RawKeeping {
    inner: reqwest::Client,
    routes: CallRoutes,
}

impl RawKeeping {
    /// No redirects (a redirect could carry a call and its session elsewhere, or send it twice).
    /// `direct` skips any proxy, for a server on this machine.
    pub(crate) fn new(routes: CallRoutes, direct: bool) -> Result<Self, reqwest::Error> {
        let mut builder = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none());
        if direct {
            builder = builder.no_proxy();
        }
        let inner = builder.build()?;
        Ok(Self { inner, routes })
    }

    async fn call(
        &self,
        uri: &str,
        message: ClientJsonRpcMessage,
        (id, token): (String, Option<u64>),
        session_id: Option<Arc<str>>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<reqwest::Error>> {
        let body = serde_json::to_vec(&message)?;
        let mut request = self
            .inner
            .post(uri)
            .header(ACCEPT, "text/event-stream, application/json")
            .header(CONTENT_TYPE, "application/json");
        if let Some(token) = auth_token {
            request = request.bearer_auth(token);
        }
        for (name, value) in custom_headers {
            request = request.header(name, value);
        }
        if let Some(session) = session_id.as_deref() {
            request = request.header(SESSION_HEADER, session);
        }
        let response = request
            .body(body)
            .send()
            .await
            .map_err(StreamableHttpError::Client)?;
        let status = response.status();
        if status == reqwest::StatusCode::ACCEPTED || status == reqwest::StatusCode::NO_CONTENT {
            return Ok(StreamableHttpPostResponse::Accepted);
        }
        // The session is gone and the request never reached a handler: it did not run.
        if status == reqwest::StatusCode::NOT_FOUND && session_id.is_some() {
            return Err(StreamableHttpError::SessionExpired);
        }
        // Never followed; the call did not reach a tool.
        if status.is_redirection() {
            return Err(StreamableHttpError::UnexpectedServerResponse(
                format!("HTTP {status}: a redirect, not followed").into(),
            ));
        }
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            return Err(StreamableHttpError::UnexpectedServerResponse(
                format!("HTTP {status}").into(),
            ));
        }
        let session = response
            .headers()
            .get(SESSION_HEADER)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        if status.is_success() && content_type.as_deref().is_some_and(is_event_stream) {
            let routes = self.routes.clone();
            let bytes = bounded(response.bytes_stream());
            let events = SseStream::from_bytes_stream(bytes).map(move |event| {
                if let Ok(Sse {
                    data: Some(data), ..
                }) = &event
                    && let Ok(message) = serde_json::from_str::<Value>(data)
                    && let Some(token) = token
                {
                    let request = message.get("id").map(Value::to_string);
                    if message.get("method").is_some() {
                        // The server asks something on this call's stream: it is this call's.
                        if let Some(request) = request {
                            routes.relate(request, token);
                        }
                    } else if request.as_deref() == Some(id.as_str()) {
                        routes.deliver(token, message);
                    }
                }
                event
            });
            let events: futures_util::stream::BoxStream<'static, Result<Sse, SseError>> =
                events.boxed();
            return Ok(StreamableHttpPostResponse::Sse(events, session));
        }
        let body = read_bounded(response).await?;
        let parsed = serde_json::from_slice::<Value>(&body).ok();
        match (parsed, content_type.as_deref().is_some_and(is_json)) {
            (Some(message), true) => {
                let typed = serde_json::from_value::<ServerJsonRpcMessage>(message.clone())?;
                if let Some(token) = token
                    && message.get("id").map(Value::to_string).as_deref() == Some(id.as_str())
                {
                    self.routes.deliver(token, message);
                }
                Ok(StreamableHttpPostResponse::Json(typed, session))
            }
            _ if status.is_success() => {
                Err(StreamableHttpError::UnexpectedContentType(content_type))
            }
            _ => Err(StreamableHttpError::UnexpectedServerResponse(
                format!("HTTP {status}: {}", preview(&body)).into(),
            )),
        }
    }
}

impl StreamableHttpClient for RawKeeping {
    type Error = reqwest::Error;

    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        match tool_call_id(&message) {
            Some(id) => {
                self.call(&uri, message, id, session_id, auth_token, custom_headers)
                    .await
            }
            None => {
                self.inner
                    .post_message(uri, message, session_id, auth_token, custom_headers)
                    .await
            }
        }
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        match tool_call_id(&message) {
            Some(id) => {
                self.call(&uri, message, id, session_id, auth_token, custom_headers)
                    .await
            }
            None => {
                self.inner
                    .post_message_with_max_sse_event_size(
                        uri,
                        message,
                        session_id,
                        auth_token,
                        custom_headers,
                        max_sse_event_size,
                    )
                    .await
            }
        }
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        self.inner
            .delete_session(uri, session_id, auth_token, custom_headers)
            .await
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<
        futures_util::stream::BoxStream<'static, Result<Sse, SseError>>,
        StreamableHttpError<Self::Error>,
    > {
        self.inner
            .get_stream(uri, session_id, last_event_id, auth_token, custom_headers)
            .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_token: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        max_sse_event_size: usize,
    ) -> Result<
        futures_util::stream::BoxStream<'static, Result<Sse, SseError>>,
        StreamableHttpError<Self::Error>,
    > {
        self.inner
            .get_stream_with_max_sse_event_size(
                uri,
                session_id,
                last_event_id,
                auth_token,
                custom_headers,
                max_sse_event_size,
            )
            .await
    }
}

/// For a `tools/call` request: its JSON-RPC id as JSON text, and its route token if it has one.
fn tool_call_id(message: &ClientJsonRpcMessage) -> Option<(String, Option<u64>)> {
    let ClientJsonRpcMessage::Request(request) = message else {
        return None;
    };
    if request.request.method() != "tools/call" {
        return None;
    }
    let id = serde_json::to_string(&request.id).ok()?;
    let token = serde_json::to_value(&request.request)
        .ok()
        .and_then(|value| {
            value
                .pointer(&format!("/params/_meta/{}", ROUTE_KEY.replace('/', "~1")))
                .and_then(Value::as_u64)
        });
    Some((id, token))
}

fn is_event_stream(content_type: &str) -> bool {
    content_type.starts_with("text/event-stream")
}

fn is_json(content_type: &str) -> bool {
    content_type.starts_with("application/json")
}

/// The body's bytes, ending in an error past `MOST_ANSWER_BYTES`.
fn bounded(
    stream: impl futures_util::Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send + 'static,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send + 'static {
    let mut seen = 0usize;
    stream
        .map_err(std::io::Error::other)
        .and_then(move |chunk| {
            seen = seen.saturating_add(chunk.len());
            let over = seen > MOST_ANSWER_BYTES;
            async move {
                if over {
                    Err(std::io::Error::other("the tool's answer is too large"))
                } else {
                    Ok(chunk)
                }
            }
        })
}

async fn read_bounded(
    response: reqwest::Response,
) -> Result<Vec<u8>, StreamableHttpError<reqwest::Error>> {
    let mut body = Vec::new();
    let mut stream = std::pin::pin!(bounded(response.bytes_stream()));
    while let Some(chunk) = stream.next().await {
        body.extend_from_slice(&chunk?);
    }
    Ok(body)
}

fn preview(body: &[u8]) -> String {
    String::from_utf8_lossy(&body[..body.len().min(256)]).into_owned()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
