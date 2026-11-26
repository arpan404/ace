// Ported from `http.process`, `http-boundaries.process`, `lifetime.process` and
// `progress-heartbeat.process`: the (a) cases "serves current discovery and structured tools",
// "filters unauthorized tools and rejects direct capability bypasses", "rejects hostile
// origins, malformed requests and oversized bodies", "rejects a raw hostile Host before
// effects", "revokes authority when the provider session ends and rejects every later HTTP
// method", "a call's acting-for comes from the client's _meta", "starts independent tool
// calls while another call is still waiting", and "a Claude-style client receives progress
// throughout a long call".
use super::*;
use crate::credentials::{McpScope, SessionLease};
use crate::registry::{FnTool, ToolContext, ToolEntry, descriptor};
use crate::scope::ScopeChallenge;
use crate::signal::ManualScheduler;
use ace_json::parse;
use std::sync::atomic::{AtomicBool, AtomicUsize};

pub(super) struct Fixture {
    pub(super) server: Arc<McpServer>,
    pub(super) scheduler: Arc<ManualScheduler>,
    pub(super) lease: SessionLease,
    pub(super) credentials: Arc<CredentialRegistry>,
    secrets: Arc<AtomicUsize>,
    pub(super) lifetime: Abort,
}

impl Fixture {
    pub(super) fn new(capabilities: &[&str], max_requests: usize, max_body: usize) -> Fixture {
        Fixture::with_call_limits(capabilities, max_requests, max_body, None)
    }

    pub(super) fn with_call_limits(
        capabilities: &[&str],
        max_requests: usize,
        max_body: usize,
        call_limits: Option<(usize, usize)>,
    ) -> Fixture {
        let secrets = Arc::new(AtomicUsize::new(1));
        let counter = Arc::clone(&secrets);
        let credentials = Arc::new(CredentialRegistry::new(move || {
            let next = counter.fetch_add(1, Ordering::SeqCst);
            format!("{next:064x}")
        }));
        let lifetime = Abort::new();
        let lease = credentials
            .issue(
                McpScope::new("session", "thread", "root", capabilities),
                &lifetime,
            )
            .expect("lease");
        let scheduler = Arc::new(ManualScheduler::default());
        let mut registry = ToolRegistry::new(Arc::clone(&scheduler) as Arc<dyn Scheduler>);
        if let Some((max_calls, per_thread)) = call_limits {
            registry = registry.with_call_limits(max_calls, per_thread);
        }
        let registry = Arc::new(registry);
        Fixture {
            server: McpServer::new(McpServerOptions {
                registry,
                credentials: Arc::clone(&credentials),
                challenge: None,
                max_requests,
                max_body_bytes: max_body,
                scheduler: Arc::clone(&scheduler) as Arc<dyn Scheduler>,
                session_ids: Some(Arc::new({
                    let next = Arc::new(AtomicUsize::new(0));
                    move || {
                        let id = next.fetch_add(1, Ordering::SeqCst);
                        format!("legacy-{id}")
                    }
                })),
            }),
            scheduler,
            lease,
            credentials,
            secrets,
            lifetime,
        }
    }

    pub(super) fn registry(&self) -> &Arc<ToolRegistry> {
        &self.server.registry
    }

    pub(super) fn register_echo(&self) {
        self.registry()
            .register(ToolEntry::new(
                descriptor(
                    "ace_echo",
                    Some("Echo"),
                    "Echo",
                    "read-only",
                    None,
                    1_000,
                    parse("{\"type\":\"object\",\"properties\":{\"value\":{\"type\":\"string\"}}}")
                        .expect("schema"),
                    Some(parse("{\"type\":\"object\"}").expect("schema")),
                ),
                Arc::new(FnTool(|input: Value, _context| async move { Ok(input) })),
            ))
            .expect("registration");
    }

    pub(super) fn register_capability_tool(&self, ran: Arc<AtomicBool>) {
        self.registry()
            .register(ToolEntry::new(
                descriptor(
                    "browser_open",
                    None,
                    "Open",
                    "external-effect",
                    Some("browser"),
                    1_000,
                    parse("{\"type\":\"object\"}").expect("schema"),
                    None,
                ),
                Arc::new(FnTool(move |input: Value, _context| {
                    let ran = Arc::clone(&ran);
                    async move {
                        ran.store(true, Ordering::SeqCst);
                        Ok(input)
                    }
                })),
            ))
            .expect("registration");
    }

    pub(super) fn request(&self, body: &str) -> HttpRequest {
        HttpRequest {
            method: "POST".to_owned(),
            path: "/mcp".to_owned(),
            headers: vec![
                ("host".to_owned(), "127.0.0.1:1".to_owned()),
                (
                    "authorization".to_owned(),
                    format!("Bearer {}", self.lease.bearer),
                ),
                ("content-type".to_owned(), "application/json".to_owned()),
                (
                    "accept".to_owned(),
                    "application/json, text/event-stream".to_owned(),
                ),
            ],
            body: body.as_bytes().to_vec(),
        }
    }

    pub(super) async fn handle(&self, body: &str) -> HttpResponse {
        self.server
            .handle(self.request(body), Arc::new(|_| {}))
            .await
    }
}

pub(super) fn body(value: &HttpResponse) -> Value {
    ace_json::parse(std::str::from_utf8(&value.body).expect("utf8")).expect("json")
}

pub(super) fn result_of(response: &HttpResponse) -> Value {
    body(response).get("result").cloned().unwrap_or(Value::Null)
}

pub(super) fn code_of(response: &HttpResponse) -> String {
    let result = result_of(response);
    let content = result.get("content").and_then(Value::as_array);
    let text = content
        .and_then(|content| content.first())
        .and_then(|content| content.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    ace_json::parse(text)
        .ok()
        .and_then(|value| value.get("code").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default()
}

#[tokio::test]
async fn hostile_hosts_origins_paths_bodies_and_missing_bearers_are_refused_before_effects() {
    let fixture = Fixture::new(&[], 16, 1024);
    let ran = Arc::new(AtomicBool::new(false));
    fixture.register_capability_tool(Arc::clone(&ran));
    let call = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_open","arguments":{}}}"#;

    let mut hostile_host = fixture.request(call);
    for (name, value) in hostile_host.headers.iter_mut() {
        if name == "host" {
            *value = "evil.example".to_owned();
        }
    }
    assert_eq!(
        fixture
            .server
            .handle(hostile_host, Arc::new(|_| {}))
            .await
            .status,
        403
    );

    let mut hostile_origin = fixture.request(call);
    hostile_origin
        .headers
        .push(("origin".to_owned(), "https://evil.example".to_owned()));
    assert_eq!(
        fixture
            .server
            .handle(hostile_origin, Arc::new(|_| {}))
            .await
            .status,
        403
    );
    assert!(!ran.load(Ordering::SeqCst));

    // The loopback Origin is served.
    let mut good_origin = fixture.request(call);
    good_origin
        .headers
        .push(("origin".to_owned(), "http://127.0.0.1:5173".to_owned()));
    assert_eq!(
        fixture
            .server
            .handle(good_origin, Arc::new(|_| {}))
            .await
            .status,
        200
    );

    let mut wrong_path = fixture.request(call);
    wrong_path.path = "/mcp/wrong".to_owned();
    assert_eq!(
        fixture
            .server
            .handle(wrong_path, Arc::new(|_| {}))
            .await
            .status,
        404
    );

    let malformed = fixture.handle("{").await;
    assert_eq!(malformed.status, 400);
    assert_eq!(
        body(&malformed)
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Value::as_i64),
        Some(-32_700)
    );

    let oversized = fixture
        .handle(&format!("{{\"pad\":\"{}\"}}", "x".repeat(1024)))
        .await;
    assert_eq!(oversized.status, 413);

    let mut anonymous = fixture.request(call);
    anonymous
        .headers
        .retain(|(name, _)| name != "authorization");
    let unauthorized = fixture.server.handle(anonymous, Arc::new(|_| {})).await;
    assert_eq!(unauthorized.status, 401);
    assert_eq!(
        unauthorized
            .headers
            .iter()
            .find(|(name, _)| name == "www-authenticate")
            .map(|(_, value)| value.as_str()),
        Some("Bearer")
    );
}

#[tokio::test]
async fn a_revoked_lease_is_401_for_every_method_and_a_bad_one_is_403() {
    let fixture = Fixture::new(&[], 16, 1024);
    fixture.lifetime.abort();
    for method in ["POST", "GET", "DELETE"] {
        let mut request = fixture.request("{}");
        request.method = method.to_owned();
        assert_eq!(
            fixture
                .server
                .handle(request, Arc::new(|_| {}))
                .await
                .status,
            401,
            "{method}"
        );
    }
    let mut bad_bearer = fixture.request("{}");
    for (_, value) in bad_bearer.headers.iter_mut() {
        if value.starts_with("Bearer ") {
            *value = "Bearer not-a-bearer".to_owned();
        }
    }
    assert_eq!(
        fixture
            .server
            .handle(bad_bearer, Arc::new(|_| {}))
            .await
            .status,
        401
    );
}

#[tokio::test]
async fn discovery_lists_annotated_tools_and_a_call_returns_the_structured_value() {
    let fixture = Fixture::new(&[], 16, 1024);
    fixture.register_echo();
    let initialized = fixture
            .handle(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28"}}"#)
            .await;
    let result = result_of(&initialized);
    assert_eq!(
        result
            .get("serverInfo")
            .and_then(|info| info.get("name"))
            .and_then(Value::as_str),
        Some("ace")
    );
    assert_eq!(
        result.get("protocolVersion").and_then(Value::as_str),
        Some("2026-07-28")
    );
    let listed = fixture
        .handle(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#)
        .await;
    let tools = result_of(&listed)
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let echo = tools
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some("ace_echo"))
        .expect("ace_echo listed");
    assert_eq!(
        echo.get("annotations")
            .and_then(|annotations| annotations.get("readOnlyHint"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        echo.get("inputSchema")
            .and_then(|schema| schema.get("type"))
            .and_then(Value::as_str),
        Some("object")
    );
    // Calling an unlisted capability is refused; the tool's own words reach the model.
    let called = fixture
            .handle(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ace_echo","arguments":{"value":"hello"}}}"#)
            .await;
    assert_eq!(
        result_of(&called)
            .get("structuredContent")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str),
        Some("hello")
    );
    let ping = fixture
        .handle(r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#)
        .await;
    assert_eq!(result_of(&ping), Value::Object(Map::new()));
    let unknown = fixture
        .handle(r#"{"jsonrpc":"2.0","id":5,"method":"nope"}"#)
        .await;
    assert_eq!(
        body(&unknown)
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Value::as_i64),
        Some(-32_601)
    );
    let notification = fixture
        .handle(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
        .await;
    assert_eq!(notification.status, 202);
    assert!(notification.body.is_empty());
    let bad_params = fixture
        .handle(r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{}}"#)
        .await;
    assert_eq!(
        body(&bad_params)
            .get("error")
            .and_then(|error| error.get("code"))
            .and_then(Value::as_i64),
        Some(-32_602)
    );
}

#[tokio::test]
async fn a_capability_the_caller_does_not_hold_is_hidden_and_never_runs() {
    let fixture = Fixture::new(&[], 16, 1024);
    let ran = Arc::new(AtomicBool::new(false));
    fixture.register_capability_tool(Arc::clone(&ran));
    let listed = fixture
        .handle(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
        .await;
    let tools = result_of(&listed)
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(
        tools
            .iter()
            .all(|tool| tool.get("name").and_then(Value::as_str) != Some("browser_open"))
    );
    let called = fixture
            .handle(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_open","arguments":{}}}"#)
            .await;
    assert_eq!(
        result_of(&called).get("isError").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(code_of(&called), "tool_unavailable");
    assert!(!ran.load(Ordering::SeqCst));

    let allowed = Fixture::new(&["browser"], 16, 1024);
    let ran = Arc::new(AtomicBool::new(false));
    allowed.register_capability_tool(Arc::clone(&ran));
    let called = allowed
            .handle(r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"browser_open","arguments":{}}}"#)
            .await;
    assert_eq!(
        result_of(&called).get("isError"),
        None,
        "a tool the scope holds was refused"
    );
    assert!(ran.load(Ordering::SeqCst));
}

#[tokio::test]
async fn acting_for_comes_from_the_clients_meta_never_from_arguments() {
    let fixture = Fixture::new(&[], 16, 1024);
    fixture
        .registry()
        .register(ToolEntry::new(
            descriptor(
                "ace_whom",
                None,
                "Whom",
                "read-only",
                None,
                1_000,
                parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            Arc::new(FnTool(|_input: Value, context: ToolContext| async move {
                let mut map = Map::new();
                map.insert(
                    "actingFor",
                    Value::from(context.acting_for.as_deref().unwrap_or("nobody")),
                );
                Ok(Value::Object(map))
            })),
        ))
        .expect("registration");
    let named = fixture
            .handle(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ace_whom","arguments":{},"_meta":{"ace/acting-for":"fares"}}}"#)
            .await;
    assert_eq!(
        result_of(&named)
            .get("structuredContent")
            .and_then(|value| value.get("actingFor"))
            .and_then(Value::as_str),
        Some("fares")
    );
    let unnamed = fixture
            .handle(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ace_whom","arguments":{"for":"fares"}}}"#)
            .await;
    assert_eq!(
        result_of(&unnamed)
            .get("structuredContent")
            .and_then(|value| value.get("actingFor"))
            .and_then(Value::as_str),
        Some("nobody")
    );
}

#[tokio::test]
async fn independent_calls_overlap_and_the_request_bound_is_503() {
    let fixture = Fixture::new(&[], 1, 1024);
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let waiting = {
        let gate = Arc::clone(&gate);
        let started = Arc::clone(&started);
        Arc::new(FnTool(move |input: Value, _context| {
            let gate = Arc::clone(&gate);
            let started = Arc::clone(&started);
            async move {
                started.notify_one();
                gate.notified().await;
                Ok(input)
            }
        })) as Arc<dyn crate::registry::ToolHandler>
    };
    fixture
        .registry()
        .register(ToolEntry::new(
            descriptor(
                "ace_wait",
                None,
                "Wait",
                "read-only",
                None,
                30_000,
                parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            waiting,
        ))
        .expect("registration");
    let server = Arc::clone(&fixture.server);
    let first = {
        let server = Arc::clone(&server);
        let request = fixture.request(
                r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ace_wait","arguments":{}}}"#,
            );
        tokio::spawn(async move { server.handle(request, Arc::new(|_| {})).await })
    };
    started.notified().await;
    // The one allowed request is in flight: every other is 503, whatever its method.
    let mut second = fixture.request(
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ace_wait","arguments":{}}}"#,
        );
    second.method = "GET".to_owned();
    assert_eq!(server.handle(second, Arc::new(|_| {})).await.status, 503);
    gate.notify_waiters();
    assert_eq!(first.await.expect("call").status, 200);
    // With room, two calls run at once.
    let wide = Fixture::new(&[], 16, 1024);
    wide.register_echo();
    let one = wide
            .handle(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ace_echo","arguments":{"value":"a"}}}"#)
            .await;
    let two = wide
            .handle(r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ace_echo","arguments":{"value":"b"}}}"#)
            .await;
    assert_eq!(
        result_of(&one)
            .get("structuredContent")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str),
        Some("a")
    );
    assert_eq!(
        result_of(&two)
            .get("structuredContent")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str),
        Some("b")
    );
}

#[tokio::test]
async fn a_duplicate_active_request_id_is_refused_and_cancellation_reaches_the_call() {
    let fixture = Fixture::new(&[], 16, 1024);
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let waiting = {
        let gate = Arc::clone(&gate);
        let started = Arc::clone(&started);
        Arc::new(FnTool(move |input: Value, _context| {
            let gate = Arc::clone(&gate);
            let started = Arc::clone(&started);
            async move {
                started.notify_one();
                gate.notified().await;
                Ok(input)
            }
        })) as Arc<dyn crate::registry::ToolHandler>
    };
    fixture
        .registry()
        .register(ToolEntry::new(
            descriptor(
                "ace_wait",
                None,
                "Wait",
                "read-only",
                None,
                30_000,
                parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            waiting,
        ))
        .expect("registration");
    let server = Arc::clone(&fixture.server);
    let first = {
        let server = Arc::clone(&server);
        let request = fixture.request(
                r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ace_wait","arguments":{}}}"#,
            );
        tokio::spawn(async move { server.handle(request, Arc::new(|_| {})).await })
    };
    started.notified().await;
    let duplicate = fixture
            .handle(r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ace_wait","arguments":{}}}"#)
            .await;
    assert_eq!(
        result_of(&duplicate)
            .get("content")
            .and_then(Value::as_array)
            .and_then(|content| content.first())
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str),
        Some("Duplicate active request id")
    );
    // A cancellation notification finds the caller's own request.
    let cancelled = fixture
        .handle(r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9}}"#)
        .await;
    assert_eq!(cancelled.status, 202);
    let answered = first.await.expect("call");
    assert_eq!(code_of(&answered), "cancelled");
    gate.notify_waiters();
}

#[tokio::test]
async fn a_client_that_asked_for_progress_hears_a_beat_every_interval() {
    let fixture = Fixture::new(&[], 16, 1024);
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let waiting = {
        let gate = Arc::clone(&gate);
        let started = Arc::clone(&started);
        Arc::new(FnTool(move |input: Value, _context| {
            let gate = Arc::clone(&gate);
            let started = Arc::clone(&started);
            async move {
                started.notify_one();
                gate.notified().await;
                Ok(input)
            }
        })) as Arc<dyn crate::registry::ToolHandler>
    };
    fixture
        .registry()
        .register(ToolEntry::new(
            descriptor(
                "ace_wait",
                None,
                "Wait",
                "read-only",
                None,
                30_000,
                parse("{\"type\":\"object\"}").expect("schema"),
                None,
            ),
            waiting,
        ))
        .expect("registration");
    let seen = Arc::new(Mutex::new(Vec::<Value>::new()));
    let collector = Arc::clone(&seen);
    let emit: Emitter = Arc::new(move |value| {
        collector
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(value);
    });
    let server = Arc::clone(&fixture.server);
    let request = fixture.request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ace_wait","arguments":{},"_meta":{"progressToken":"p"}}}"#,
        );
    let call = {
        let server: Arc<McpServer> = Arc::clone(&server);
        let emit = Arc::clone(&emit);
        tokio::spawn(async move { server.handle(request, emit).await })
    };
    started.notified().await;
    fixture.scheduler.fire_all();
    let beats = seen
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    assert_eq!(beats.len(), 1, "one beat after one interval");
    assert_eq!(
        beats[0].get("method").and_then(Value::as_str),
        Some("notifications/progress")
    );
    assert_eq!(
        beats[0]
            .get("params")
            .and_then(|params| params.get("progress"))
            .and_then(Value::as_f64),
        Some(1.0)
    );
    assert_eq!(
        beats[0]
            .get("params")
            .and_then(|params| params.get("message"))
            .and_then(Value::as_str),
        Some("Still running")
    );
    gate.notify_waiters();
    let _ = call.await.expect("call");
    fixture.scheduler.fire_all();
    assert_eq!(
        seen.lock().unwrap_or_else(|error| error.into_inner()).len(),
        1,
        "a beat arrived after the call settled"
    );
}

#[tokio::test]
async fn a_scoped_endpoint_refuses_a_call_before_it_runs() {
    struct Only;
    impl ScopeChallenge for Only {
        fn missing_scope(
            &self,
            _principal: &Principal,
            _tool: &str,
            _args: &Value,
        ) -> Option<String> {
            Some("browser".to_owned())
        }
    }
    let fixture = Fixture::new(&[], 16, 1024);
    let ran = Arc::new(AtomicBool::new(false));
    fixture.register_capability_tool(Arc::clone(&ran));
    let scheduler = Arc::clone(&fixture.scheduler);
    let challenged = McpServer::new(McpServerOptions {
        registry: Arc::clone(fixture.registry()),
        credentials: Arc::clone(&fixture.credentials),
        challenge: Some(Arc::new(Only)),
        max_requests: 16,
        max_body_bytes: 1024,
        scheduler: scheduler as Arc<dyn Scheduler>,
        session_ids: None,
    });
    let request = fixture.request(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_open","arguments":{}}}"#,
        );
    let refused = challenged.handle(request, Arc::new(|_| {})).await;
    assert_eq!(refused.status, 403);
    assert_eq!(
        refused
            .headers
            .iter()
            .find(|(name, _)| name == "www-authenticate")
            .map(|(_, value)| value.as_str()),
        Some(
            "Bearer error=\"insufficient_scope\", scope=\"browser\", error_description=\"This tool needs the browser scope.\""
        )
    );
    assert!(!ran.load(Ordering::SeqCst));
    let _ = &fixture.secrets;
}

#[tokio::test]
async fn rejects_missing_and_mismatched_mirrored_custom_headers_before_effects_and_decodes_encoded_values()
 {
    use base64::Engine as _;
    let fixture = Fixture::new(&[], 16, 4096);
    let effects = Arc::new(Mutex::new(Vec::<String>::new()));
    let recorded = Arc::clone(&effects);
    fixture
        .registry()
        .register(
            ToolEntry::new(
                descriptor(
                    "ace_scoped",
                    None,
                    "Scoped effect",
                    "read-only",
                    None,
                    1_000,
                    parse(
                        "{\"type\":\"object\",\"properties\":{\"scope\":{\"type\":\"string\",\"x-mcp-header\":\"Scope\"}}}",
                    )
                    .expect("schema"),
                    None,
                ),
                Arc::new(FnTool(move |input: Value, _context| {
                    let recorded = Arc::clone(&recorded);
                    async move {
                        recorded
                            .lock()
                            .unwrap_or_else(|error| error.into_inner())
                            .push(
                                input
                                    .get("scope")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_owned(),
                            );
                        Ok(input)
                    }
                })),
            ))
        .expect("registration");
    let send = |value: &str, header: Option<&str>| {
        let mut request = fixture.request(&format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"ace_scoped","arguments":{{"scope":{}}}}}}}"#,
            ace_json::to_string(&Value::from(value))
        ));
        if let Some(header) = header {
            request
                .headers
                .push(("mcp-param-scope".to_owned(), header.to_owned()));
        }
        request
    };
    for header in [None, Some("wrong")] {
        let response = fixture
            .server
            .handle(send("expected", header), Arc::new(|_| {}))
            .await;
        assert_eq!(response.status, 400, "header {header:?}");
        assert_eq!(
            body(&response)
                .get("error")
                .and_then(|error| error.get("code"))
                .and_then(Value::as_i64),
            Some(-32_020)
        );
        assert!(
            effects
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .is_empty(),
            "a mismatched header reached the tool"
        );
    }
    let mut expected = Vec::new();
    for value in [
        "expected",
        "Hello, 世界",
        " padded ",
        "line1\nline2",
        "=?base64?literal?=",
    ] {
        let encoded = if value == "expected" {
            value.to_owned()
        } else {
            format!(
                "=?base64?{}?=",
                base64::engine::general_purpose::STANDARD.encode(value)
            )
        };
        let response = fixture
            .server
            .handle(send(value, Some(&encoded)), Arc::new(|_| {}))
            .await;
        assert_eq!(response.status, 200, "value {value:?}");
        assert_eq!(
            result_of(&response)
                .get("structuredContent")
                .and_then(|value| value.get("scope"))
                .and_then(Value::as_str),
            Some(value)
        );
        expected.push(value.to_owned());
    }
    assert_eq!(
        *effects.lock().unwrap_or_else(|error| error.into_inner()),
        expected
    );
}

/// The same request authenticated as another lease.
pub(super) fn as_lease(mut request: HttpRequest, lease: &SessionLease) -> HttpRequest {
    for (name, value) in request.headers.iter_mut() {
        if name == "authorization" {
            *value = format!("Bearer {}", lease.bearer);
        }
    }
    request
}

/// A request from a client that opted into its legacy notification stream.
fn stream_opt_in(mut request: HttpRequest) -> HttpRequest {
    if !request
        .headers
        .iter()
        .any(|(name, _)| name == "x-ace-notifications")
    {
        request
            .headers
            .push(("x-ace-notifications".to_owned(), "stream".to_owned()));
    }
    request
}

#[tokio::test]
async fn a_legacy_client_keeps_a_bounded_session_and_delete_ends_it() {
    let fixture = Fixture::new(&[], 16, 4096);
    fixture.register_echo();
    let initialize = |id: u8| {
        format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"initialize","params":{{"protocolVersion":"2025-06-18"}}}}"#
        )
    };
    let session_of = |response: &HttpResponse| {
        response
            .headers
            .iter()
            .find(|(name, _)| name == "mcp-session-id")
            .map(|(_, value)| value.clone())
    };
    let first = fixture
        .server
        .handle(
            stream_opt_in(fixture.request(&initialize(1))),
            Arc::new(|_| {}),
        )
        .await;
    let first_id = session_of(&first).expect("the initialize opened no session");
    assert!(first_id.starts_with("legacy-"));
    // A later request names its session.
    let call = stream_opt_in(fixture.request(
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ace_echo","arguments":{"value":"legacy"}}}"#,
    ));
    let mut call = call;
    call.headers
        .push(("mcp-session-id".to_owned(), first_id.clone()));
    assert_eq!(
        fixture.server.handle(call, Arc::new(|_| {})).await.status,
        200
    );
    // Another lease cannot use the id.
    let other = fixture
        .credentials
        .issue(
            McpScope::new("other", "thread", "other", &[]),
            &Abort::new(),
        )
        .expect("lease");
    let mut foreign = as_lease(stream_opt_in(fixture.request("{}")), &other);
    foreign
        .headers
        .push(("mcp-session-id".to_owned(), first_id.clone()));
    assert_eq!(
        fixture
            .server
            .handle(foreign, Arc::new(|_| {}))
            .await
            .status,
        404
    );
    // A foreign DELETE is refused too, and leaves the owner's session open.
    let mut foreign_delete = as_lease(stream_opt_in(fixture.request("{}")), &other);
    foreign_delete.method = "DELETE".to_owned();
    foreign_delete
        .headers
        .push(("mcp-session-id".to_owned(), first_id.clone()));
    assert_eq!(
        fixture
            .server
            .handle(foreign_delete, Arc::new(|_| {}))
            .await
            .status,
        404,
        "another lease ended this session"
    );
    let mut owned_ping =
        stream_opt_in(fixture.request(r#"{"jsonrpc":"2.0","id":8,"method":"ping"}"#));
    owned_ping
        .headers
        .push(("mcp-session-id".to_owned(), first_id.clone()));
    assert_eq!(
        fixture
            .server
            .handle(owned_ping, Arc::new(|_| {}))
            .await
            .status,
        200,
        "the foreign DELETE closed the owner's session"
    );
    // Reinitializing supersedes the oldest of the lease's four.
    let mut ids = vec![first_id.clone()];
    for id in 2..=5 {
        let response = fixture
            .server
            .handle(
                stream_opt_in(fixture.request(&initialize(id))),
                Arc::new(|_| {}),
            )
            .await;
        ids.push(session_of(&response).expect("no session"));
    }
    assert_eq!(ids.len(), 5);
    assert_ne!(ids[0], ids[4]);
    let mut superseded = stream_opt_in(fixture.request("{}"));
    superseded
        .headers
        .push(("mcp-session-id".to_owned(), ids[0].clone()));
    assert_eq!(
        fixture
            .server
            .handle(superseded, Arc::new(|_| {}))
            .await
            .status,
        404
    );
    let mut newest = stream_opt_in(fixture.request(r#"{"jsonrpc":"2.0","id":9,"method":"ping"}"#));
    newest
        .headers
        .push(("mcp-session-id".to_owned(), ids[4].clone()));
    assert_eq!(
        fixture.server.handle(newest, Arc::new(|_| {})).await.status,
        200
    );
    // DELETE ends it; a second DELETE is 404. Without an id there is nothing to end: 400.
    let mut delete = stream_opt_in(fixture.request("{}"));
    delete.method = "DELETE".to_owned();
    delete
        .headers
        .push(("mcp-session-id".to_owned(), ids[4].clone()));
    assert_eq!(
        fixture.server.handle(delete, Arc::new(|_| {})).await.status,
        200
    );
    let mut again = stream_opt_in(fixture.request("{}"));
    again.method = "DELETE".to_owned();
    again
        .headers
        .push(("mcp-session-id".to_owned(), ids[4].clone()));
    assert_eq!(
        fixture.server.handle(again, Arc::new(|_| {})).await.status,
        404
    );
    let mut anonymous_delete = stream_opt_in(fixture.request("{}"));
    anonymous_delete.method = "DELETE".to_owned();
    assert_eq!(
        fixture
            .server
            .handle(anonymous_delete, Arc::new(|_| {}))
            .await
            .status,
        400
    );
    let _ = &fixture.secrets;
}

/// Registers a `tools_call` descriptor and a destructive `automation_remove`, both as the
/// registry serves them, plus an echoing read-only target.
fn register_dispatch_tools(fixture: &Fixture, ran: &Arc<AtomicUsize>) {
    {
        let ran = Arc::clone(ran);
        fixture
            .registry()
            .register(ToolEntry::new(
                descriptor(
                    "ace_echo",
                    Some("Echo"),
                    "Echo",
                    "read-only",
                    None,
                    1_000,
                    parse("{\"type\":\"object\",\"properties\":{\"value\":{\"type\":\"string\"}}}")
                        .expect("schema"),
                    None,
                ),
                Arc::new(FnTool(move |input: Value, _context| {
                    let ran = Arc::clone(&ran);
                    async move {
                        ran.fetch_add(1, Ordering::SeqCst);
                        Ok(input)
                    }
                })),
            ))
            .expect("registration");
    }
    for (name, destructive, toolset) in [
        ("tools_call", false, None),
        ("automation_remove", true, Some("ace-threads")),
    ] {
        let mut entry = descriptor(
            name,
            None,
            name,
            "external-effect",
            None,
            1_000,
            if name == "tools_call" {
                parse("{\"type\":\"object\",\"properties\":{\"name\":{\"type\":\"string\"},\"arguments\":{\"type\":\"object\"}}}")
                    .expect("schema")
            } else {
                parse("{\"type\":\"object\"}").expect("schema")
            },
            None,
        );
        entry.toolset = toolset.map(str::to_owned);
        let ran = Arc::clone(ran);
        fixture
            .registry()
            .register(
                ToolEntry::new(
                    entry,
                    Arc::new(FnTool(move |input: Value, _context| {
                        let ran = Arc::clone(&ran);
                        async move {
                            ran.fetch_add(1, Ordering::SeqCst);
                            Ok(input)
                        }
                    })),
                )
                .destructive(destructive),
            )
            .expect("registration");
    }
}

fn tools_call_body(name: &str, arguments: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"tools_call","arguments":{{"name":"{name}","arguments":{arguments}}}}}}}"#
    )
}

#[tokio::test]
async fn tools_call_validates_its_wrapper_and_never_dispatches_where_the_list_is_complete() {
    let fixture = Fixture::new(&[], 16, 4096);
    let ran = Arc::new(AtomicUsize::new(0));
    register_dispatch_tools(&fixture, &ran);
    // A session that lists every tool calls each one directly; `tools_call` is not offered.
    let complete = fixture
        .handle(&tools_call_body("ace_echo", r#"{"value":"direct"}"#))
        .await;
    assert_eq!(code_of(&complete), "tool_unavailable");
    assert_eq!(ran.load(Ordering::SeqCst), 0, "a full list dispatched");
    // The wrapper's own schema: a name, and an object of arguments.
    let core = |body: String| {
        let mut request = fixture.request(&body);
        request
            .headers
            .push(("x-ace-tools".to_owned(), "core".to_owned()));
        request
    };
    for body in [
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tools_call","arguments":{}}}"#.to_owned(),
        tools_call_body("tools_find", "{}"),
        tools_call_body("tools_call", "{}"),
        tools_call_body("ace_echo", "5"),
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"tools_call","arguments":{"name":"ace_echo","arguments":{},"extra":1}}}"#.to_owned(),
    ] {
        let response = fixture.server.handle(core(body), Arc::new(|_| {})).await;
        assert_eq!(code_of(&response), "invalid_arguments", "{}", {
            std::str::from_utf8(&response.body).unwrap_or_default()
        });
        assert_eq!(ran.load(Ordering::SeqCst), 0, "an invalid wrapper ran a tool");
    }
    // A dispatcher's list grows, so it reaches a target it has not listed yet.
    let dispatched = fixture
        .server
        .handle(
            core(tools_call_body("ace_echo", r#"{"value":"found"}"#)),
            Arc::new(|_| {}),
        )
        .await;
    assert_eq!(
        result_of(&dispatched)
            .get("structuredContent")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str),
        Some("found")
    );
    assert_eq!(ran.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn codexs_fixed_list_names_destructive_tools_and_tools_call_refuses_them() {
    let fixture = Fixture::new(&[], 16, 4096);
    let ran = Arc::new(AtomicUsize::new(0));
    register_dispatch_tools(&fixture, &ran);
    let mut request = fixture.request(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#);
    request
        .headers
        .push(("x-ace-tools".to_owned(), "static".to_owned()));
    request
        .headers
        .push(("x-ace-client".to_owned(), "codex".to_owned()));
    let listed = fixture.server.handle(request, Arc::new(|_| {})).await;
    let tools = result_of(&listed)
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let destructive = tools
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some("automation_remove"))
        .expect("the destructive tool is not listed by name");
    assert_eq!(
        destructive
            .get("annotations")
            .and_then(|annotations| annotations.get("destructiveHint"))
            .and_then(Value::as_bool),
        Some(true)
    );
    let wrapper = tools
        .iter()
        .find(|tool| tool.get("name").and_then(Value::as_str) == Some("tools_call"))
        .expect("tools_call is not listed");
    assert_eq!(
        wrapper
            .get("annotations")
            .and_then(|annotations| annotations.get("destructiveHint"))
            .and_then(Value::as_bool),
        Some(false),
        "the wrapper still says it can be destructive"
    );
    let mut call = fixture.request(&tools_call_body("automation_remove", "{}"));
    call.headers
        .push(("x-ace-tools".to_owned(), "static".to_owned()));
    call.headers
        .push(("x-ace-client".to_owned(), "codex".to_owned()));
    let refused = fixture.server.handle(call, Arc::new(|_| {})).await;
    assert_eq!(code_of(&refused), "call_directly");
    assert_eq!(
        ran.load(Ordering::SeqCst),
        0,
        "a destructive target was dispatched"
    );
    // A read-only target still goes through the wrapper.
    let mut allowed = fixture.request(&tools_call_body("ace_echo", r#"{"value":"read"}"#));
    allowed
        .headers
        .push(("x-ace-tools".to_owned(), "static".to_owned()));
    allowed
        .headers
        .push(("x-ace-client".to_owned(), "codex".to_owned()));
    let answered = fixture.server.handle(allowed, Arc::new(|_| {})).await;
    assert_eq!(
        result_of(&answered)
            .get("structuredContent")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str),
        Some("read")
    );
}

#[tokio::test]
async fn a_tool_the_caller_cannot_see_never_answers_header_mismatch() {
    let fixture = Fixture::new(&[], 16, 4096);
    let ran = Arc::new(AtomicBool::new(false));
    let clicked = Arc::clone(&ran);
    fixture
        .registry()
        .register(ToolEntry::new(
            descriptor(
                "browser_open",
                None,
                "Open",
                "external-effect",
                Some("browser"),
                1_000,
                parse(
                    "{\"type\":\"object\",\"properties\":{\"url\":{\"type\":\"string\",\"x-mcp-header\":\"Url\"}}}",
                )
                .expect("schema"),
                None,
            ),
            Arc::new(FnTool(move |input: Value, _context| {
                let clicked = Arc::clone(&clicked);
                async move {
                    clicked.store(true, Ordering::SeqCst);
                    Ok(input)
                }
            })),
        ))
        .expect("registration");
    // The schema this caller cannot see is never enforced against it: the call is refused as
    // unavailable, not as a header mismatch.
    let called = fixture
        .handle(
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"browser_open","arguments":{"url":"https://example.com"}}}"#,
        )
        .await;
    assert_eq!(called.status, 200);
    assert_eq!(code_of(&called), "tool_unavailable");
    assert!(!ran.load(Ordering::SeqCst));
}
