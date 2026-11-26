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

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use ace_json::{JsString, Map, Value};

use crate::credentials::{CredentialRegistry, Principal};
use crate::jsonrpc::{INTERNAL_ERROR, INVALID_PARAMS, Id, METHOD_NOT_FOUND, Message, RpcError};
use crate::limits::{MAX_HEADER_BYTES, MAX_REQUESTS, PROGRESS_INTERVAL_MS};
use crate::registry::{CallOptions, ToolRegistry};
use crate::scope::{ScopeChallenge, ScopeCheck, bearer, bearer_challenge, scope_refusal};
use crate::signal::{Abort, Scheduler, TokioScheduler};
use crate::tool_names::{ACE_TOOL_SEARCH, dispatched_ace_call};
use crate::toolsets::{
    CALL_BUDGET_HEADER, CODEX_CLIENT_HEADER, CORE_TOOLS_HEADER, OpenToolsets, ace_client,
    call_budget_seconds, holds_on_demand_tools, listed_on_demand, tool_listing,
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

/// One response the listener writes.
#[derive(Debug, Clone)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn empty(status: u16) -> HttpResponse {
        HttpResponse {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    pub fn json(status: u16, value: &Value) -> HttpResponse {
        HttpResponse {
            status,
            headers: vec![("content-type".to_owned(), "application/json".to_owned())],
            body: ace_json::to_string(value).into_bytes(),
        }
    }

    /// A JSON-RPC error whose HTTP status is 400, as the SDK writes a parse failure.
    pub fn rpc_failure(status: u16, error: RpcError) -> HttpResponse {
        HttpResponse::json(status, &Message::failure(None, error))
    }
}

/// A notification the server sends outside the request's reply (progress, list changes).
pub type Emitter = Arc<dyn Fn(Value) + Send + Sync>;

/// Counts the listen streams a lease may hold and the server's total (`principal-bus.ts`).
#[derive(Default)]
pub struct Streams {
    per_lease: HashMap<String, usize>,
    total: usize,
    frames: HashMap<String, Vec<Value>>,
}

impl Streams {
    /// Opens one stream for `lease`; `None` when the lease or the server is at its bound.
    pub fn open(&mut self, lease: &str, per_lease: usize, total: usize) -> Option<u64> {
        let held = self.per_lease.get(lease).copied().unwrap_or(0);
        if held >= per_lease || self.total >= total {
            return None;
        }
        *self.per_lease.entry(lease.to_owned()).or_insert(0) += 1;
        self.total += 1;
        let frames = self.frames.entry(lease.to_owned()).or_default();
        let id = frames.len() as u64;
        frames.push(Value::Null);
        Some(id)
    }

    pub fn close(&mut self, lease: &str) {
        if let Some(held) = self.per_lease.get_mut(lease) {
            if *held > 0 {
                *held -= 1;
                self.total = self.total.saturating_sub(1);
            }
            if *held == 0 {
                self.per_lease.remove(lease);
            }
        }
    }

    /// Queues `tools/list_changed` for every stream of `lease` (`toolsChanged`).
    pub fn tools_changed(&mut self, lease: &str) {
        if let Some(frames) = self.frames.get_mut(lease) {
            for frame in frames.iter_mut() {
                *frame = Message::notification(
                    "notifications/tools/list_changed",
                    Value::Object(Map::new()),
                );
            }
        }
    }

    pub fn held(&self, lease: &str) -> usize {
        self.per_lease.get(lease).copied().unwrap_or(0)
    }
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
    calls: Mutex<HashMap<String, Abort>>,
    toolsets: Mutex<OpenToolsets>,
    streams: Mutex<Streams>,
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
            calls: Mutex::new(HashMap::new()),
            toolsets: Mutex::new(OpenToolsets::new()),
            streams: Mutex::new(Streams::default()),
        })
    }

    pub fn credentials(&self) -> &Arc<CredentialRegistry> {
        &self.credentials
    }

    /// Every lease is revoked and every later request is 503.
    pub fn close(&self) {
        self.closing.store(true, Ordering::SeqCst);
        self.credentials.close();
    }

    /// Announces a changed tool list to every open stream of `lease`.
    pub fn tools_changed(&self, lease: &str) {
        self.streams
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .tools_changed(lease);
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
        match request.method.as_str() {
            "POST" => self.post(request, principal, emit).await,
            "GET" | "HEAD" | "DELETE" => HttpResponse::empty(405),
            _ => HttpResponse::empty(405),
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
                    };
                }
            }
        }
        let message = match Message::parse(&request.body) {
            Ok(message) => message,
            Err(error) => return HttpResponse::rpc_failure(400, error),
        };
        match message {
            Message::Notification { method, params } => {
                if method == "notifications/cancelled"
                    && let Some(id) = params.as_ref().and_then(|params| params.get("requestId"))
                    && let Some(id) = Id::from_value(id)
                {
                    let key = call_key(&principal, &id);
                    if let Some(abort) = self
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

    /// `grows`: a successful call adds the family it opened to this session's list.
    fn offer(
        &self,
        principal: &Principal,
        name: &str,
        arguments: &Value,
        result: &crate::result::CallToolResult,
    ) {
        let call = dispatched_ace_call(name, arguments);
        let mut toolsets = self
            .toolsets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let session = &principal.scope.session_id;
        let opened = if crate::tool_names::bare_tool_name(&call.name) == ACE_TOOL_SEARCH {
            let families = found_families(result.structured.as_ref());
            toolsets.add(session, &families)
        } else {
            toolsets.opened(session, &call.name, &call.input)
        };
        drop(toolsets);
        if opened {
            self.tools_changed(session);
        }
    }

    fn tool_list(&self, principal: &Principal, headers: &[(String, String)]) -> Map {
        let listing = tool_listing(header(headers, CORE_TOOLS_HEADER.0));
        let client = ace_client(header(headers, CODEX_CLIENT_HEADER.0));
        let holds = holds_on_demand_tools(listing, client);
        let mut tools = Vec::new();
        let toolsets = self
            .toolsets
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        for descriptor in self.registry.list(principal) {
            let set = self.registry.toolset(&descriptor.name);
            if !toolsets.lists(
                &principal.scope.session_id,
                listing,
                &descriptor.name,
                set.as_deref(),
            ) {
                continue;
            }
            if holds
                && listed_on_demand(&descriptor.name)
                && !toolsets.is_open(
                    &principal.scope.session_id,
                    crate::toolsets::ON_DEMAND_TOOLSET,
                )
            {
                continue;
            }
            tools.push(self.registry.descriptor_json(&descriptor));
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
            let mut calls = self.calls.lock().unwrap_or_else(|error| error.into_inner());
            if calls.contains_key(&key) {
                return Ok(duplicate_id_result());
            }
            calls.insert(key.clone(), Abort::new());
        }
        let abort = self
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
        let target = dispatched_ace_call(name, &arguments);
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
        self.calls
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
    let mut tools = Map::with_capacity(1);
    tools.insert("listChanged", Value::Bool(true));
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

fn call_key(principal: &Principal, id: &Id) -> String {
    format!("{}:{}", principal.scope.session_id, id.key())
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
