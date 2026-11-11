//! `AceTools`: Spade as an MCP client of the daemon's loopback `/mcp` endpoint
//! (docs/ace-integration.md, "Spade uses ace's tools through the daemon").
//!
//! One MCP session is kept open and opened again when it is lost. The tool list is cached and
//! fetched again after the daemon says it changed (`notifications/tools/list_changed`). The
//! daemon applies its own scopes; Spade's approval gate decides, by each tool's `Risk`, what to
//! ask about before calling it.

mod errors;
pub mod map;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use rmcp::model::{
    ClientCapabilities, ClientConfig, ClientRequest, CustomRequest, Implementation,
    PaginatedRequestParams, ProtocolVersion,
};
use rmcp::service::{NotificationContext, PeerRequestOptions, RunningService};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{ClientHandler, Peer, RoleClient, ServiceExt};
use serde_json::{Value, json};
use tokio::sync::{Mutex, watch};

use crate::secret::Secret;
pub use errors::ToolsError;
pub use map::{AceTool, AceToolResult, Part, Risk};

/// A listing longer than this many pages is treated as a server fault, not followed forever.
const MOST_PAGES: usize = 64;

/// Where the daemon's MCP endpoint is and how long one request may take.
#[derive(Debug, Clone)]
pub struct ToolsConfig {
    /// `SPADE_ACE_MCP_URL`, for example `http://127.0.0.1:4321/mcp`.
    pub url: String,
    /// `SPADE_ACE_MCP_TOKEN`, sent as a bearer.
    pub token: Secret,
    /// Each connect, page and call gives up after this.
    pub timeout: Duration,
}

pub struct AceTools {
    config: ToolsConfig,
    session: Mutex<Option<Live>>,
    tools: Mutex<Option<Vec<AceTool>>>,
    stale: Arc<AtomicBool>,
    changes: Arc<watch::Sender<u64>>,
    epochs: std::sync::atomic::AtomicU64,
}

struct Live {
    service: RunningService<RoleClient, Listener>,
    epoch: u64,
}

impl AceTools {
    /// Nothing is sent until the first `tools` or `call`.
    pub fn new(config: ToolsConfig) -> Self {
        Self {
            config,
            session: Mutex::new(None),
            tools: Mutex::new(None),
            stale: Arc::new(AtomicBool::new(true)),
            changes: Arc::new(watch::channel(0).0),
            epochs: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Counts the daemon's tool list changes. The value changes each time the daemon says its
    /// list changed; the next `tools` call fetches it again.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Every tool the daemon offers this credential, all pages, from cache unless it changed.
    pub async fn tools(&self) -> Result<Vec<AceTool>, ToolsError> {
        let mut cached = self.tools.lock().await;
        if let Some(tools) = cached.as_ref()
            && !self.stale.load(Ordering::Acquire)
        {
            return Ok(tools.clone());
        }
        // Cleared before listing, so a change announced while listing marks the result stale.
        self.stale.store(false, Ordering::Release);
        let tools = match self.list_once().await {
            Err(ToolsError::Unavailable(_)) => self.list_once().await,
            other => other,
        };
        let tools = tools.inspect_err(|_| self.stale.store(true, Ordering::Release))?;
        *cached = Some(tools.clone());
        Ok(tools)
    }

    /// Calls one tool. `arguments` is a JSON object, or null for none. A call is never sent twice:
    /// if the session drops mid-call the error says so and the caller decides.
    pub async fn call(&self, name: &str, arguments: Value) -> Result<AceToolResult, ToolsError> {
        let arguments = match arguments {
            Value::Object(object) => Some(Value::Object(object)),
            Value::Null => None,
            _ => return Err(ToolsError::InvalidArguments),
        };
        let mut params = json!({ "name": name });
        if let Some(arguments) = arguments {
            params["arguments"] = arguments;
        }
        let (peer, epoch) = self.peer().await?;
        // Sent as a plain request so the answer reaches `map::call_result` as JSON, whatever
        // content kinds it holds; the SDK's typed result has no place for unknown ones.
        let request = ClientRequest::CustomRequest(CustomRequest::new("tools/call", Some(params)));
        let options = PeerRequestOptions::with_timeout(self.config.timeout);
        let sent = tokio::time::timeout(
            self.config.timeout,
            peer.send_request_with_option(request, options),
        )
        .await
        .map_err(|_| ToolsError::Timeout)?;
        let answer = match sent {
            Ok(handle) => handle.await_response().await,
            Err(error) => Err(error),
        };
        let answer = answer.map_err(|error| self.failed(error));
        let answer = match answer {
            Ok(answer) => answer,
            Err(error) => return Err(self.after_failure(error, epoch).await),
        };
        let value = serde_json::to_value(answer)
            .map_err(|error| ToolsError::Protocol(self.config.token.scrub(error.to_string())))?;
        Ok(map::call_result(value))
    }

    async fn list_once(&self) -> Result<Vec<AceTool>, ToolsError> {
        let (peer, epoch) = self.peer().await?;
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MOST_PAGES {
            let params = PaginatedRequestParams::default().with_cursor(cursor.clone());
            let page = tokio::time::timeout(self.config.timeout, peer.list_tools(Some(params)))
                .await
                .map_err(|_| ToolsError::Timeout)?;
            let page = match page {
                Ok(page) => page,
                Err(error) => {
                    let error = self.failed(error);
                    return Err(self.after_failure(error, epoch).await);
                }
            };
            tools.extend(page.tools.iter().map(map::tool));
            match page.next_cursor {
                Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
                Some(_) => {
                    return Err(ToolsError::Protocol(
                        "the tool list repeated a page cursor".into(),
                    ));
                }
                None => return Ok(tools),
            }
        }
        Err(ToolsError::Protocol(format!(
            "the tool list ran past {MOST_PAGES} pages"
        )))
    }

    fn failed(&self, error: rmcp::ServiceError) -> ToolsError {
        errors::from_service(error, &self.config.token)
    }

    /// A lost or refused session is dropped so the next request opens a fresh one.
    async fn after_failure(&self, error: ToolsError, epoch: u64) -> ToolsError {
        if matches!(error, ToolsError::Unavailable(_) | ToolsError::Refused) {
            let mut session = self.session.lock().await;
            if session.as_ref().is_some_and(|live| live.epoch == epoch) {
                *session = None;
            }
        }
        error
    }

    async fn peer(&self) -> Result<(Peer<RoleClient>, u64), ToolsError> {
        let mut session = self.session.lock().await;
        if let Some(live) = session.as_ref()
            && !live.service.is_closed()
            && !live.service.is_transport_closed()
        {
            return Ok((live.service.peer().clone(), live.epoch));
        }
        *session = None;
        let service = tokio::time::timeout(self.config.timeout, self.open())
            .await
            .map_err(|_| ToolsError::Timeout)??;
        let epoch = self.epochs.fetch_add(1, Ordering::Relaxed) + 1;
        // A new session may list differently from the one it replaces.
        self.stale.store(true, Ordering::Release);
        let peer = service.peer().clone();
        *session = Some(Live { service, epoch });
        Ok((peer, epoch))
    }

    async fn open(&self) -> Result<RunningService<RoleClient, Listener>, ToolsError> {
        let transport = StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(self.config.url.as_str())
                .auth_header(self.config.token.expose())
                .reinit_on_expired_session(true),
        );
        let listener = Listener {
            stale: self.stale.clone(),
            changes: self.changes.clone(),
        };
        listener
            .serve(transport)
            .await
            .map_err(|error| errors::from_init(error, &self.config.token))
    }
}

/// Receives the daemon's notifications for one session.
struct Listener {
    stale: Arc<AtomicBool>,
    changes: Arc<watch::Sender<u64>>,
}

impl ClientHandler for Listener {
    fn get_info(&self) -> ClientConfig {
        // The newest revision with sessions: the daemon keeps a bounded notification stream for
        // a session, which is how list changes reach a long-lived client.
        ClientConfig::new(
            ClientCapabilities::default(),
            Implementation::new("spade", env!("CARGO_PKG_VERSION")),
        )
        .with_protocol_version(ProtocolVersion::LATEST_WITH_INITIALIZE)
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.stale.store(true, Ordering::Release);
        self.changes.send_modify(|count| *count += 1);
    }
}
