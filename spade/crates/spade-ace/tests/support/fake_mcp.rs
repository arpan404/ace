//! An in-process stand-in for the daemon's loopback `/mcp` endpoint, built on the same MCP SDK:
//! a bearer check in front, paginated tools, and calls that answer text, an image, a tool error,
//! nothing (slow) or a protocol error (unknown tool). It can restart on the same port, which
//! loses every session the way a daemon restart does.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorData,
    Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
    Tool, ToolAnnotations, ToolsCapability,
};
use rmcp::service::{NotificationContext, RequestContext};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{Peer, RoleServer, ServerHandler};
use serde_json::json;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

pub const TOKEN: &str = "mcp-bearer-for-tests";
/// A 1x1 PNG, base64.
pub const PIXEL: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

#[derive(Default)]
struct State {
    tools: Mutex<Vec<Tool>>,
    page_size: Mutex<usize>,
    peers: Mutex<Vec<Peer<RoleServer>>>,
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
        let state = Arc::new(State::default());
        *lock(&state.tools) = tools;
        *lock(&state.page_size) = 2;
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

    /// Stops and starts again on the same port with no sessions, like a daemon restart.
    pub async fn restart(&mut self) {
        self.stop.cancel();
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
        lock(&self.state.peers).clear();
        self.stop = CancellationToken::new();
        let listener = tokio::net::TcpListener::bind(self.addr)
            .await
            .unwrap_or_else(|e| panic!("rebind: {e}"));
        self.serve(listener);
    }

    /// Adds a tool and tells every connected session the list changed.
    pub async fn add_tool_and_notify(&self, tool: Tool) {
        lock(&self.state.tools).push(tool);
        let peers = lock(&self.state.peers).clone();
        assert!(!peers.is_empty(), "no session to notify");
        for peer in peers {
            let _ = peer.notify_tool_list_changed().await;
        }
    }

    fn serve(&mut self, listener: tokio::net::TcpListener) {
        let fake = Fake(self.state.clone());
        let service = StreamableHttpService::new(
            move || Ok(fake.clone()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default().with_cancellation_token(self.stop.child_token()),
        );
        let app = axum::Router::new()
            .nest_service("/mcp", service)
            .layer(middleware::from_fn(bearer));
        let stop = self.stop.clone();
        self.task = Some(tokio::spawn(async move {
            let _ = axum::serve(listener, app)
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

/// The daemon answers a missing or wrong bearer with a bare 401.
async fn bearer(request: Request, next: Next) -> Result<Response, StatusCode> {
    let expected = format!("Bearer {TOKEN}");
    match request.headers().get("authorization") {
        Some(value) if value.as_bytes() == expected.as_bytes() => Ok(next.run(request).await),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
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
        let size = *lock(&self.0.page_size);
        let start: usize = request
            .and_then(|r| r.cursor)
            .map(|c| c.parse().unwrap_or(0))
            .unwrap_or(0);
        let end = (start + size).min(tools.len());
        let mut page = ListToolsResult::with_all_items(tools[start..end].to_vec());
        page.next_cursor = (end < tools.len()).then(|| end.to_string());
        Ok(page)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
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
    let serde_json::Value::Object(schema) = schema else {
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
