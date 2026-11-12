//! A fake app on 127.0.0.1: a remote MCP server guarded by OAuth, and the OAuth server itself
//! (issuer `http://127.0.0.1:<port>/tenant`, so metadata discovery has a path to insert). It
//! holds to what the MCP authorization spec asks of servers:
//!
//! - `/mcp` answers 401 with a `WWW-Authenticate` challenge naming its protected-resource
//!   metadata and scopes until a valid access token comes;
//! - dynamic client registration (can be switched off), PKCE S256, exact redirect checks,
//!   `resource` on both requests, `iss` in the redirect, rotating refresh tokens;
//! - a static token can be accepted instead, for servers that take an API key;
//! - client ID metadata documents when switched on: a URL client ID is fetched and checked as
//!   [`crate::client_document::fetch_and_check`] does.
//!
//! Tests drive the sign-in by fetching the authorization address with [`FakeConnector::approve`],
//! which plays the person approving and returns the redirect the browser would follow.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::Form;
use axum::extract::{Query, Request, State as Shared};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, ErrorData,
    Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
    Tool, ToolAnnotations, ToolsCapability,
};
use rmcp::service::{NotificationContext, RequestContext};
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use rmcp::{Peer, RoleServer, ServerHandler};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;
use tower::Layer;

/// What the fake has seen and issued.
#[derive(Default)]
struct Book {
    /// Registered clients: id → redirect URIs.
    clients: HashMap<String, Vec<String>>,
    /// Codes not yet used: code → (client, redirect, challenge, resource).
    codes: HashMap<String, (String, String, String, String)>,
    access: Vec<String>,
    refresh: Vec<String>,
    /// Every `resource` value received, in order.
    resources: Vec<String>,
    /// Query of the last authorization request.
    last_authorize: HashMap<String, String>,
}

struct State {
    base: Mutex<String>,
    book: Mutex<Book>,
    tools: Mutex<Vec<Tool>>,
    peers: Mutex<Vec<Peer<RoleServer>>>,
    registration: AtomicBool,
    /// Fetches the metadata document a URL client ID names, and says so in its metadata.
    client_documents: AtomicBool,
    documents_fetched: AtomicUsize,
    /// Names itself in the redirect (`iss`, RFC 9207), as it says in its metadata.
    names_itself: AtomicBool,
    endless_metadata: AtomicBool,
    /// Tool listings fail with an error quoting the credentials the server knows.
    leaky_listing: AtomicBool,
    /// Every token request waits this long before it is answered.
    token_delay: Mutex<std::time::Duration>,
    /// When set, a code exchange is refused with this as its `error_description`.
    refuse_codes: Mutex<Option<String>>,
    pkce: AtomicBool,
    static_token: Mutex<Option<String>>,
    expires_in: AtomicU64,
    serial: AtomicU64,
    tool_runs: AtomicUsize,
    token_requests: AtomicUsize,
    /// Every bearer `/mcp` saw, valid or not.
    bearers: Mutex<Vec<String>>,
}

#[derive(Clone)]
struct Fake(Arc<State>);

pub struct FakeConnector {
    state: Arc<State>,
    addr: SocketAddr,
    stop: CancellationToken,
}

impl FakeConnector {
    /// An OAuth-guarded server offering `tools`.
    pub async fn start(tools: Vec<Tool>) -> Self {
        let state = Arc::new(State {
            base: Mutex::default(),
            book: Mutex::default(),
            tools: Mutex::new(tools),
            peers: Mutex::default(),
            registration: AtomicBool::new(true),
            client_documents: AtomicBool::new(false),
            documents_fetched: AtomicUsize::new(0),
            names_itself: AtomicBool::new(true),
            endless_metadata: AtomicBool::new(false),
            leaky_listing: AtomicBool::new(false),
            refuse_codes: Mutex::new(None),
            token_delay: Mutex::new(std::time::Duration::ZERO),
            pkce: AtomicBool::new(true),
            static_token: Mutex::new(None),
            expires_in: AtomicU64::new(3600),
            serial: AtomicU64::new(0),
            tool_runs: AtomicUsize::new(0),
            token_requests: AtomicUsize::new(0),
            bearers: Mutex::default(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap_or_else(|e| panic!("bind: {e}"));
        let addr = listener
            .local_addr()
            .unwrap_or_else(|e| panic!("addr: {e}"));
        *lock(&state.base) = format!("http://{addr}");
        let stop = CancellationToken::new();
        let fake = Fake(state.clone());
        let mcp = StreamableHttpService::new(
            move || Ok(fake.clone()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default().with_cancellation_token(stop.child_token()),
        );
        let guarded = middleware::from_fn_with_state(state.clone(), guard).layer(mcp);
        let app = axum::Router::new()
            .nest_service("/mcp", guarded)
            .route(
                "/.well-known/oauth-protected-resource/mcp",
                get(resource_metadata),
            )
            .route(
                "/.well-known/oauth-authorization-server/tenant",
                get(server_metadata),
            )
            .route("/tenant/register", post(register))
            .route("/tenant/authorize", get(authorize))
            .route("/tenant/token", post(token))
            .with_state(state.clone());
        let stopping = stop.clone();
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move { stopping.cancelled().await })
                .await;
        });
        Self { state, addr, stop }
    }

    /// The MCP endpoint.
    pub fn url(&self) -> String {
        format!("http://{}/mcp", self.addr)
    }

    pub fn issuer(&self) -> String {
        format!("http://{}/tenant", self.addr)
    }

    /// Accept `token` as a bearer as well (an API key).
    pub fn accept_token(&self, token: &str) {
        *lock(&self.state.static_token) = Some(token.to_owned());
    }

    /// Leave `iss` out of the redirect and out of the metadata, as many servers still do.
    pub fn without_iss(&self) {
        self.state.names_itself.store(false, Ordering::SeqCst);
    }

    /// Accept URL client IDs, fetching each client ID metadata document, and advertise it.
    pub fn fetch_client_documents(&self) {
        self.state.client_documents.store(true, Ordering::SeqCst);
    }

    /// How many client ID metadata documents it fetched and accepted.
    pub fn documents_fetched(&self) -> usize {
        self.state.documents_fetched.load(Ordering::SeqCst)
    }

    /// Stop offering dynamic client registration.
    pub fn without_registration(&self) {
        self.state.registration.store(false, Ordering::SeqCst);
    }

    /// From now on, listing tools fails with an error that quotes the bearer it was sent and the
    /// refresh token it issued, as a careless server might.
    pub fn leaky_listing(&self) {
        self.state.leaky_listing.store(true, Ordering::SeqCst);
    }

    /// Its protected-resource metadata never ends: chunks keep coming, with no length given.
    pub fn endless_metadata(&self) {
        self.state.endless_metadata.store(true, Ordering::SeqCst);
    }

    /// Token requests are answered only after `delay`, so a renewal can be caught in flight.
    pub fn slow_tokens(&self, delay: std::time::Duration) {
        *lock(&self.state.token_delay) = delay;
    }

    /// Refuses every code exchange with `description` as the error's text.
    pub fn refuse_code_exchange(&self, description: &str) {
        *lock(&self.state.refuse_codes) = Some(description.to_owned());
    }

    /// Stop advertising PKCE.
    pub fn without_pkce(&self) {
        self.state.pkce.store(false, Ordering::SeqCst);
    }

    /// Access tokens issued from now on say they last this long.
    pub fn tokens_last(&self, seconds: u64) {
        self.state.expires_in.store(seconds, Ordering::SeqCst);
    }

    /// Every access token issued so far stops working (as if it expired early).
    pub fn expire_access_tokens(&self) {
        lock(&self.state.book).access.clear();
    }

    /// Every refresh token stops working (the person revoked Spade).
    pub fn revoke_refresh_tokens(&self) {
        lock(&self.state.book).refresh.clear();
    }

    /// Plays the person approving the sign-in at `authorize_url`: returns the address the
    /// browser is sent back to (Spade's callback, with code, state and iss).
    pub async fn approve(&self, authorize_url: &str) -> String {
        let client = reqwest_like_get(authorize_url).await;
        client.unwrap_or_else(|e| panic!("authorize: {e}"))
    }

    pub fn registrations(&self) -> usize {
        lock(&self.state.book).clients.len()
    }

    pub fn token_requests(&self) -> usize {
        self.state.token_requests.load(Ordering::SeqCst)
    }

    pub fn tool_runs(&self) -> usize {
        self.state.tool_runs.load(Ordering::SeqCst)
    }

    /// Every `resource` the token and authorization endpoints received.
    pub fn resources(&self) -> Vec<String> {
        lock(&self.state.book).resources.clone()
    }

    /// The last authorization request's query.
    pub fn last_authorize(&self) -> HashMap<String, String> {
        lock(&self.state.book).last_authorize.clone()
    }

    /// Every token issued, access and refresh, still valid or not; to check none leaks.
    pub fn issued_tokens(&self) -> Vec<String> {
        let serial = self.state.serial.load(Ordering::SeqCst);
        (1..=serial)
            .flat_map(|n| [format!("at-secret-{n}"), format!("rt-secret-{n}")])
            .collect()
    }

    /// Bearers `/mcp` received.
    pub fn bearers(&self) -> Vec<String> {
        lock(&self.state.bearers).clone()
    }

    /// Adds a tool without telling anyone, as a server that never sends list changes does.
    pub fn add_tool_quietly(&self, tool: Tool) {
        lock(&self.state.tools).push(tool);
    }

    /// Adds a tool and tells every session the list changed.
    pub async fn add_tool_and_notify(&self, tool: Tool) {
        lock(&self.state.tools).push(tool);
        let peers = lock(&self.state.peers).clone();
        for peer in peers {
            let _ = peer.notify_tool_list_changed().await;
        }
    }
}

impl Drop for FakeConnector {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// A GET that does not follow redirects; returns the `Location`.
async fn reqwest_like_get(address: &str) -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = address.strip_prefix("http://").ok_or("not http")?;
    let (host, path) = rest.split_once('/').ok_or("no path")?;
    let mut stream = tokio::net::TcpStream::connect(host)
        .await
        .map_err(|e| e.to_string())?;
    let request = format!("GET /{path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut answer = String::new();
    stream
        .read_to_string(&mut answer)
        .await
        .map_err(|e| e.to_string())?;
    answer
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("location")
                .then(|| value.trim().to_owned())
        })
        .ok_or_else(|| format!("no redirect: {}", answer.lines().next().unwrap_or("")))
}

async fn guard(Shared(state): Shared<Arc<State>>, request: Request, next: Next) -> Response {
    let bearer = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_owned);
    if let Some(bearer) = &bearer {
        lock(&state.bearers).push(bearer.clone());
    }
    let valid = bearer.is_some_and(|b| {
        lock(&state.book).access.contains(&b) || lock(&state.static_token).as_deref() == Some(&b)
    });
    if valid {
        return next.run(request).await;
    }
    let base = lock(&state.base).clone();
    let challenge = format!(
        "Bearer resource_metadata=\"{base}/.well-known/oauth-protected-resource/mcp\", scope=\"read write\""
    );
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, challenge)],
    )
        .into_response()
}

async fn resource_metadata(Shared(state): Shared<Arc<State>>) -> Response {
    if state.endless_metadata.load(Ordering::SeqCst) {
        let chunk = axum::body::Bytes::from(vec![b' '; 16 * 1024]);
        let endless = futures_util::stream::repeat_with(move || {
            Ok::<_, std::convert::Infallible>(chunk.clone())
        });
        return (
            [(header::CONTENT_TYPE, "application/json")],
            axum::body::Body::from_stream(endless),
        )
            .into_response();
    }
    let base = lock(&state.base).clone();
    axum::Json(json!({
        "resource": format!("{base}/mcp"),
        "authorization_servers": [format!("{base}/tenant")],
        "scopes_supported": ["read"],
    }))
    .into_response()
}

async fn server_metadata(Shared(state): Shared<Arc<State>>) -> Response {
    let base = lock(&state.base).clone();
    let mut metadata = json!({
        "issuer": format!("{base}/tenant"),
        "authorization_endpoint": format!("{base}/tenant/authorize"),
        "token_endpoint": format!("{base}/tenant/token"),
        "scopes_supported": ["read", "write", "offline_access"],
        "authorization_response_iss_parameter_supported": state.names_itself.load(Ordering::SeqCst),
        "token_endpoint_auth_methods_supported": ["none"],
    });
    if state.client_documents.load(Ordering::SeqCst) {
        metadata["client_id_metadata_document_supported"] = json!(true);
    }
    if state.registration.load(Ordering::SeqCst) {
        metadata["registration_endpoint"] = json!(format!("{base}/tenant/register"));
    }
    if state.pkce.load(Ordering::SeqCst) {
        metadata["code_challenge_methods_supported"] = json!(["S256"]);
    }
    axum::Json(metadata).into_response()
}

async fn register(
    Shared(state): Shared<Arc<State>>,
    axum::Json(body): axum::Json<Value>,
) -> Response {
    if !state.registration.load(Ordering::SeqCst) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let redirects: Vec<String> = body["redirect_uris"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if redirects.is_empty() || body["token_endpoint_auth_method"] != "none" {
        return (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({"error": "invalid_client_metadata"})),
        )
            .into_response();
    }
    let mut book = lock(&state.book);
    let id = format!("client-{}", book.clients.len() + 1);
    book.clients.insert(id.clone(), redirects.clone());
    (
        StatusCode::CREATED,
        axum::Json(json!({ "client_id": id, "redirect_uris": redirects, "token_endpoint_auth_method": "none" })),
    )
        .into_response()
}

async fn authorize(
    Shared(state): Shared<Arc<State>>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let base = lock(&state.base).clone();
    let get = |k: &str| query.get(k).cloned().unwrap_or_default();
    let (client, redirect) = (get("client_id"), get("redirect_uri"));
    lock(&state.book).last_authorize = query.clone();
    let document = state.client_documents.load(Ordering::SeqCst) && client.starts_with("http");
    if document {
        if let Err(why) = crate::client_document::fetch_and_check(&client, &redirect).await {
            return (StatusCode::BAD_REQUEST, format!("invalid_client: {why}")).into_response();
        }
        state.documents_fetched.fetch_add(1, Ordering::SeqCst);
    }
    let mut book = lock(&state.book);
    if !document
        && !book
            .clients
            .get(&client)
            .is_some_and(|r| r.contains(&redirect))
    {
        return (StatusCode::BAD_REQUEST, "unknown client or redirect").into_response();
    }
    if get("code_challenge_method") != "S256" || get("code_challenge").is_empty() {
        return (StatusCode::BAD_REQUEST, "PKCE S256 required").into_response();
    }
    book.resources.push(get("resource"));
    let code = format!("code-{}", book.codes.len() + 1);
    book.codes.insert(
        code.clone(),
        (
            client,
            redirect.clone(),
            get("code_challenge"),
            get("resource"),
        ),
    );
    let mut location = format!("{redirect}?code={code}&state={}", encode(&get("state")));
    if state.names_itself.load(Ordering::SeqCst) {
        location.push_str(&format!("&iss={}", encode(&format!("{base}/tenant"))));
    }
    (StatusCode::FOUND, [(header::LOCATION, location)]).into_response()
}

async fn token(
    Shared(state): Shared<Arc<State>>,
    _headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    state.token_requests.fetch_add(1, Ordering::SeqCst);
    let delay = *lock(&state.token_delay);
    tokio::time::sleep(delay).await;
    let get = |k: &str| form.get(k).cloned().unwrap_or_default();
    let refused = || {
        (
            StatusCode::BAD_REQUEST,
            axum::Json(json!({ "error": "invalid_grant" })),
        )
            .into_response()
    };
    let mut book = lock(&state.book);
    book.resources.push(get("resource"));
    match get("grant_type").as_str() {
        "authorization_code" => {
            if let Some(description) = lock(&state.refuse_codes).clone() {
                return (
                    StatusCode::BAD_REQUEST,
                    axum::Json(
                        json!({ "error": "invalid_grant", "error_description": description }),
                    ),
                )
                    .into_response();
            }
            let Some((client, redirect, challenge, resource)) = book.codes.remove(&get("code"))
            else {
                return refused();
            };
            let verified = URL_SAFE_NO_PAD.encode(Sha256::digest(get("code_verifier").as_bytes()));
            if client != get("client_id")
                || redirect != get("redirect_uri")
                || verified != challenge
                || resource != get("resource")
            {
                return refused();
            }
        }
        "refresh_token" => {
            let presented = get("refresh_token");
            if !book.refresh.contains(&presented) {
                return refused();
            }
            // Rotating: the old refresh token is spent.
            book.refresh.retain(|t| t != &presented);
        }
        _ => return refused(),
    }
    let n = state.serial.fetch_add(1, Ordering::SeqCst) + 1;
    let (access, refresh) = (format!("at-secret-{n}"), format!("rt-secret-{n}"));
    book.access.push(access.clone());
    book.refresh.push(refresh.clone());
    let claims = URL_SAFE_NO_PAD.encode(br#"{"email":"person@example.com"}"#);
    axum::Json(json!({
        "access_token": access,
        "token_type": "Bearer",
        "expires_in": state.expires_in.load(Ordering::SeqCst),
        "refresh_token": refresh,
        "scope": "read write",
        "id_token": format!("e30.{claims}.sig"),
    }))
    .into_response()
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
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
        .with_server_info(Implementation::new("fake-app", "0.0.0"))
    }

    async fn on_initialized(&self, context: NotificationContext<RoleServer>) {
        lock(&self.0.peers).push(context.peer);
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        if self.0.leaky_listing.load(Ordering::SeqCst) {
            let bearer = lock(&self.0.bearers).last().cloned().unwrap_or_default();
            let refresh = lock(&self.0.book)
                .refresh
                .last()
                .cloned()
                .unwrap_or_default();
            return Err(ErrorData::internal_error(
                format!("no tools for {bearer} (renew with {refresh})"),
                None,
            ));
        }
        Ok(ListToolsResult::with_all_items(lock(&self.0.tools).clone()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        self.0.tool_runs.fetch_add(1, Ordering::SeqCst);
        let args = request.arguments.unwrap_or_default();
        let text = match request.name.as_ref() {
            "echo" => args
                .get("say")
                .and_then(Value::as_str)
                .unwrap_or("nothing")
                .to_owned(),
            // A careless server echoing the credentials it knows, in text and structured content.
            "whoami" => {
                let bearer = lock(&self.0.bearers).last().cloned().unwrap_or_default();
                let refresh = lock(&self.0.book)
                    .refresh
                    .last()
                    .cloned()
                    .unwrap_or_default();
                let mut result = CallToolResult::success(vec![ContentBlock::text(format!(
                    "you are {bearer}, renewing with {refresh}"
                ))]);
                result.structured_content =
                    Some(json!({ "token": bearer, bearer.clone(): refresh }));
                return Ok(result.into());
            }
            other => format!("ran {other}"),
        };
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]).into())
    }
}

/// A tool with the given hints.
pub fn tool(name: &str, read_only: Option<bool>, destructive: Option<bool>) -> Tool {
    let Value::Object(schema) =
        json!({ "type": "object", "properties": { "say": { "type": "string" } } })
    else {
        unreachable!()
    };
    let tool = Tool::new(name.to_owned(), format!("{name} in the fake app"), schema);
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
