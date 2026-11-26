// SPDX-License-Identifier: Apache-2.0
//! The notification streams the server advertises and delivers: `subscriptions/listen`, a
//! legacy session's GET, and the opt-in that creates it (`http.ts:618`,
//! `legacy-sessions.ts:114`).

use super::tests::{Fixture, result_of};
use super::*;
use crate::registry::{FnTool, ToolContext, ToolEntry, descriptor};
use ace_json::parse;

/// A guide and a family tool, so a call can open a toolset and announce its list change.
fn register_family(fixture: &Fixture) {
    for name in ["guide", "thread_start"] {
        let toolset = (name != "guide").then(|| "ace-threads".to_owned());
        let mut entry = descriptor(
            name,
            None,
            name,
            "read-only",
            None,
            1_000,
            if name == "guide" {
                parse("{\"type\":\"object\",\"properties\":{\"topic\":{\"type\":\"string\"}}}")
                    .expect("schema")
            } else {
                parse("{\"type\":\"object\"}").expect("schema")
            },
            None,
        );
        entry.toolset = toolset;
        fixture
            .registry()
            .register(ToolEntry::new(
                entry,
                Arc::new(FnTool(|input: Value, _context| async move { Ok(input) })),
            ))
            .expect("registration");
    }
}

fn initialize_body(version: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":1,"method":"initialize","params":{{"protocolVersion":"{version}"}}}}"#
    )
}

fn list_changed_capability(response: &HttpResponse) -> Option<bool> {
    result_of(response)
        .get("capabilities")
        .and_then(|capabilities| capabilities.get("tools"))
        .and_then(|tools| tools.get("listChanged"))
        .and_then(Value::as_bool)
}

fn session_header(response: &HttpResponse) -> Option<&str> {
    response
        .headers
        .iter()
        .find(|(name, _)| name == "mcp-session-id")
        .map(|(_, value)| value.as_str())
}

#[tokio::test]
async fn list_changes_are_advertised_only_where_the_client_can_receive_them() {
    let fixture = Fixture::new(&[], 16, 4096);
    let modern = fixture.handle(&initialize_body("2026-07-28")).await;
    assert_eq!(
        list_changed_capability(&modern),
        Some(true),
        "a modern client's listen stream is routed"
    );
    // A 2025 client without the opt-in is served statelessly: no session, and no list changes.
    let plain = fixture.handle(&initialize_body("2025-06-18")).await;
    assert_eq!(list_changed_capability(&plain), None);
    assert_eq!(
        session_header(&plain),
        None,
        "an un-opted legacy client got a session"
    );
    // With the opt-in its GET stream can deliver them.
    let mut opted = fixture.request(&initialize_body("2025-06-18"));
    opted
        .headers
        .push(("x-ace-notifications".to_owned(), "stream".to_owned()));
    let opted = fixture.server.handle(opted, Arc::new(|_| {})).await;
    assert_eq!(list_changed_capability(&opted), Some(true));
    let id = session_header(&opted)
        .expect("an opted legacy client got no session")
        .to_owned();
    let mut ping = fixture.request(r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#);
    ping.headers
        .push(("x-ace-notifications".to_owned(), "stream".to_owned()));
    ping.headers.push(("mcp-session-id".to_owned(), id));
    assert_eq!(
        fixture.server.handle(ping, Arc::new(|_| {})).await.status,
        200,
        "the opted legacy session is not usable"
    );
}

#[tokio::test]
async fn a_modern_listen_stream_hears_its_lease_and_ends_when_the_lease_does() {
    let fixture = Fixture::new(&[], 16, 4096);
    register_family(&fixture);
    let mut listen =
        fixture.request(r#"{"jsonrpc":"2.0","id":1,"method":"subscriptions/listen","params":{}}"#);
    listen
        .headers
        .push(("mcp-method".to_owned(), "subscriptions/listen".to_owned()));
    let response = fixture.server.handle(listen, Arc::new(|_| {})).await;
    assert_eq!(response.status, 200);
    assert_eq!(
        response
            .headers
            .iter()
            .find(|(name, _)| name == "content-type")
            .map(|(_, value)| value.as_str()),
        Some("text/event-stream")
    );
    let mut stream = response.stream.expect("listen opened no stream");
    let mut guide = fixture.request(
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"guide","arguments":{"topic":"ace-threads"}}}"#,
    );
    guide
        .headers
        .push(("x-ace-tools".to_owned(), "core".to_owned()));
    assert_eq!(
        fixture.server.handle(guide, Arc::new(|_| {})).await.status,
        200
    );
    let frame = tokio::time::timeout(std::time::Duration::from_secs(1), stream.recv())
        .await
        .expect("no list change reached the stream")
        .expect("the stream ended early");
    assert_eq!(
        frame.get("method").and_then(Value::as_str),
        Some("notifications/tools/list_changed")
    );
    // Ending the lease ends its stream.
    fixture.lease.end();
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(1), stream.recv())
            .await
            .expect("the stream outlived its lease")
            .is_none()
    );
}

#[tokio::test]
async fn a_legacy_get_stream_needs_the_opt_in_and_owns_its_session() {
    let fixture = Fixture::new(&[], 16, 4096);
    register_family(&fixture);
    let opt_in = |mut request: HttpRequest| {
        request
            .headers
            .push(("x-ace-notifications".to_owned(), "stream".to_owned()));
        request
    };
    let initialized = fixture
        .server
        .handle(
            opt_in(fixture.request(&initialize_body("2025-06-18"))),
            Arc::new(|_| {}),
        )
        .await;
    let id = session_header(&initialized).expect("no session").to_owned();
    // The event stream carries a list change.
    let mut get = opt_in(fixture.request("{}"));
    get.method = "GET".to_owned();
    get.headers.push(("mcp-session-id".to_owned(), id.clone()));
    let response = fixture.server.handle(get, Arc::new(|_| {})).await;
    assert_eq!(response.status, 200);
    let mut stream = response.stream.expect("GET opened no stream");
    let mut guide = opt_in(fixture.request(
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"guide","arguments":{"topic":"ace-threads"}}}"#,
    ));
    guide
        .headers
        .push(("x-ace-tools".to_owned(), "core".to_owned()));
    guide
        .headers
        .push(("mcp-session-id".to_owned(), id.clone()));
    assert_eq!(
        fixture.server.handle(guide, Arc::new(|_| {})).await.status,
        200
    );
    let frame = tokio::time::timeout(std::time::Duration::from_secs(1), stream.recv())
        .await
        .expect("no list change reached the legacy stream")
        .expect("the legacy stream ended early");
    assert_eq!(
        frame.get("method").and_then(Value::as_str),
        Some("notifications/tools/list_changed")
    );
    // A disconnected stream owns no usable transport state: its session is gone.
    drop(stream);
    let mut after = opt_in(fixture.request(r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#));
    after
        .headers
        .push(("mcp-session-id".to_owned(), id.clone()));
    assert_eq!(
        fixture.server.handle(after, Arc::new(|_| {})).await.status,
        404,
        "a session outlived its stream"
    );
    // Without the opt-in the id is not a session at all.
    let mut uninvited = fixture.request(r#"{"jsonrpc":"2.0","id":4,"method":"ping"}"#);
    uninvited.headers.push(("mcp-session-id".to_owned(), id));
    assert_eq!(
        fixture
            .server
            .handle(uninvited, Arc::new(|_| {}))
            .await
            .status,
        404
    );
}

#[tokio::test]
async fn dropping_a_request_future_frees_its_admission_its_call_slot_and_its_pending_id() {
    // One request and one call at a time: a leak shows as 503 or `calls_limit`.
    let fixture = Fixture::with_call_limits(&[], 1, 4096, Some((1, 1)));
    fixture.register_echo();
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let aborted = Arc::new(AtomicBool::new(false));
    let wait = {
        let gate = Arc::clone(&gate);
        let started = Arc::clone(&started);
        let aborted = Arc::clone(&aborted);
        Arc::new(FnTool(move |input: Value, context: ToolContext| {
            let gate = Arc::clone(&gate);
            let started = Arc::clone(&started);
            let aborted = Arc::clone(&aborted);
            async move {
                started.notify_one();
                gate.notified().await;
                context.signal.wait().await;
                aborted.store(true, Ordering::SeqCst);
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
            wait,
        ))
        .expect("registration");
    let beats = Arc::new(Mutex::new(Vec::<Value>::new()));
    let collected = Arc::clone(&beats);
    let emit: Emitter = Arc::new(move |value| {
        collected
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .push(value);
    });
    let server = Arc::clone(&fixture.server);
    let request = fixture.request(
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ace_wait","arguments":{},"_meta":{"progressToken":"p"}}}"#,
    );
    let dropped = tokio::spawn(async move { server.handle(request, emit).await });
    started.notified().await;
    fixture.scheduler.fire_all();
    assert_eq!(
        beats
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len(),
        1,
        "the heartbeat never started"
    );
    // Dropping the handler's future is the transport aborting the request.
    dropped.abort();
    let _ = dropped.await;
    gate.notify_waiters();
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        while !aborted.load(Ordering::SeqCst) {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the dropped request never aborted its tool");
    // No beat survives the dropped future.
    fixture.scheduler.fire_all();
    assert_eq!(
        beats
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .len(),
        1,
        "a beat outlived the request that asked for it"
    );
    // Admission is free again; this was 503 while the slot leaked.
    let ping = fixture
        .handle(r#"{"jsonrpc":"2.0","id":2,"method":"ping"}"#)
        .await;
    assert_eq!(
        ping.status, 200,
        "the dropped request kept an admission slot"
    );
    // The call slot and the pending request id are free: the same id may call another tool,
    // and the registry admits it rather than answering `calls_limit`.
    let repeated = fixture
        .handle(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ace_echo","arguments":{"value":"again"}}}"#)
        .await;
    assert_eq!(
        result_of(&repeated)
            .get("structuredContent")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str),
        Some("again"),
        "the dropped request kept its call slot or its request id"
    );
}
