//! [`McpClient`]: Spade as a client of one MCP server over the streamable HTTP transport, with a
//! fixed bearer (or none). One session is kept and opened again when it is lost.
//!
//! The tool list is cached for one session. It is fetched again when the server says the list
//! changed, and when the session it was fetched on is gone (checked with a `ping`). The SDK
//! never replays a request on a new session: a call is never sent twice. A listing is read-only,
//! so a listing that hits a dead session is retried once on a fresh one.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use reqwest::header::{HeaderName, HeaderValue};
use rmcp::model::{
    CancelledNotificationParam, ClientCapabilities, ClientConfig, ClientRequest, CustomRequest,
    Implementation, PaginatedRequestParams, PingRequest, ProtocolVersion,
};
use rmcp::service::{
    NotificationContext, PeerRequestOptions, RunningService, RunningServiceCancellationToken,
};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{ClientHandler, Peer, RoleClient, ServiceExt};
use serde_json::{Value, json};
use tokio::sync::{Mutex, Semaphore, watch};

use crate::errors::{self, ToolsError};
use crate::http::{CallRoutes, ROUTE_KEY, RawKeeping};
use crate::map::{self, McpTool, McpToolResult};
use crate::secret::Secret;

/// A listing longer than this many pages is treated as a server fault, not followed forever.
const MOST_PAGES: usize = 64;
/// Calls in flight at once. More wait their turn (up to the timeout) rather than crowd out
/// answers already on their way.
const MOST_CALLS: usize = 64;

/// Where one MCP server is and how to call it.
#[derive(Debug, Clone)]
pub struct McpConfig {
    url: String,
    token: Option<Secret>,
    headers: HashMap<HeaderName, HeaderValue>,
    timeout: Duration,
    direct: bool,
}

impl McpConfig {
    /// The server at `url`, called without a credential. Each connect, page and call gives up
    /// after `timeout`. Proxies set in the environment are used unless [`McpConfig::direct`].
    pub fn new(url: impl Into<String>, timeout: Duration) -> Self {
        Self {
            url: url.into(),
            token: None,
            headers: HashMap::new(),
            timeout,
            direct: false,
        }
    }

    /// Sends `token` as `Authorization: Bearer` on every request.
    #[must_use]
    pub fn bearer(mut self, token: Secret) -> Self {
        self.token = Some(token);
        self
    }

    /// Sends `name: value` on every request.
    #[must_use]
    pub fn header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.headers.insert(name, value);
        self
    }

    /// Never through a proxy, for a server on this machine.
    #[must_use]
    pub fn direct(mut self) -> Self {
        self.direct = true;
        self
    }

    #[must_use]
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn timeout(&self) -> Duration {
        self.timeout
    }

    fn scrub(&self, text: impl Into<String>) -> String {
        match &self.token {
            Some(token) => token.scrub(text),
            None => text.into(),
        }
    }
}

pub struct McpClient {
    config: McpConfig,
    session: Mutex<Option<Live>>,
    /// The listing and the session it was fetched on.
    tools: Mutex<Option<(u64, Vec<McpTool>)>>,
    stale: Arc<AtomicBool>,
    changes: Arc<watch::Sender<u64>>,
    epochs: AtomicU64,
    /// Route tokens for calls; never reused for the life of this client.
    next_call: AtomicU64,
    calls: Semaphore,
    /// Set by `close`: the credential is withdrawn, so nothing more is sent with it.
    closed: AtomicBool,
    /// Stops the live session's service (and anything it has queued) when closed.
    cancel: std::sync::Mutex<Option<RunningServiceCancellationToken>>,
}

/// Why a closed client refuses.
const WITHDRAWN: &str = "Spade's access to the server was withdrawn";

struct Live {
    service: RunningService<RoleClient, Listener>,
    epoch: u64,
    routes: CallRoutes,
}

impl McpClient {
    /// Nothing is sent until the first `tools` or `call`.
    pub fn new(config: McpConfig) -> Self {
        Self {
            config,
            session: Mutex::new(None),
            tools: Mutex::new(None),
            stale: Arc::new(AtomicBool::new(true)),
            changes: Arc::new(watch::channel(0).0),
            epochs: AtomicU64::new(0),
            next_call: AtomicU64::new(0),
            calls: Semaphore::new(MOST_CALLS),
            closed: AtomicBool::new(false),
            cancel: std::sync::Mutex::new(None),
        }
    }

    /// Withdraws this client's credential: its session is cancelled with anything still queued,
    /// and every later listing or call fails as not run without sending anything. Calls that were
    /// already sent may still be answered or fail; nothing unsent goes out.
    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        let token = self
            .cancel
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some(token) = token {
            token.cancel();
        }
    }

    fn refuse_if_closed(&self) -> Result<(), ToolsError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(ToolsError::NotRun(WITHDRAWN.into()))
        } else {
            Ok(())
        }
    }

    /// Counts the server's tool list changes. The value changes each time the server says its
    /// list changed; the next `tools` call fetches it again.
    pub fn changes(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }

    /// Every tool the server offers this credential, all pages. Served from cache only while
    /// the session it came from is alive and the server hasn't announced a change.
    pub async fn tools(&self) -> Result<Vec<McpTool>, ToolsError> {
        let mut cached = self.tools.lock().await;
        let result = match self.list_on_live_session(cached.as_ref()).await {
            Err(ToolsError::Unavailable(_) | ToolsError::NotRun(_)) => {
                self.list_on_live_session(None).await
            }
            other => other,
        };
        let (epoch, tools) = result?;
        *cached = Some((epoch, tools.clone()));
        Ok(tools)
    }

    /// Calls one tool. `arguments` is a JSON object, or null for none. A call is sent at most
    /// once: `NotRun` means it did not run, `OutcomeUnknown` and `Timeout` that it may have.
    pub async fn call(&self, name: &str, arguments: Value) -> Result<McpToolResult, ToolsError> {
        let mut params = json!({ "name": name });
        match arguments {
            Value::Object(object) => params["arguments"] = Value::Object(object),
            Value::Null => {}
            _ => return Err(ToolsError::InvalidArguments),
        }
        let _turn = tokio::time::timeout(self.config.timeout(), self.calls.acquire())
            .await
            .map_err(|_| ToolsError::NotRun("too many calls are waiting on the server".into()))?
            .map_err(|_| ToolsError::NotRun("the client is closing".into()))?;
        let (peer, epoch, routes) = self.peer().await.map_err(not_run_if_unavailable)?;
        // Checked once more right before sending: a close while the session opened wins.
        self.refuse_if_closed()?;
        // The token names this call alone; the HTTP layer hands its raw answer to this waiter.
        let token = self.next_call.fetch_add(1, Ordering::Relaxed) + 1;
        let mut meta = serde_json::Map::new();
        meta.insert(ROUTE_KEY.into(), token.into());
        params["_meta"] = Value::Object(meta);
        let mut raw = routes.register(token);
        let mut waiting = Waiting {
            routes,
            token,
            unanswered: None,
        };
        // Sent as a plain request so the answer is read from its raw JSON, whatever it holds.
        let request = ClientRequest::CustomRequest(CustomRequest::new("tools/call", Some(params)));
        let options = PeerRequestOptions::with_timeout(self.config.timeout());
        let handle = tokio::time::timeout(
            self.config.timeout(),
            peer.send_request_with_option(request, options),
        )
        .await
        .map_err(|_| ToolsError::Timeout)?;
        let handle = match handle {
            Ok(handle) => handle,
            Err(error) => {
                let error = self.failed(error, epoch).await;
                return Err(not_run_if_unavailable(error));
            }
        };
        waiting.unanswered = Some((peer.clone(), handle.id.clone()));
        let answer = handle.await_response().await;
        // Answered, refused or timed out (the SDK cancels on its own timeout): nothing to cancel.
        waiting.unanswered = None;
        let answer = match answer {
            Ok(answer) => answer,
            Err(error) => {
                return Err(match self.failed(error, epoch).await {
                    ToolsError::Unavailable(why) => ToolsError::OutcomeUnknown(why),
                    other => other,
                });
            }
        };
        // The raw answer is delivered before the SDK parses it, so it is here by now.
        let raw = raw.try_recv().ok();
        let result = match raw.and_then(|mut message| message.get_mut("result").map(Value::take)) {
            Some(result) => result,
            None => serde_json::to_value(answer)
                .map_err(|error| ToolsError::Protocol(self.config.scrub(error.to_string())))?,
        };
        Ok(map::call_result(result))
    }

    /// The cached listing when it belongs to the live session, which still answers a ping;
    /// otherwise a fresh listing. Returns the listing with its session's epoch.
    async fn list_on_live_session(
        &self,
        cached: Option<&(u64, Vec<McpTool>)>,
    ) -> Result<(u64, Vec<McpTool>), ToolsError> {
        let (peer, epoch, _) = self.peer().await?;
        if let Some((cached_epoch, tools)) = cached
            && *cached_epoch == epoch
            && !self.stale.load(Ordering::Acquire)
        {
            let ping = ClientRequest::PingRequest(PingRequest::default());
            let alive = tokio::time::timeout(self.config.timeout(), peer.send_request(ping))
                .await
                .map_err(|_| ToolsError::Timeout)?;
            match alive {
                Ok(_) => return Ok((epoch, tools.clone())),
                Err(error) => return Err(self.failed(error, epoch).await),
            }
        }
        // Cleared before listing, so a change announced while listing leaves the result stale.
        self.stale.store(false, Ordering::Release);
        let listed = self.list_pages(&peer).await;
        match listed {
            Ok(tools) => Ok((epoch, tools)),
            Err(ListError::Service(error)) => {
                self.stale.store(true, Ordering::Release);
                Err(self.failed(error, epoch).await)
            }
            Err(ListError::Other(error)) => {
                self.stale.store(true, Ordering::Release);
                Err(error)
            }
        }
    }

    async fn list_pages(&self, peer: &Peer<RoleClient>) -> Result<Vec<McpTool>, ListError> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MOST_PAGES {
            let params = PaginatedRequestParams::default().with_cursor(cursor.clone());
            let page = tokio::time::timeout(self.config.timeout(), peer.list_tools(Some(params)))
                .await
                .map_err(|_| ListError::Other(ToolsError::Timeout))?
                .map_err(ListError::Service)?;
            tools.extend(page.tools.iter().map(map::tool));
            match page.next_cursor {
                Some(next) if Some(&next) != cursor.as_ref() => cursor = Some(next),
                Some(_) => {
                    return Err(ListError::Other(ToolsError::Protocol(
                        "the tool list repeated a page cursor".into(),
                    )));
                }
                None => return Ok(tools),
            }
        }
        Err(ListError::Other(ToolsError::Protocol(format!(
            "the tool list ran past {MOST_PAGES} pages"
        ))))
    }

    /// Classifies an SDK error. A session that is gone or refused is dropped, so the next
    /// request opens a fresh one.
    async fn failed(&self, error: rmcp::ServiceError, epoch: u64) -> ToolsError {
        let error = errors::from_service(error, self.config.token.as_ref());
        if matches!(
            error,
            ToolsError::Unavailable(_) | ToolsError::NotRun(_) | ToolsError::Refused
        ) {
            let mut session = self.session.lock().await;
            if session.as_ref().is_some_and(|live| live.epoch == epoch) {
                *session = None;
            }
        }
        error
    }

    /// The live session's peer, epoch and call routes, opening a session if there is none.
    async fn peer(&self) -> Result<(Peer<RoleClient>, u64, CallRoutes), ToolsError> {
        self.refuse_if_closed()?;
        let mut session = self.session.lock().await;
        if let Some(live) = session.as_ref()
            && !live.service.is_closed()
            && !live.service.is_transport_closed()
        {
            return Ok((live.service.peer().clone(), live.epoch, live.routes.clone()));
        }
        *session = None;
        // Each session has its own routes; nothing from an earlier session can reach a call.
        let routes = CallRoutes::default();
        let service = tokio::time::timeout(self.config.timeout(), self.open(routes.clone()))
            .await
            .map_err(|_| ToolsError::Timeout)??;
        {
            let mut cancel = self
                .cancel
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Closed while the session opened: it is never used.
            if self.closed.load(Ordering::SeqCst) {
                service.cancellation_token().cancel();
                return Err(ToolsError::NotRun(WITHDRAWN.into()));
            }
            *cancel = Some(service.cancellation_token());
        }
        let epoch = self.epochs.fetch_add(1, Ordering::Relaxed) + 1;
        let peer = service.peer().clone();
        *session = Some(Live {
            service,
            epoch,
            routes: routes.clone(),
        });
        Ok((peer, epoch, routes))
    }

    async fn open(
        &self,
        routes: CallRoutes,
    ) -> Result<RunningService<RoleClient, Listener>, ToolsError> {
        let client = RawKeeping::new(routes, self.config.direct)
            .map_err(|error| ToolsError::Unavailable(self.config.scrub(error.to_string())))?;
        let mut transport_config =
            StreamableHttpClientTransportConfig::with_uri(self.config.url.as_str())
                .custom_headers(self.config.headers.clone())
                // A replay could run a tool twice; Spade reopens the session itself.
                .reinit_on_expired_session(false);
        if let Some(token) = &self.config.token {
            transport_config = transport_config.auth_header(token.expose());
        }
        let transport = StreamableHttpClientTransport::with_client(client, transport_config);
        let listener = Listener {
            stale: self.stale.clone(),
            changes: self.changes.clone(),
        };
        listener
            .serve(transport)
            .await
            .map_err(|error| errors::from_init(error, self.config.token.as_ref()))
    }
}

/// A call's registration, removed however the call ends. When the caller drops a call that was
/// sent but not answered, the server is asked to cancel it.
struct Waiting {
    routes: CallRoutes,
    token: u64,
    unanswered: Option<(Peer<RoleClient>, rmcp::model::RequestId)>,
}

impl Drop for Waiting {
    fn drop(&mut self) {
        self.routes.forget(self.token);
        if let Some((peer, id)) = self.unanswered.take()
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            runtime.spawn(async move {
                let reason = Some("Spade stopped waiting".to_owned());
                let _ = peer
                    .notify_cancelled(CancelledNotificationParam::new(Some(id), reason))
                    .await;
            });
        }
    }
}

enum ListError {
    Service(rmcp::ServiceError),
    Other(ToolsError),
}

/// Before a call is sent, failing to reach the server means it did not run.
fn not_run_if_unavailable(error: ToolsError) -> ToolsError {
    match error {
        ToolsError::Unavailable(why) => ToolsError::NotRun(why),
        other => other,
    }
}

/// Receives the server's notifications for one session.
struct Listener {
    stale: Arc<AtomicBool>,
    changes: Arc<watch::Sender<u64>>,
}

impl ClientHandler for Listener {
    fn get_info(&self) -> ClientConfig {
        // The newest revision with sessions, which carry the list-change stream; servers still
        // on earlier revisions answer with theirs.
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
