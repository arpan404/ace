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
    ElicitRequestParams, ElicitResult, ElicitationCapability, ErrorCode, ErrorData,
    FormElicitationCapability, Implementation, PaginatedRequestParams, PingRequest,
    ProtocolVersion,
};
use rmcp::service::{
    NotificationContext, PeerRequestOptions, RequestContext, RunningService,
    RunningServiceCancellationToken,
};
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::{ClientHandler, Peer, RoleClient, ServiceExt};
use serde_json::{Value, json};
use tokio::sync::{Mutex, Semaphore, watch};

use crate::ask::{self, Asker};
use crate::errors::{self, ToolsError};
use crate::http::{CallRoutes, ROUTE_KEY, RawKeeping};
use crate::map::{self, McpTool, McpToolResult};
use crate::secret::Secret;
use crate::stdio::{FAILED, Process, RestartBudget, StdioCommand};

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
    /// Other credentials the server could echo back (a refresh token, a client secret).
    redact: Vec<Secret>,
    headers: HashMap<HeaderName, HeaderValue>,
    timeout: Duration,
    direct: bool,
    /// A local server Spade starts, in place of the HTTP address.
    stdio: Option<StdioCommand>,
    /// Declares form elicitation: a call made with an [`Asker`] may show the server's forms to
    /// the person.
    eliciting: bool,
}

impl McpConfig {
    /// The server at `url`, called without a credential. Each connect, page and call gives up
    /// after `timeout`. Proxies set in the environment are used unless [`McpConfig::direct`].
    pub fn new(url: impl Into<String>, timeout: Duration) -> Self {
        Self {
            url: url.into(),
            token: None,
            redact: Vec::new(),
            headers: HashMap::new(),
            timeout,
            direct: false,
            stdio: None,
            eliciting: false,
        }
    }

    /// A local server Spade starts and speaks to over stdio, known as `stdio:<name>`. Started on
    /// the first listing or call, stopped when unused for its idle time, and started again after
    /// a crash on the next use, within its restart budget.
    pub fn stdio(name: &str, command: StdioCommand, timeout: Duration) -> Self {
        Self {
            stdio: Some(command),
            ..Self::new(format!("stdio:{name}"), timeout)
        }
    }

    /// Sends `token` as `Authorization: Bearer` on every request.
    #[must_use]
    pub fn bearer(mut self, token: Secret) -> Self {
        self.token = Some(token);
        self
    }

    /// Removes `secret` from every answer and error, as the bearer is: for credentials the
    /// server may know but is never sent, such as a refresh token or a client secret.
    #[must_use]
    pub fn redacting(mut self, secret: Secret) -> Self {
        self.redact.push(secret);
        self
    }

    /// Sends `name: value` on every request.
    #[must_use]
    pub fn header(mut self, name: HeaderName, value: HeaderValue) -> Self {
        self.headers.insert(name, value);
        self
    }

    /// Tells the server Spade can show it forms (MCP elicitation, form mode), for the calls made
    /// with an [`Asker`] ([`McpClient::call_asking`]). A form that comes any other way is
    /// declined. Sampling is never declared, and refused if asked.
    #[must_use]
    pub fn eliciting(mut self) -> Self {
        self.eliciting = true;
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

    fn secrets(&self) -> impl Iterator<Item = &Secret> {
        self.token.iter().chain(&self.redact)
    }

    fn scrub(&self, text: impl Into<String>) -> String {
        self.secrets()
            .fold(text.into(), |text, secret| secret.scrub(text))
    }

    /// Every string in `value`, keys included, with every credential removed.
    fn scrub_value(&self, value: &mut Value) {
        match value {
            Value::String(text) if self.secrets().any(|secret| secret.appears_in(text)) => {
                *text = self.scrub(std::mem::take(text));
            }
            Value::Array(items) => items.iter_mut().for_each(|item| self.scrub_value(item)),
            Value::Object(fields) => {
                let entries = std::mem::take(fields);
                for (key, mut field) in entries {
                    self.scrub_value(&mut field);
                    fields.insert(self.scrub(key), field);
                }
            }
            _ => {}
        }
    }

    fn scrub_error(&self, error: ToolsError) -> ToolsError {
        match error {
            ToolsError::Unavailable(why) => ToolsError::Unavailable(self.scrub(why)),
            ToolsError::NotRun(why) => ToolsError::NotRun(self.scrub(why)),
            ToolsError::OutcomeUnknown(why) => ToolsError::OutcomeUnknown(self.scrub(why)),
            ToolsError::Server { code, message } => ToolsError::Server {
                code,
                message: self.scrub(message),
            },
            ToolsError::Protocol(why) => ToolsError::Protocol(self.scrub(why)),
            other => other,
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
    /// A stdio server's process and when it was last used (`stdio`).
    local: Local,
}

/// A stdio server's lifecycle: the running process (killed when replaced or dropped), its last
/// use, whether it was stopped for being idle, and its crash restarts.
struct Local {
    process: std::sync::Mutex<Option<Arc<Slot>>>,
    last_used: Arc<std::sync::Mutex<tokio::time::Instant>>,
    idled: Arc<AtomicBool>,
    started: AtomicBool,
    budget: std::sync::Mutex<Option<RestartBudget>>,
}

type Slot = std::sync::Mutex<Option<Process>>;

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
            session: Mutex::new(None),
            tools: Mutex::new(None),
            stale: Arc::new(AtomicBool::new(true)),
            changes: Arc::new(watch::channel(0).0),
            epochs: AtomicU64::new(0),
            next_call: AtomicU64::new(0),
            calls: Semaphore::new(MOST_CALLS),
            closed: AtomicBool::new(false),
            cancel: std::sync::Mutex::new(None),
            local: Local {
                process: std::sync::Mutex::new(None),
                last_used: Arc::new(std::sync::Mutex::new(tokio::time::Instant::now())),
                idled: Arc::new(AtomicBool::new(false)),
                started: AtomicBool::new(false),
                budget: std::sync::Mutex::new(None),
            },
            config,
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
        drop(lock(&self.local.process).take());
    }

    /// The stdio server's process id while it runs, for tests that check it was stopped.
    pub fn process_id(&self) -> Option<u32> {
        let slot = lock(&self.local.process).clone()?;
        lock(&slot).as_ref().and_then(Process::id)
    }

    /// Whether a stdio server stopped too often and stays failed until replaced.
    pub fn gave_up(&self) -> bool {
        lock(&self.local.budget)
            .as_ref()
            .is_some_and(RestartBudget::spent)
    }

    fn refuse_if_closed(&self) -> Result<(), ToolsError> {
        if self.closed.load(Ordering::SeqCst) {
            Err(ToolsError::NotRun(WITHDRAWN.into()))
        } else {
            Ok(())
        }
    }

    /// `text` with every credential this client knows removed: its bearer and every credential
    /// it was told to redact. For text about this server shown or logged elsewhere.
    pub fn scrub(&self, text: impl Into<String>) -> String {
        self.config.scrub(text)
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

    /// Every tool the server offers now, read again from the server even when the cached list
    /// has not been announced as changed (servers that never send list changes).
    pub async fn fresh_tools(&self) -> Result<Vec<McpTool>, ToolsError> {
        self.stale.store(true, Ordering::Release);
        self.tools().await
    }

    /// Calls one tool. `arguments` is a JSON object, or null for none. A call is sent at most
    /// once: `NotRun` means it did not run, `OutcomeUnknown` and `Timeout` that it may have.
    ///
    /// Every credential this client knows (its bearer and those it was told to redact) is
    /// removed from the answer, text and structured content alike, and from errors: a server
    /// that echoes a token back never gets it stored or shown to a model.
    pub async fn call(&self, name: &str, arguments: Value) -> Result<McpToolResult, ToolsError> {
        self.call_with_meta(name, arguments, serde_json::Map::new())
            .await
    }

    /// [`McpClient::call`], with `meta` sent as the call's `_meta` (beside this client's own
    /// routing key, which wins).
    pub async fn call_with_meta(
        &self,
        name: &str,
        arguments: Value,
        meta: serde_json::Map<String, Value>,
    ) -> Result<McpToolResult, ToolsError> {
        self.call_asking(name, arguments, meta, None).await
    }

    /// [`McpClient::call_with_meta`], where a form the server sends during this call (on a
    /// client made [`McpConfig::eliciting`]) goes to `asker`, and the call's timeout waits while
    /// the person decides. Without an asker every form is declined.
    pub async fn call_asking(
        &self,
        name: &str,
        arguments: Value,
        meta: serde_json::Map<String, Value>,
        asker: Option<Arc<dyn Asker>>,
    ) -> Result<McpToolResult, ToolsError> {
        match self.call_raw(name, arguments, meta, asker).await {
            Ok(mut result) => {
                self.config.scrub_value(&mut result);
                Ok(map::call_result(result))
            }
            Err(error) => Err(self.config.scrub_error(error)),
        }
    }

    async fn call_raw(
        &self,
        name: &str,
        arguments: Value,
        mut meta: serde_json::Map<String, Value>,
        asker: Option<Arc<dyn Asker>>,
    ) -> Result<Value, ToolsError> {
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
        meta.insert(ROUTE_KEY.into(), token.into());
        params["_meta"] = Value::Object(meta);
        let mut raw = routes.register(token);
        // Counts the person's open forms for this call, while it may ask them.
        let open = asker.map(|asker| routes.asking(token, asker));
        let mut waiting = Waiting {
            routes,
            token,
            unanswered: None,
        };
        // Sent as a plain request so the answer is read from its raw JSON, whatever it holds.
        let request = ClientRequest::CustomRequest(CustomRequest::new("tools/call", Some(params)));
        // A call that may ask the person keeps its own time, paused while they decide.
        let options = match open {
            Some(_) => PeerRequestOptions::no_options(),
            None => PeerRequestOptions::with_timeout(self.config.timeout()),
        };
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
        let answer = match open {
            Some(open) => {
                // Out of time with nobody asked: dropped, so the server is told to cancel.
                ask_paused(handle.await_response(), self.config.timeout(), open)
                    .await
                    .ok_or(ToolsError::Timeout)?
            }
            None => handle.await_response().await,
        };
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
        Ok(result)
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
        let error = errors::from_service(error, &|text| self.config.scrub(text));
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
        *lock(&self.local.last_used) = tokio::time::Instant::now();
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
        if let Some(command) = &self.config.stdio {
            return self.open_stdio(command, routes).await;
        }
        let client = RawKeeping::new(routes.clone(), self.config.direct)
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
        let listener = self.listener(routes);
        listener
            .serve(transport)
            .await
            .map_err(|error| errors::from_init(error, &|text| self.config.scrub(text)))
    }
}

impl McpClient {
    /// The handler for one session's messages from the server.
    fn listener(&self, routes: CallRoutes) -> Listener {
        Listener {
            stale: self.stale.clone(),
            changes: self.changes.clone(),
            routes,
            eliciting: self.config.eliciting,
        }
    }

    /// Starts the stdio server and opens a session on its pipes. Every start after the first
    /// that did not follow an idle stop is a crash restart, counted against the budget.
    async fn open_stdio(
        &self,
        command: &StdioCommand,
        routes: CallRoutes,
    ) -> Result<RunningService<RoleClient, Listener>, ToolsError> {
        let now = tokio::time::Instant::now();
        {
            let mut budget = lock(&self.local.budget);
            let budget = budget.get_or_insert_with(|| {
                RestartBudget::new(command.most_restarts, command.restart_window)
            });
            let idled = self.local.idled.swap(false, Ordering::SeqCst);
            let restart = self.local.started.swap(true, Ordering::SeqCst) && !idled;
            if budget.spent() || (restart && !budget.restart(now)) {
                drop(lock(&self.local.process).take());
                return Err(ToolsError::Unavailable(FAILED.into()));
            }
        }
        // The one before is ended first, whatever state it is in.
        drop(lock(&self.local.process).take());
        let (process, stdout, stdin) = Process::spawn(command).map_err(|error| {
            ToolsError::Unavailable(format!("could not start {}: {error}", command.program))
        })?;
        let slot = Arc::new(std::sync::Mutex::new(Some(process)));
        *lock(&self.local.process) = Some(slot.clone());
        *lock(&self.local.last_used) = now;
        watch_idle(
            Arc::downgrade(&slot),
            self.local.last_used.clone(),
            self.local.idled.clone(),
            command.idle,
        );
        let listener = self.listener(routes);
        listener
            .serve((stdout, stdin))
            .await
            .map_err(|error| errors::from_init(error, &|text| self.config.scrub(text)))
    }
}

/// Stops the process in `slot` once it has gone `idle` unused. Ends by itself when the process
/// is replaced or dropped.
fn watch_idle(
    slot: std::sync::Weak<Slot>,
    last_used: Arc<std::sync::Mutex<tokio::time::Instant>>,
    idled: Arc<AtomicBool>,
    idle: Duration,
) {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return;
    };
    runtime.spawn(async move {
        loop {
            let due = *lock(&last_used) + idle;
            tokio::time::sleep_until(due).await;
            let Some(slot) = slot.upgrade() else {
                return;
            };
            if lock(&slot).is_none() {
                return;
            }
            if tokio::time::Instant::now() >= *lock(&last_used) + idle {
                idled.store(true, Ordering::SeqCst);
                drop(lock(&slot).take());
                return;
            }
        }
    });
}

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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

/// `answer`, given `timeout` of the call's own time: the clock stops while any of its forms is
/// open (`open` counts them) and starts afresh once the person replied. `None` when the time ran
/// out with nobody asked.
async fn ask_paused<T>(
    answer: impl Future<Output = T>,
    timeout: Duration,
    mut open: watch::Receiver<usize>,
) -> Option<T> {
    let mut answer = std::pin::pin!(answer);
    let mut deadline = tokio::time::Instant::now() + timeout;
    loop {
        tokio::select! {
            answered = &mut answer => return Some(answered),
            () = tokio::time::sleep_until(deadline) => {
                if *open.borrow() == 0 {
                    return None;
                }
                // The person is deciding: wait for every form to close, then a fresh timeout.
                tokio::select! {
                    answered = &mut answer => return Some(answered),
                    _ = open.wait_for(|open| *open == 0) => {}
                }
                deadline = tokio::time::Instant::now() + timeout;
            }
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

/// Receives the server's notifications and requests for one session.
struct Listener {
    stale: Arc<AtomicBool>,
    changes: Arc<watch::Sender<u64>>,
    /// The session's calls, to find the one a form belongs to.
    routes: CallRoutes,
    eliciting: bool,
}

impl ClientHandler for Listener {
    fn get_info(&self) -> ClientConfig {
        // Form elicitation only, and only when a call can show it; never sampling (ADR 0202 §2).
        let mut capabilities = ClientCapabilities::default();
        if self.eliciting {
            capabilities.elicitation =
                Some(ElicitationCapability::new().with_form(FormElicitationCapability::new()));
        }
        // The newest revision with sessions, which carry the list-change stream; servers still
        // on earlier revisions answer with theirs.
        ClientConfig::new(
            capabilities,
            Implementation::new("spade", env!("CARGO_PKG_VERSION")),
        )
        .with_protocol_version(ProtocolVersion::LATEST_WITH_INITIALIZE)
    }

    /// A form the server asks the person to fill in, mid-call: shown by the call's asker, with
    /// its timeout paused until they reply. A form no call in flight can show, a URL form, and
    /// one the person leaves past [`ask::MOST_WAIT`] are declined or cancelled.
    async fn create_elicitation(
        &self,
        request: ElicitRequestParams,
        context: RequestContext<RoleClient>,
    ) -> Result<ElicitResult, ErrorData> {
        let id = serde_json::to_string(&context.id).unwrap_or_default();
        let (
            ElicitRequestParams::FormElicitationParams {
                message,
                requested_schema,
                ..
            },
            Some(asking),
        ) = (request, self.routes.asker_for(&id))
        else {
            return Ok(ask::result(ask::Reply::Decline));
        };
        let schema = serde_json::to_value(&requested_schema).unwrap_or(Value::Null);
        asking.open.send_modify(|open| *open += 1);
        let reply = tokio::time::timeout(
            ask::MOST_WAIT,
            asking.asker.ask(ask::Form { message, schema }),
        )
        .await
        .unwrap_or(ask::Reply::Cancel);
        asking
            .open
            .send_modify(|open| *open = open.saturating_sub(1));
        Ok(ask::result(reply))
    }

    /// A server never borrows the person's model (ADR 0202 §2). Sampling is deprecated in the
    /// spec, so naming its types is too.
    #[expect(deprecated)]
    async fn create_message(
        &self,
        _request: rmcp::model::CreateMessageRequestParams,
        _context: RequestContext<RoleClient>,
    ) -> Result<rmcp::model::CreateMessageResult, ErrorData> {
        Err(ErrorData::new(
            ErrorCode::METHOD_NOT_FOUND,
            ask::SAMPLING_REFUSED,
            None,
        ))
    }

    async fn on_tool_list_changed(&self, _context: NotificationContext<RoleClient>) {
        self.stale.store(true, Ordering::Release);
        self.changes.send_modify(|count| *count += 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TIMEOUT: Duration = Duration::from_millis(60);

    #[tokio::test]
    async fn a_call_nobody_is_asked_about_times_out_on_its_own_clock() {
        let (_open, counted) = watch::channel(0usize);
        let slow = tokio::time::sleep(TIMEOUT * 4);
        assert_eq!(ask_paused(slow, TIMEOUT, counted).await, None);
    }

    #[tokio::test]
    async fn the_clock_waits_while_the_person_decides_then_starts_afresh() {
        let (open, counted) = watch::channel(1usize);
        // The person takes three timeouts to reply; the answer comes half a timeout after.
        tokio::spawn(async move {
            tokio::time::sleep(TIMEOUT * 3).await;
            open.send_replace(0);
            // Kept open so the count stays readable.
            tokio::time::sleep(TIMEOUT * 4).await;
        });
        let answer = async {
            tokio::time::sleep(TIMEOUT * 3 + TIMEOUT / 2).await;
            "answered"
        };
        assert_eq!(ask_paused(answer, TIMEOUT, counted).await, Some("answered"));
    }
}
