// SPDX-License-Identifier: Apache-2.0
//! The MCP server's HTTP endpoint, ported from `http.ts`.
//!
//! Only `/mcp` on a localhost Host and Origin is served; a missing or revoked bearer gets 401
//! with a `WWW-Authenticate` challenge; a body past the bound is 413; a body that is not
//! JSON-RPC is 400. The handler is sans-IO: [`McpServer::handle`] takes a parsed request and
//! returns the bytes, so the daemon's listener (and the tests) own the socket.
//!
//! Limits and texts are the TypeScript's: 2,048 concurrent requests, 64 KiB of body by default
//! (the caller may pass `maxRequestBodyBytes`), 8 KiB of headers, the protocol versions ace
//! serves today, and the JSON-RPC errors the SDK pins. Permissions are the provider's: a tool's
//! annotations travel with its descriptor, and ace only hides what the caller's scope or a
//! switched-off group cannot reach. It never adds an approval.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ace_json::{JsString, Map, Value};

use crate::credentials::{CredentialRegistry, LeaseId, Principal};
use crate::jsonrpc::{
    INTERNAL_ERROR, INVALID_PARAMS, INVALID_REQUEST, Id, METHOD_NOT_FOUND, Message, RpcError,
};
use crate::limits::{
    LEGACY_SESSIONS_PER_LEASE, LISTEN_STREAMS_PER_LEASE, MAX_HEADER_BYTES, MAX_REQUESTS,
    NOTIFICATION_STREAMS_TOTAL, PROGRESS_INTERVAL_MS,
};
use crate::public_error::{PublicIssue, PublicToolError, ToolFailure, fixed_failure, tool_failure};
use crate::registry::{CallOptions, ToolRegistry};
use crate::result::CallToolResult;
use crate::scope::{ScopeChallenge, ScopeCheck, bearer, bearer_challenge, scope_refusal};
use crate::sessions::{LegacySessions, SessionIds};
use crate::signal::{Abort, Scheduler, TokioScheduler};
use crate::streams::{NotificationStream, Streams};
use crate::tool_names::{ACE_TOOL_DISPATCH, ACE_TOOL_SEARCH, DispatchedCall, dispatched_ace_call};
use crate::toolsets::{
    CALL_BUDGET_HEADER, CODEX_CLIENT_HEADER, CORE_TOOLS_HEADER, OpenToolsets, ToolListing,
    ace_client, call_budget_seconds, dispatches, holds_on_demand_tools, listed_on_demand,
    tool_listing,
};

/// The MCP protocol versions ace serves (`http.ts:444`).
pub const PROTOCOL_VERSIONS: [&str; 5] = [
    "2024-11-05",
    "2025-03-26",
    "2025-06-18",
    "2025-11-25",
    "2026-07-28",
];
/// The version this server answers when the client's is unknown.
pub const LATEST_PROTOCOL: &str = "2026-07-28";
/// The server's own name and version (`http.ts:438`).
pub const SERVER_NAME: &str = "ace";
pub const SERVER_VERSION: &str = "0.1.0";

/// One parsed HTTP request: what the listener's parser produces and the handler reads.
#[derive(Debug, Clone)]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    /// Lowercase header names, as Node's `IncomingMessage.headers`.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value.as_str())
    }

    /// The request's whole header bytes, for the 8 KiB bound.
    pub fn header_bytes(&self) -> usize {
        self.headers
            .iter()
            .map(|(name, value)| name.len() + value.len() + 4)
            .sum()
    }
}

/// One response the listener writes. A notification stream is written after the headers, as SSE
/// frames, until it yields `None`.
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub stream: Option<NotificationStream>,
}

impl std::fmt::Debug for HttpResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpResponse")
            .field("status", &self.status)
            .field("headers", &self.headers)
            .field("body", &self.body)
            .field("stream", &self.stream)
            .finish()
    }
}

impl HttpResponse {
    pub fn empty(status: u16) -> HttpResponse {
        HttpResponse {
            status,
            headers: Vec::new(),
            body: Vec::new(),
            stream: None,
        }
    }

    pub fn json(status: u16, value: &Value) -> HttpResponse {
        HttpResponse {
            status,
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: ace_json::to_string(value).into_bytes(),
            stream: None,
        }
    }

    /// A JSON-RPC error whose HTTP status is 400, as the SDK writes a parse failure.
    pub fn rpc_failure(status: u16, error: RpcError) -> HttpResponse {
        HttpResponse::json(status, &Message::failure(None, error))
    }

    /// The SSE response a subscription is served as.
    pub fn events(stream: NotificationStream) -> HttpResponse {
        HttpResponse {
            status: 200,
            headers: vec![
                ("content-type".to_owned(), "text/event-stream".to_owned()),
                ("cache-control".to_owned(), "no-cache".to_owned()),
            ],
            body: Vec::new(),
            stream: Some(stream),
        }
    }
}

/// A notification the server sends outside the request's reply (progress, list changes).
pub type Emitter = Arc<dyn Fn(Value) + Send + Sync>;

/// One JSON-RPC request as a lease spied it: request ids are per caller, never per session name.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct CallKey {
    lease: LeaseId,
    id: String,
}

/// The state one endpoint keeps per lease. It is shared with each lease's abort hook, so ending
/// a lease forgets everything it held even if no request ever mentions it again.
struct Shared {
    calls: Mutex<HashMap<CallKey, Abort>>,
    toolsets: Mutex<OpenToolsets>,
    /// `subscriptions/listen` streams (two a lease).
    listen: Mutex<Streams>,
    /// Legacy transport GET streams (one per session, four sessions a lease).
    legacy_streams: Mutex<Streams>,
    legacy: Mutex<LegacySessions>,
    watched: Mutex<HashSet<LeaseId>>,
}

impl Shared {
    fn forget(&self, lease: LeaseId) {
        let gone: Vec<Abort> = {
            let mut calls = self.calls.lock().unwrap_or_else(|error| error.into_inner());
            let gone: Vec<Abort> = calls
                .iter()
                .filter(|(key, _)| key.lease == lease)
                .map(|(_, abort)| abort.clone())
                .collect();
            calls.retain(|key, _| key.lease != lease);
            gone
        };
        for abort in gone {
            abort.abort();
        }
        self.toolsets
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .forget(lease);
        self.listen
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .close_lease(lease);
        self.legacy_streams
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .close_lease(lease);
        self.legacy
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .forget_lease(lease);
    }

    /// Ends one stream the listener dropped. A legacy GET's stream also ends its transport
    /// session, as a disconnected stream owns no usable transport state
    /// (`legacy-sessions.ts:47`).
    fn end_stream(&self, kind: StreamKind, id: u64, session: Option<&str>) {
        self.stream(kind)
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .close(id);
        if let Some(session) = session {
            self.legacy
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .close_any(session);
        }
    }

    fn stream(&self, kind: StreamKind) -> &Mutex<Streams> {
        match kind {
            StreamKind::Listen => &self.listen,
            StreamKind::Legacy => &self.legacy_streams,
        }
    }
}

/// Which bound a notification stream is counted against (`http.ts:93`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamKind {
    Listen,
    Legacy,
}

/// One MCP endpoint's state: the registry, the authority and the bounds.
pub struct McpServer {
    registry: Arc<ToolRegistry>,
    credentials: Arc<CredentialRegistry>,
    challenge: Option<Arc<dyn ScopeChallenge>>,
    max_requests: usize,
    max_body_bytes: usize,
    scheduler: Arc<dyn Scheduler>,
    active: AtomicUsize,
    closing: AtomicBool,
    shared: Arc<Shared>,
}
impl std::fmt::Debug for McpServer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("McpServer")
            .field("active", &self.active.load(Ordering::SeqCst))
            .field("closing", &self.closing.load(Ordering::SeqCst))
            .finish_non_exhaustive()
    }
}

/// How one server is built (`McpServerOptions`).
pub struct McpServerOptions {
    pub registry: Arc<ToolRegistry>,
    pub credentials: Arc<CredentialRegistry>,
    pub challenge: Option<Arc<dyn ScopeChallenge>>,
    pub max_requests: usize,
    pub max_body_bytes: usize,
    pub scheduler: Arc<dyn Scheduler>,
    /// The legacy transport sessions' id generator; the daemon passes its own randomness.
    pub session_ids: Option<SessionIds>,
}

impl McpServerOptions {
    pub fn new(registry: Arc<ToolRegistry>, credentials: Arc<CredentialRegistry>) -> Self {
        McpServerOptions {
            registry,
            credentials,
            challenge: None,
            max_requests: MAX_REQUESTS,
            max_body_bytes: 64 * 1024,
            scheduler: Arc::new(TokioScheduler),
            session_ids: None,
        }
    }
}

impl McpServer {
    pub fn new(options: McpServerOptions) -> Arc<McpServer> {
        Arc::new(McpServer {
            registry: options.registry,
            credentials: options.credentials,
            challenge: options.challenge,
            max_requests: options.max_requests,
            max_body_bytes: options.max_body_bytes,
            scheduler: options.scheduler,
            active: AtomicUsize::new(0),
            closing: AtomicBool::new(false),
            shared: Arc::new(Shared {
                calls: Mutex::new(HashMap::new()),
                toolsets: Mutex::new(OpenToolsets::new()),
                listen: Mutex::new(Streams::default()),
                legacy_streams: Mutex::new(Streams::default()),
                legacy: Mutex::new(LegacySessions::new(
                    NOTIFICATION_STREAMS_TOTAL,
                    options
                        .session_ids
                        .unwrap_or_else(|| Arc::new(default_session_id)),
                )),
                watched: Mutex::new(HashSet::new()),
            }),
        })
    }

    pub fn credentials(&self) -> &Arc<CredentialRegistry> {
        &self.credentials
    }

    /// Every lease is revoked and every later request is 503.
    pub fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.credentials.close();
        self.shared
            .legacy
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .close_all();
    }

    /// Announces a changed tool list to every open stream of `lease`, modern and legacy.
    pub fn tools_changed(&self, lease: LeaseId) {
        self.shared
            .listen
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .tools_changed(lease);
        self.shared
            .legacy_streams
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .tools_changed(lease);
    }

    /// Opens one notification stream for `lease`; `None` at the server-wide cap.
    fn open_stream(
        &self,
        kind: StreamKind,
        lease: LeaseId,
        per_lease: usize,
        session: Option<&str>,
    ) -> Option<NotificationStream> {
        let (id, frames) = self
            .shared
            .stream(kind)
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .open(lease, per_lease, NOTIFICATION_STREAMS_TOTAL)?;
        let shared = Arc::clone(&self.shared);
        let session = session.map(str::to_owned);
        Some(NotificationStream::new(id, frames, move || {
            shared.end_stream(kind, id, session.as_deref());
        }))
    }

    /// Forgets a lease's calls, families, streams and sessions the moment it ends (`forget`,
    /// `http.ts:388`; `toolsets.ts:181`; `legacy-sessions.ts:114`), even while it has no request
    /// in flight.
    fn watch(&self, principal: &Principal) {
        if !self
            .shared
            .watched
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(principal.lease)
        {
            return;
        }
        let shared = Arc::clone(&self.shared);
        let lease = principal.lease;
        principal.lifetime.on_abort(Box::new(move || {
            shared.forget(lease);
            shared
                .watched
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&lease);
        }));
    }

    /// Serves one request. `emit` receives notifications the reply cannot carry (progress).
    pub async fn handle(&self, request: HttpRequest, emit: Emitter) -> HttpResponse {
        if self.closing.load(Ordering::SeqCst) {
            return HttpResponse::empty(503);
        }
        let active = self.active.fetch_add(1, Ordering::SeqCst);
        if active >= self.max_requests {
            self.active.fetch_sub(1, Ordering::SeqCst);
            return HttpResponse::empty(503);
        }
        let response = self.route(request, emit).await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        response
    }

    async fn route(&self, request: HttpRequest, emit: Emitter) -> HttpResponse {
        if request.header_bytes() > MAX_HEADER_BYTES {
            return HttpResponse::empty(431);
        }
        if !localhost_host(request.header("host")) || !localhost_origin(request.header("origin")) {
            return HttpResponse::empty(403);
        }
        if request.path != "/mcp" {
            return HttpResponse::empty(404);
        }
        let principal = self
            .credentials
            .authenticate(bearer(request.header("authorization")));
        let Some(principal) = principal else {
            let parameters = self
                .challenge
                .as_ref()
                .map(|challenge| challenge.parameters(None))
                .unwrap_or_default();
            let mut response = HttpResponse::empty(401);
            response
                .headers
                .push(("www-authenticate".to_owned(), bearer_challenge(&parameters)));
            return response;
        };
        self.watch(&principal);
        // A legacy transport session exists only for a client that opted into its notification
        // stream (`http.ts:619`); every other client is served statelessly.
        let legacy_client = header(&request.headers, "x-ace-notifications") == Some("stream");
        if let Some(id) = request.header("mcp-session-id").map(str::to_owned) {
            if !legacy_client {
                return HttpResponse::empty(404);
            }
            if request.method == "DELETE" {
                let removed = self
                    .shared
                    .legacy
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .close(&id, &principal);
                return if removed {
                    HttpResponse::empty(200)
                } else {
                    HttpResponse::empty(404)
                };
            }
            let known = self
                .shared
                .legacy
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .find(&id, &principal)
                .is_some();
            if !known {
                return HttpResponse::empty(404);
            }
            return match request.method.as_str() {
                "POST" => self.post(request, principal, emit).await,
                // The session's GET is its server-to-client stream (`legacy-sessions.ts:47`).
                "GET" => match self.open_stream(
                    StreamKind::Legacy,
                    principal.lease,
                    LEGACY_SESSIONS_PER_LEASE,
                    Some(&id),
                ) {
                    Some(stream) => HttpResponse::events(stream),
                    None => HttpResponse::empty(503),
                },
                _ => HttpResponse::empty(405),
            };
        }
        // A listen request is a `subscriptions/listen` whose header and body agree
        // (`http.ts:624`).
        if header(&request.headers, "mcp-method") == Some("subscriptions/listen") {
            return self.listen(&principal, &request);
        }
        if legacy_client && request.method != "POST" {
            // The legacy route answers a method it cannot serve with 400, not 405.
            return HttpResponse::empty(400);
        }
        match request.method.as_str() {
            "POST" => {
                let creates = legacy_client && is_legacy_initialize(&request);
                let mut response = self.post(request, principal.clone(), emit).await;
                if creates && response.status == 200 {
                    let opened = self
                        .shared
                        .legacy
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .open(&principal);
                    if let Some(id) = opened {
                        response.headers.push(("mcp-session-id".to_owned(), id));
                    }
                }
                response
            }
            // A legacy DELETE names its session; without one there is nothing to end.
            "DELETE" => HttpResponse::empty(400),
            "GET" | "HEAD" => HttpResponse::empty(405),
            _ => HttpResponse::empty(405),
        }
    }

    /// Opens one `subscriptions/listen` stream for the lease (`principal-bus.ts`). At the
    /// server-wide cap the request is refused, as the SDK refuses its own listen.
    fn listen(&self, principal: &Principal, request: &HttpRequest) -> HttpResponse {
        if request.body.len() > self.max_body_bytes {
            return HttpResponse::empty(413);
        }
        let Ok(Message::Request { id, method, .. }) = Message::parse(&request.body) else {
            return HttpResponse::rpc_failure(
                400,
                RpcError::new(INVALID_REQUEST, "Invalid Request"),
            );
        };
        if method != "subscriptions/listen" {
            return HttpResponse::rpc_failure(
                400,
                RpcError::new(INVALID_REQUEST, "Invalid Request"),
            );
        }
        match self.open_stream(
            StreamKind::Listen,
            principal.lease,
            LISTEN_STREAMS_PER_LEASE,
            None,
        ) {
            Some(stream) => HttpResponse::events(stream),
            None => HttpResponse::json(
                200,
                &Message::failure(
                    Some(&id),
                    RpcError::new(INTERNAL_ERROR, "Subscription limit reached"),
                ),
            ),
        }
    }

    async fn post(
        &self,
        request: HttpRequest,
        principal: Principal,
        emit: Emitter,
    ) -> HttpResponse {
        if request.body.len() > self.max_body_bytes {
            return HttpResponse::empty(413);
        }
        if let Some(challenge) = &self.challenge {
            match scope_refusal(
                &request.body,
                &principal,
                challenge.as_ref(),
                self.max_body_bytes,
                None,
            ) {
                ScopeCheck::Forward(_) => {}
                ScopeCheck::Refuse {
                    status,
                    headers,
                    body,
                } => {
                    return HttpResponse {
                        status,
                        headers,
                        body: body.into_bytes(),
                        stream: None,
                    };
                }
            }
        }
        let message = match Message::parse(&request.body) {
            Ok(message) => message,
            Err(error) => return HttpResponse::rpc_failure(400, error),
        };
        if let Message::Request { id, method, params } = &message
            && method == "tools/call"
            && let Some(failure) = self.mirrored_headers(id, params.as_ref(), &request.headers)
        {
            return failure;
        }
        match message {
            Message::Notification { method, params } => {
                if method == "notifications/cancelled"
                    && let Some(id) = params.as_ref().and_then(|params| params.get("requestId"))
                    && let Some(id) = Id::from_value(id)
                {
                    let key = call_key(&principal, &id);
                    if let Some(abort) = self
                        .shared
                        .calls
                        .lock()
                        .unwrap_or_else(|error| error.into_inner())
                        .get(&key)
                    {
                        abort.abort();
                    }
                }
                HttpResponse::empty(202)
            }
            Message::Response { .. } | Message::Error { .. } => {
                HttpResponse::rpc_failure(400, RpcError::new(-32_600, "Invalid Request"))
            }
            Message::Request { id, method, params } => {
                let result = self
                    .dispatch(&principal, &id, &method, params, emit, &request.headers)
                    .await;
                match result {
                    Ok(result) => HttpResponse::json(200, &Message::reply(&id, result)),
                    Err(error) => HttpResponse::json(200, &Message::failure(Some(&id), error)),
                }
            }
        }
    }

    async fn dispatch(
        &self,
        principal: &Principal,
        id: &Id,
        method: &str,
        params: Option<Value>,
        emit: Emitter,
        headers: &[(String, String)],
    ) -> Result<Value, RpcError> {
        match method {
            "initialize" => Ok(initialize(params.as_ref(), headers)),
            "ping" => Ok(Value::Object(Map::new())),
            "tools/list" => Ok(Value::Object(self.tool_list(principal, headers))),
            "tools/call" => self.tool_call(principal, id, params, emit, headers).await,
            "resources/list" => Ok(Value::Object(self.resource_list())),
            "resources/read" => self.resource_read(principal, params).await,
            _ => Err(RpcError::new(METHOD_NOT_FOUND, "Method not found")),
        }
    }

    /// A field the client mirrors into `Mcp-Param-<header>`: missing or different is 400 before
    /// any effect, as the SDK validates a `McpServer` product's mirrored parameters.
    fn mirrored_headers(
        &self,
        id: &Id,
        params: Option<&Value>,
        headers: &[(String, String)],
    ) -> Option<HttpResponse> {
        let params = params?;
        let name = params.get("name").and_then(Value::as_str)?;
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let call = dispatched_ace_call(name, &arguments);
        for (path, header_name) in self.registry.param_headers(&call.name) {
            let expected = value_at(&call.input, &path);
            let actual = header(headers, &format!("Mcp-Param-{header_name}")).map(decode_header);
            let matches = match (expected, actual) {
                (None, None) => true,
                (Some(value), Some(actual)) => {
                    mirror_text(value).as_deref() == Some(actual.as_str())
                }
                _ => false,
            };
            if !matches {
                return Some(HttpResponse::json(
                    400,
                    &Message::failure(
                        Some(id),
                        RpcError::new(-32_020, format!("Header mismatch: Mcp-Param-{header_name}")),
                    ),
                ));
            }
        }
        None
    }

    /// `grows`: a successful call adds the family it opened to this session's list.
    fn offer(
        &self,
        principal: &Principal,
        name: &str,
        arguments: &Value,
        result: &crate::result::CallToolResult,
    ) {
        let call = dispatched_ace_call(name, arguments);
        let lease = principal.lease;
        let mut toolsets = self
            .shared
            .toolsets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let opened = if crate::tool_names::bare_tool_name(&call.name) == ACE_TOOL_SEARCH {
            let families = found_families(result.structured.as_ref());
            toolsets.add(lease, &families)
        } else {
            toolsets.opened(lease, &call.name, &call.input)
        };
        drop(toolsets);
        if opened {
            self.tools_changed(lease);
        }
    }

    fn tool_list(&self, principal: &Principal, headers: &[(String, String)]) -> Map {
        let listing = tool_listing(header(headers, CORE_TOOLS_HEADER.0));
        let client = ace_client(header(headers, CODEX_CLIENT_HEADER.0));
        let holds = holds_on_demand_tools(listing, client);
        // Where Codex approves `tools_call` on the fixed list, a destructive tool is listed by
        // name so its own prompt is the one that runs, and the wrapper says it never reaches one.
        let names_destructive = crate::toolsets::names_destructive_tools(listing, client);
        let mut tools = Vec::new();
        let toolsets = self
            .shared
            .toolsets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for descriptor in self.registry.list(principal) {
            let set = self.registry.toolset(&descriptor.name);
            let destructive = self.registry.destructive(&descriptor.name);
            let listed = toolsets.lists(principal.lease, listing, &descriptor.name, set.as_deref())
                && !(holds
                    && listed_on_demand(&descriptor.name)
                    && !toolsets.is_open(principal.lease, crate::toolsets::ON_DEMAND_TOOLSET));
            if !(listed || names_destructive && destructive) {
                continue;
            }
            let wrapper = names_destructive
                && crate::tool_names::bare_tool_name(&descriptor.name)
                    == crate::tool_names::ACE_TOOL_DISPATCH;
            tools.push(
                self.registry
                    .descriptor_json_as(&descriptor, wrapper.then_some(false)),
            );
        }
        let mut map = Map::with_capacity(1);
        map.insert("tools", Value::Array(tools.into()));
        map
    }

    fn resource_list(&self) -> Map {
        let mut status = Map::with_capacity(4);
        status.insert("uri", Value::from("ace://status"));
        status.insert(
            "name",
            Value::from("ace status: access mode and tool groups"),
        );
        status.insert(
            "description",
            Value::from("The context tool's status topic."),
        );
        status.insert("mimeType", Value::from("application/json"));
        let mut map = Map::with_capacity(1);
        map.insert(
            "resources",
            Value::Array(vec![Value::Object(status)].into()),
        );
        map
    }

    async fn resource_read(
        &self,
        principal: &Principal,
        params: Option<Value>,
    ) -> Result<Value, RpcError> {
        let uri = params
            .as_ref()
            .and_then(|params| params.get("uri"))
            .and_then(Value::as_str)
            .ok_or_else(|| RpcError::new(INVALID_PARAMS, "Invalid params"))?;
        if uri != "ace://status" {
            return Err(RpcError::new(INTERNAL_ERROR, "Unknown resource"));
        }
        let mut arguments = Map::with_capacity(1);
        arguments.insert("topics", Value::Array(vec![Value::from("status")].into()));
        let result = self
            .registry
            .call(
                "context",
                Value::Object(arguments),
                principal,
                &Abort::new(),
                CallOptions::default(),
            )
            .await;
        if result.is_error {
            return Err(RpcError::new(INTERNAL_ERROR, "Context unavailable"));
        }
        let Some(structured) = result.structured else {
            return Err(RpcError::new(INTERNAL_ERROR, "Context unavailable"));
        };
        let status = structured.get("status").cloned().unwrap_or(Value::Null);
        let mut content = Map::with_capacity(3);
        content.insert("uri", Value::from("ace://status"));
        content.insert("mimeType", Value::from("application/json"));
        content.insert(
            "text",
            Value::String(JsString::from(ace_json::to_string(&status))),
        );
        let mut map = Map::with_capacity(1);
        map.insert(
            "contents",
            Value::Array(vec![Value::Object(content)].into()),
        );
        Ok(Value::Object(map))
    }

    async fn tool_call(
        &self,
        principal: &Principal,
        id: &Id,
        params: Option<Value>,
        emit: Emitter,
        headers: &[(String, String)],
    ) -> Result<Value, RpcError> {
        let Some(params) = params else {
            return Err(RpcError::new(INVALID_PARAMS, "Invalid params"));
        };
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return Err(RpcError::new(INVALID_PARAMS, "Invalid params"));
        };
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| Value::Object(Map::new()));
        let meta = params.get("_meta");
        let acting_for = meta.and_then(|meta| crate::toolsets::acting_for_of(Some(meta)));
        let listing = tool_listing(header(headers, CORE_TOOLS_HEADER.0));
        let client = ace_client(header(headers, CODEX_CLIENT_HEADER.0));
        let budget = call_budget_seconds(header(headers, CALL_BUDGET_HEADER));
        let key = call_key(principal, id);
        {
            let mut calls = self
                .shared
                .calls
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if calls.contains_key(&key) {
                return Ok(duplicate_id_result());
            }
            calls.insert(key.clone(), Abort::new());
        }
        let abort = self
            .shared
            .calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&key)
            .cloned()
            .unwrap_or_else(Abort::new);
        let progress_token = meta
            .and_then(|meta| meta.get("progressToken"))
            .and_then(|token| {
                token.as_str().map(str::to_owned).or_else(|| {
                    token
                        .as_f64()
                        .map(|value| ace_json::to_string(&Value::from(value)))
                })
            });
        let stop = progress(
            progress_token,
            Arc::clone(&emit),
            Arc::clone(&self.scheduler),
        );
        let target = match dispatch_target(
            name,
            &arguments,
            listing,
            crate::toolsets::names_destructive_tools(listing, client),
            &self.registry,
        ) {
            Ok(target) => target,
            Err(failure) => {
                stop();
                self.shared
                    .calls
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&key);
                return Ok(failure.to_json());
            }
        };
        let result = self
            .registry
            .call(
                &target.name,
                target.input,
                principal,
                &abort,
                CallOptions {
                    listing: Some(listing),
                    client,
                    call_budget_seconds: budget,
                    acting_for,
                },
            )
            .await;
        stop();
        self.shared
            .calls
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&key);
        if !result.is_error {
            self.offer(principal, name, &arguments, &result);
        }
        // The reply names the call the client made, with the result the tool produced.
        Ok(result.to_json())
    }
}

/// `Mcp-Param-*` carries `=?base64?…?=` for a value a header cannot hold verbatim.
fn decode_header(value: &str) -> String {
    if let Some(encoded) = value
        .strip_prefix("=?base64?")
        .and_then(|rest| rest.strip_suffix("?="))
    {
        use base64::Engine as _;
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded)
            && let Ok(text) = String::from_utf8(bytes)
        {
            return text;
        }
    }
    value.to_owned()
}

/// A mirrored value as its header spells it: strings verbatim, numbers and booleans as JSON.
fn mirror_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.as_str().to_owned()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(_) => Some(ace_json::to_string(value)),
        _ => None,
    }
}

/// A value at a dotted field path (`a.b.0`).
fn value_at<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = match current {
            Value::Object(map) => map.get(segment)?,
            Value::Array(items) => items.get(segment.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(current)
}

/// The default session id (`randomUUID`): a UUID v4 from the OS.
fn default_session_id() -> String {
    let mut bytes = [0_u8; 16];
    if getrandom::fill(&mut bytes).is_err() {
        // A machine without an entropy source still gets a unique id, not a secret.
        static FALLBACK: AtomicUsize = AtomicUsize::new(0);
        let next = FALLBACK.fetch_add(1, Ordering::SeqCst) as u64;
        bytes[..8].copy_from_slice(&next.to_be_bytes());
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

/// Whether a POST is a 2025 `initialize` that opens a transport session (`isLegacyRequest`).
fn is_legacy_initialize(request: &HttpRequest) -> bool {
    if request.header("mcp-method").is_some() {
        return false;
    }
    let Ok(Message::Request { method, params, .. }) = Message::parse(&request.body) else {
        return false;
    };
    if method != "initialize" {
        return false;
    }
    let version = params
        .as_ref()
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str);
    !matches!(version, Some(LATEST_PROTOCOL))
}

fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    let name = name.to_ascii_lowercase();
    headers
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.as_str())
}

/// `initialize`'s result (`http.ts:437`).
fn initialize(params: Option<&Value>, headers: &[(String, String)]) -> Value {
    let requested = params
        .and_then(|params| params.get("protocolVersion"))
        .and_then(Value::as_str);
    let version = requested
        .filter(|version| PROTOCOL_VERSIONS.contains(version))
        .unwrap_or(LATEST_PROTOCOL);
    // Never advertise what cannot be delivered: a 2026 client's listen is routed, and a legacy
    // client that opted into its GET stream can hear changes; anyone else cannot.
    let deliverable = requested == Some(LATEST_PROTOCOL)
        || header(headers, "mcp-method").is_some()
        || header(headers, "x-ace-notifications") == Some("stream");
    let mut tools = Map::with_capacity(1);
    if deliverable {
        tools.insert("listChanged", Value::Bool(true));
    }
    let mut capabilities = Map::with_capacity(2);
    capabilities.insert("tools", Value::Object(tools));
    capabilities.insert("resources", Value::Object(Map::new()));
    let mut server = Map::with_capacity(2);
    server.insert("name", Value::from(SERVER_NAME));
    server.insert("version", Value::from(SERVER_VERSION));
    let mut map = Map::with_capacity(4);
    map.insert("protocolVersion", Value::from(version));
    map.insert("capabilities", Value::Object(capabilities));
    map.insert("serverInfo", Value::Object(server));
    // A native-app client reads its own instructions; every other client gets ace's text.
    if header(headers, "X-Ace-Instructions") != Some("native")
        && let Ok(catalog) = crate::catalog::catalog()
    {
        map.insert(
            "instructions",
            Value::String(JsString::from(catalog.instructions.instructions.as_str())),
        );
    }
    Value::Object(map)
}

/// The families a `tools_find` result matched (`foundFamilies`, `meta-tools.ts`).
fn found_families(structured: Option<&Value>) -> Vec<String> {
    let Some(matches) = structured
        .and_then(|value| value.get("matches"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    let mut families: Vec<String> = Vec::new();
    for entry in matches.iter() {
        if let Some(family) = entry.get("family").and_then(Value::as_str)
            && !families.iter().any(|found| found == family)
        {
            families.push(family.to_owned());
        }
    }
    families
}

/// "Duplicate active request id" (`http.ts:561`).
fn duplicate_id_result() -> Value {
    let mut content = Map::with_capacity(2);
    content.insert("type", Value::from("text"));
    content.insert("text", Value::from("Duplicate active request id"));
    let mut map = Map::with_capacity(2);
    map.insert("isError", Value::Bool(true));
    map.insert("content", Value::Array(vec![Value::Object(content)].into()));
    Value::Object(map)
}

fn call_key(principal: &Principal, id: &Id) -> CallKey {
    CallKey {
        lease: principal.lease,
        id: id.key(),
    }
}

/// The tool a `tools/call` runs. `tools_call` is validated against its own schema, refused where
/// the session lists every tool, and refused for a destructive target where Codex approves it on
/// the fixed list (`meta-tools.ts:149`, `http.ts:535`): those targets keep their own prompt.
fn dispatch_target(
    name: &str,
    arguments: &Value,
    listing: ToolListing,
    names_destructive: bool,
    registry: &ToolRegistry,
) -> Result<DispatchedCall, CallToolResult> {
    if crate::tool_names::bare_tool_name(name) != ACE_TOOL_DISPATCH {
        return Ok(dispatched_ace_call(name, arguments));
    }
    let Some(object) = arguments.as_object() else {
        return Err(invalid_arguments(Some("(root)")));
    };
    if let Some((key, _)) = object
        .iter()
        .find(|(key, _)| key.as_str() != "name" && key.as_str() != "arguments")
    {
        return Err(invalid_arguments(Some(key.as_str())));
    }
    let Some(target) = object.get("name").and_then(Value::as_str) else {
        return Err(invalid_arguments(Some("name")));
    };
    // Zod's `.min(1).max(128)` counts code points, as ADR 0125 reads every length.
    let length = target.chars().count();
    let bare = crate::tool_names::bare_tool_name(target);
    if length == 0 || length > 128 || bare == ACE_TOOL_SEARCH || bare == ACE_TOOL_DISPATCH {
        return Err(invalid_arguments(Some("name")));
    }
    let input = match object.get("arguments") {
        None => Value::Object(Map::new()),
        Some(Value::Object(map)) => Value::Object(map.clone()),
        Some(_) => return Err(invalid_arguments(Some("arguments"))),
    };
    if !dispatches(listing) {
        return Err(fixed_failure("tool_unavailable"));
    }
    if names_destructive && registry.destructive(&bare) {
        return Err(fixed_failure("call_directly"));
    }
    Ok(DispatchedCall { name: bare, input })
}

/// `invalid_arguments` with the field the wrapper broke, as `parseToolArguments` names it.
fn invalid_arguments(field: Option<&str>) -> CallToolResult {
    let Some(error) = PublicToolError::new("invalid_arguments") else {
        return CallToolResult::failure("{\"code\":\"invalid_arguments\"}");
    };
    let issues = field.map_or_else(Vec::new, |field| {
        vec![PublicIssue {
            path: field.to_owned(),
            expected: "a value this tool's schema accepts".to_owned(),
        }]
    });
    tool_failure(ToolFailure::Public(Box::new(error.with_issues(issues))))
}

/// `progressHeartbeat` (`progress-heartbeat.ts`): a beat every 30 s while the call runs.
fn progress(
    token: Option<String>,
    emit: Emitter,
    scheduler: Arc<dyn Scheduler>,
) -> Box<dyn Fn() + Send + Sync> {
    let Some(token) = token else {
        return Box::new(|| {});
    };
    let beat = Arc::new(Beat {
        stopped: AtomicBool::new(false),
        progress: AtomicUsize::new(0),
        token,
        emit,
        scheduler,
        guard: Mutex::new(None),
    });
    beat.arm();
    Box::new(move || beat.stopped.store(true, Ordering::SeqCst))
}

struct Beat {
    stopped: AtomicBool,
    progress: AtomicUsize,
    token: String,
    emit: Emitter,
    scheduler: Arc<dyn Scheduler>,
    guard: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}

impl Beat {
    fn arm(self: &Arc<Self>) {
        let beat = Arc::clone(self);
        let guard = self
            .scheduler
            .after(PROGRESS_INTERVAL_MS, Box::new(move || beat.fire()));
        *self.guard.lock().unwrap_or_else(|error| error.into_inner()) = Some(guard);
    }

    fn fire(self: &Arc<Self>) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let progress = self.progress.fetch_add(1, Ordering::SeqCst) + 1;
        let mut params = Map::with_capacity(3);
        params.insert(
            "progressToken",
            Value::String(JsString::from(self.token.as_str())),
        );
        params.insert("progress", Value::from(progress as f64));
        params.insert("message", Value::from("Still running"));
        (self.emit)(Message::notification(
            "notifications/progress",
            Value::Object(params),
        ));
        self.arm();
    }
}

/// Whether `host` names this machine's loopback (`localhostHostValidation`).
pub fn localhost_host(host: Option<&str>) -> bool {
    let Some(host) = host else {
        return false;
    };
    let authority = host.rsplit('@').next().unwrap_or(host);
    let name = if let Some(rest) = authority.strip_prefix('[') {
        // IPv6: [::1]:port
        match rest.split_once(']') {
            Some((address, _)) => address,
            None => return false,
        }
    } else {
        authority.split(':').next().unwrap_or_default()
    };
    matches!(name, "localhost" | "127.0.0.1" | "::1")
}

/// Whether `origin`, when present, is a loopback origin (`localhostOriginValidation`).
pub fn localhost_origin(origin: Option<&str>) -> bool {
    let Some(origin) = origin else {
        return true;
    };
    let Some(rest) = origin.strip_prefix("http://") else {
        return false;
    };
    localhost_host(Some(rest))
}

#[cfg(test)]
#[path = "http/tests.rs"]
mod tests;
