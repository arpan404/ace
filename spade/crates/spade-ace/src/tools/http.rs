//! The HTTP client under the MCP transport. Every request goes through the SDK's own reqwest
//! client except `tools/call`, which this sends itself so that:
//!
//! - the answer's raw JSON is kept (the SDK's typed content drops fields it doesn't know), and
//! - a 404 for an expired session comes back as `SessionExpired` and nothing is replayed.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use futures_util::{StreamExt, TryStreamExt};
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderName, HeaderValue};
use rmcp::model::{ClientJsonRpcMessage, ServerJsonRpcMessage};
use rmcp::transport::streamable_http_client::{
    SseError, StreamableHttpClient, StreamableHttpError, StreamableHttpPostResponse,
};
use serde_json::Value;
use sse_stream::{Sse, SseStream};

const SESSION_HEADER: &str = "Mcp-Session-Id";
/// The most bytes one `tools/call` answer may take, as JSON or as an event stream.
const MOST_ANSWER_BYTES: usize = 32 * 1024 * 1024;
/// Raw answers waiting for their caller. More than this means callers gave up; the oldest go.
const MOST_KEPT: usize = 64;

/// Raw `tools/call` answers by JSON-RPC id (its JSON text), whole messages as sent.
#[derive(Clone, Default)]
pub(crate) struct RawAnswers(Arc<Mutex<VecDeque<(String, Value)>>>);

impl RawAnswers {
    fn keep(&self, id: String, message: Value) {
        let mut kept = lock(&self.0);
        if kept.len() >= MOST_KEPT {
            kept.pop_front();
        }
        kept.push_back((id, message));
    }

    /// The raw answer to request `id`, once.
    pub(crate) fn take(&self, id: &rmcp::model::RequestId) -> Option<Value> {
        let key = serde_json::to_string(id).ok()?;
        let mut kept = lock(&self.0);
        let index = kept.iter().position(|(id, _)| *id == key)?;
        kept.remove(index).map(|(_, message)| message)
    }
}

#[derive(Clone)]
pub(crate) struct RawKeeping {
    inner: reqwest::Client,
    answers: RawAnswers,
}

impl RawKeeping {
    pub(crate) fn new(answers: RawAnswers) -> Self {
        Self {
            inner: reqwest::Client::new(),
            answers,
        }
    }

    async fn call(
        &self,
        uri: &str,
        message: ClientJsonRpcMessage,
        id: String,
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
            let answers = self.answers.clone();
            let bytes = bounded(response.bytes_stream());
            let events = SseStream::from_bytes_stream(bytes).map(move |event| {
                if let Ok(Sse {
                    data: Some(data), ..
                }) = &event
                    && let Ok(message) = serde_json::from_str::<Value>(data)
                    && message.get("id").map(Value::to_string).as_deref() == Some(id.as_str())
                {
                    answers.keep(id.clone(), message);
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
                if status.is_success() {
                    self.answers.keep(id, message);
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

/// The JSON-RPC id of a `tools/call` request, as JSON text; `None` for anything else.
fn tool_call_id(message: &ClientJsonRpcMessage) -> Option<String> {
    match message {
        ClientJsonRpcMessage::Request(request) if request.request.method() == "tools/call" => {
            serde_json::to_string(&request.id).ok()
        }
        _ => None,
    }
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
