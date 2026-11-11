//! An in-process stand-in for the daemon's loopback `/mcp` endpoint, built on the same MCP SDK
//! and holding to the daemon's rules (`packages/mcp-server/src/http.ts`, `legacy-sessions.ts`):
//!
//! - a bare 401 for a missing or wrong bearer;
//! - a request with `X-Ace-Notifications: stream` gets a session with a list-change stream; one
//!   without is served statelessly: no session id and no notifications;
//! - `X-Ace-Tools` or `X-Ace-Client` would narrow the listing; Spade must send neither, so the
//!   fake refuses both with 400;
//! - each bearer holds at most four sessions; a fifth replaces the oldest.
//!
//! Tools: `echo`, `snap` (text + image), `fail` (tool error), `slow` (never in time),
//! `decorated` (blocks and result with fields the SDK doesn't model), anything else a protocol
//! error. It can restart on the same port, expire every session, and count `tools/call` frames.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::{Request, State as Shared};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorData,
    Implementation, ListToolsResult, MetaObject, PaginatedRequestParams, ServerCapabilities,
    ServerConfig, Tool, ToolAnnotations, ToolsCapability,
};
use rmcp::service::{NotificationContext, RequestContext};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{Peer, RoleServer, ServerHandler};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tower::Layer;

pub const TOKEN: &str = "mcp-bearer-for-tests";
/// A 1x1 PNG, base64.
pub const PIXEL: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const SESSIONS_PER_BEARER: usize = 4;

struct State {
    tools: Mutex<Vec<Tool>>,
    peers: Mutex<Vec<Peer<RoleServer>>>,
    sessions: Mutex<Option<Arc<LocalSessionManager>>>,
    /// Session ids in the order they were opened.
    opened: Mutex<VecDeque<String>>,
    /// Every request's headers, in order.
    requests: Mutex<Vec<HeaderMap>>,
    tool_call_frames: AtomicUsize,
    tool_runs: AtomicUsize,
    cancels: AtomicUsize,
    /// While true, `tools/call` answers are sent only once it turns false again.
    hold: tokio::sync::watch::Sender<bool>,
    /// Where `tools/call` POSTs are redirected, when set.
    redirect_calls: Mutex<Option<String>>,
}

#[derive(Clone)]
struct Fake(Arc<State>);

pub struct FakeMcp {
    state: Arc<State>,
    addr: SocketAddr,
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl FakeMcp {
    /// Serves `tools` two to a page.
    pub async fn start(tools: Vec<Tool>) -> Self {
        let state = Arc::new(State {
            tools: Mutex::new(tools),
            peers: Mutex::default(),
            sessions: Mutex::default(),
            opened: Mutex::default(),
            requests: Mutex::default(),
            tool_call_frames: AtomicUsize::new(0),
            tool_runs: AtomicUsize::new(0),
            cancels: AtomicUsize::new(0),
            hold: tokio::sync::watch::channel(false).0,
            redirect_calls: Mutex::new(None),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap_or_else(|e| panic!("bind: {e}"));
        let addr = listener
            .local_addr()
            .unwrap_or_else(|e| panic!("addr: {e}"));
        let mut fake = Self {
            state,
            addr,
            stop: CancellationToken::new(),
            task: None,
        };
        fake.serve(listener);
        fake
    }

    pub fn url(&self) -> String {
        format!("http://{}/mcp", self.addr)
    }

    /// Stops and starts again on the same port with no sessions and `tools`, like a daemon
    /// restart that also changed what it offers.
    pub async fn restart_with(&mut self, tools: Vec<Tool>) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        lock(&self.state.peers).clear();
        lock(&self.state.opened).clear();
        *lock(&self.state.tools) = tools;
        self.stop = CancellationToken::new();
        let listener = tokio::net::TcpListener::bind(self.addr)
            .await
            .unwrap_or_else(|e| panic!("rebind: {e}"));
        self.serve(listener);
    }

    pub async fn restart(&mut self) {
        let tools = lock(&self.state.tools).clone();
        self.restart_with(tools).await;
    }

    /// Forgets every session while still running: the next request on one gets a 404.
    pub async fn expire_sessions(&self) {
        let manager = lock(&self.state.sessions).clone();
        if let Some(manager) = manager {
            manager.sessions.write().await.clear();
        }
        lock(&self.state.peers).clear();
    }

    /// Adds a tool and tells every session the list changed. Stateless clients hear nothing.
    pub async fn add_tool_and_notify(&self, tool: Tool) {
        lock(&self.state.tools).push(tool);
        let peers = lock(&self.state.peers).clone();
        for peer in peers {
            let _ = peer.notify_tool_list_changed().await;
        }
    }

    /// From now on, `tools/call` answers (headers go out at once) wait for `release_answers`.
    pub fn hold_answers(&self) {
        self.state.hold.send_replace(true);
    }

    /// Sends every held answer.
    pub fn release_answers(&self) {
        self.state.hold.send_replace(false);
    }

    /// Answers every `tools/call` POST with a 307 to `url`.
    pub fn redirect_calls_to(&self, url: String) {
        *lock(&self.state.redirect_calls) = Some(url);
    }

    /// `tools/call` frames that reached the endpoint, run or not.
    pub fn tool_call_frames(&self) -> usize {
        self.state.tool_call_frames.load(Ordering::SeqCst)
    }

    /// `notifications/cancelled` frames received.
    pub fn cancels(&self) -> usize {
        self.state.cancels.load(Ordering::SeqCst)
    }

    /// Calls a tool handler actually ran.
    pub fn tool_runs(&self) -> usize {
        self.state.tool_runs.load(Ordering::SeqCst)
    }

    pub fn request_headers(&self) -> Vec<HeaderMap> {
        lock(&self.state.requests).clone()
    }

    fn serve(&mut self, listener: tokio::net::TcpListener) {
        let manager = Arc::new(LocalSessionManager::default());
        *lock(&self.state.sessions) = Some(manager.clone());
        let fake = Fake(self.state.clone());
        let with_sessions = StreamableHttpService::new(
            {
                let fake = fake.clone();
                move || Ok(fake.clone())
            },
            manager,
            StreamableHttpServerConfig::default().with_cancellation_token(self.stop.child_token()),
        );
        let stateless = StreamableHttpService::new(
            move || Ok(fake.clone()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default()
                .with_legacy_session_mode(false)
                .with_cancellation_token(self.stop.child_token()),
        );
        let router = axum::Router::new()
            .nest_service("/mcp", with_sessions)
            .nest_service("/stateless", stateless);
        // Runs before routing, so it can send a request without the header to `/stateless`.
        let app = middleware::from_fn_with_state(self.state.clone(), daemon_rules).layer(router);
        let stop = self.stop.clone();
        self.task = Some(tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                axum::ServiceExt::<Request>::into_make_service(app),
            )
            .with_graceful_shutdown(async move { stop.cancelled().await })
            .await;
        }));
    }
}

impl Drop for FakeMcp {
    fn drop(&mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

const DECORATE: &str = "DECORATE_ME";

async fn daemon_rules(Shared(state): Shared<Arc<State>>, request: Request, next: Next) -> Response {
    let headers = request.headers().clone();
    lock(&state.requests).push(headers.clone());
    let expected = format!("Bearer {TOKEN}");
    if headers.get("authorization").map(|v| v.as_bytes()) != Some(expected.as_bytes()) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    if headers.contains_key("x-ace-tools") || headers.contains_key("x-ace-client") {
        return (StatusCode::BAD_REQUEST, "Spade must get the full listing").into_response();
    }
    let streaming = headers
        .get("x-ace-notifications")
        .is_some_and(|v| v.as_bytes() == b"stream");
    let (mut parts, body) = request.into_parts();
    let Ok(body) = to_bytes(body, 64 * 1024 * 1024).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let method = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("method").and_then(Value::as_str).map(str::to_owned));
    if method.as_deref() == Some("notifications/cancelled") {
        state.cancels.fetch_add(1, Ordering::SeqCst);
    }
    if method.as_deref() == Some("tools/call") {
        state.tool_call_frames.fetch_add(1, Ordering::SeqCst);
        let redirect = lock(&state.redirect_calls).clone();
        if let Some(location) = redirect {
            return (
                StatusCode::TEMPORARY_REDIRECT,
                [(axum::http::header::LOCATION, location)],
            )
                .into_response();
        }
    }
    if !streaming {
        parts.uri = Uri::from_static("/stateless");
    }
    let response = next.run(Request::from_parts(parts, Body::from(body))).await;
    if streaming && method.as_deref() == Some("initialize") {
        let id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        if let Some(id) = id {
            replace_oldest_past_the_cap(&state, id).await;
        }
    }
    if method.as_deref() == Some("tools/call") {
        let held = *state.hold.borrow();
        let response = decorate(response).await;
        if held {
            return hold_body(response, state.hold.subscribe()).await;
        }
        return response;
    }
    response
}

/// Sends the headers now and the body once the hold is lifted.
async fn hold_body(response: Response, mut hold: tokio::sync::watch::Receiver<bool>) -> Response {
    let (parts, body) = response.into_parts();
    let Ok(body) = to_bytes(body, 64 * 1024 * 1024).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let later = futures_util::stream::once(async move {
        let _ = hold.wait_for(|held| !*held).await;
        Ok::<_, std::convert::Infallible>(body)
    });
    Response::from_parts(parts, Body::from_stream(later))
}

async fn replace_oldest_past_the_cap(state: &Arc<State>, id: String) {
    let evicted = {
        let mut opened = lock(&state.opened);
        opened.push_back(id);
        if opened.len() > SESSIONS_PER_BEARER {
            opened.pop_front()
        } else {
            None
        }
    };
    let manager = lock(&state.sessions).clone();
    if let (Some(evicted), Some(manager)) = (evicted, manager) {
        manager
            .sessions
            .write()
            .await
            .retain(|session, _| session.as_ref() != evicted.as_str());
    }
}

/// Puts fields the SDK doesn't model into the `decorated` tool's answer, as a newer daemon might.
async fn decorate(response: Response) -> Response {
    let (mut parts, body) = response.into_parts();
    let Ok(body) = to_bytes(body, 64 * 1024 * 1024).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let text = String::from_utf8_lossy(&body).into_owned();
    if !text.contains(DECORATE) {
        return Response::from_parts(parts, Body::from(body));
    }
    let text = text
        .replace(
            &format!("\"text\":\"{DECORATE}\""),
            "\"text\":\"decorated\",\"tone\":\"calm\"",
        )
        .replace(
            "\"isError\":false",
            "\"isError\":false,\"x-ace-lane\":{\"lane\":2}",
        );
    parts.headers.remove("content-length");
    Response::from_parts(parts, Body::from(text))
}

impl ServerHandler for Fake {
    fn get_info(&self) -> ServerConfig {
        let mut tools = ToolsCapability::default();
        tools.list_changed = Some(true);
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools_with(tools)
                .build(),
        )
        .with_server_info(Implementation::new("fake-ace", "0.0.0"))
    }

    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        lock(&self.0.peers).push(context.peer);
    }

    async fn list_tools(
        &self,
        request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let tools = lock(&self.0.tools).clone();
        let start: usize = request
            .and_then(|r| r.cursor)
            .map(|c| c.parse().unwrap_or(0))
            .unwrap_or(0);
        let end = (start + 2).min(tools.len());
        let mut page = ListToolsResult::with_all_items(tools[start..end].to_vec());
        page.next_cursor = (end < tools.len()).then(|| end.to_string());
        Ok(page)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        self.0.tool_runs.fetch_add(1, Ordering::SeqCst);
        let args = request.arguments.unwrap_or_default();
        let result = match request.name.as_ref() {
            "echo" => CallToolResult::success(vec![ContentBlock::text(
                args.get("say")
                    .and_then(|v| v.as_str())
                    .unwrap_or("nothing")
                    .to_owned(),
            )]),
            "snap" => CallToolResult::success(vec![
                ContentBlock::text("here it is"),
                ContentBlock::image(PIXEL, "image/png"),
            ]),
            "decorated" => {
                let mut meta = MetaObject::new();
                meta.insert("trace".into(), json!("t-1"));
                let mut result = CallToolResult::success(vec![ContentBlock::text(DECORATE)]);
                result.meta = Some(meta);
                result
            }
            "fail" => CallToolResult::error(vec![ContentBlock::text("the thread is archived")]),
            "slow" => {
                tokio::time::sleep(Duration::from_secs(30)).await;
                CallToolResult::success(vec![])
            }
            other => {
                return Err(ErrorData::invalid_params(
                    format!("unknown tool {other}"),
                    Some(json!({ "tool": other })),
                ));
            }
        };
        Ok(result.into())
    }
}

pub fn tool(name: &str, read_only: Option<bool>, destructive: Option<bool>) -> Tool {
    let schema = json!({
        "type": "object",
        "properties": { "say": { "type": "string" } }
    });
    let Value::Object(schema) = schema else {
        unreachable!()
    };
    let tool = Tool::new(name.to_owned(), format!("{name} does a thing"), schema);
    if read_only.is_none() && destructive.is_none() {
        return tool;
    }
    let mut annotations = ToolAnnotations::new();
    if let Some(read_only) = read_only {
        annotations = annotations.read_only(read_only);
    }
    if let Some(destructive) = destructive {
        annotations = annotations.destructive(destructive);
    }
    tool.with_annotations(annotations)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
