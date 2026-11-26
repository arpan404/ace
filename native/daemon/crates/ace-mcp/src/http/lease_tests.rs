// SPDX-License-Identifier: Apache-2.0
//! The lease's own state: two leases sharing a session id never share cancellation, request
//! ids or opened families (`http.ts:388`, `toolsets.ts:181`).

use super::tests::{Fixture, as_lease, code_of, result_of};
use super::*;
use crate::credentials::McpScope;
use crate::registry::{FnTool, ToolEntry, descriptor};
use ace_json::parse;

/// A tool that waits for the gate before answering with its input.
fn waiting_tool(
    gate: &Arc<tokio::sync::Notify>,
    started: &Arc<tokio::sync::Notify>,
) -> Arc<dyn crate::registry::ToolHandler> {
    let gate = Arc::clone(gate);
    let started = Arc::clone(started);
    Arc::new(FnTool(move |input: Value, _context| {
        let gate = Arc::clone(&gate);
        let started = Arc::clone(&started);
        async move {
            started.notify_one();
            gate.notified().await;
            Ok(input)
        }
    }))
}

#[tokio::test]
async fn two_leases_sharing_a_session_name_keep_cancellation_and_discovery_apart() {
    let fixture = Fixture::new(&[], 16, 4096);
    fixture.register_echo();
    let gate = Arc::new(tokio::sync::Notify::new());
    let started = Arc::new(tokio::sync::Notify::new());
    let mut wait = descriptor(
        "ace_wait",
        None,
        "Wait",
        "read-only",
        None,
        30_000,
        parse("{\"type\":\"object\"}").expect("schema"),
        None,
    );
    wait.toolset = Some("ace-agents".to_owned());
    fixture
        .registry()
        .register(ToolEntry::new(wait, waiting_tool(&gate, &started)))
        .expect("registration");
    // Two leases carry one session id: they are still different callers.
    let twin = fixture
        .credentials
        .issue(
            McpScope::new("session", "thread", "twin", &[]),
            &Abort::new(),
        )
        .expect("lease");
    let server = Arc::clone(&fixture.server);
    let first = {
        let request = fixture.request(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ace_wait","arguments":{}}}"#,
        );
        tokio::spawn(async move { server.handle(request, Arc::new(|_| {})).await })
    };
    started.notified().await;
    // The twin's cancellation names the same request id, and must not reach the first lease.
    let cancelled = fixture
        .server
        .handle(
            as_lease(
                fixture.request(
                    r#"{"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":9}}"#,
                ),
                &twin,
            ),
            Arc::new(|_| {}),
        )
        .await;
    assert_eq!(cancelled.status, 202);
    let mut first = first;
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut first)
            .await
            .is_err(),
        "the twin's cancellation aborted the first lease's call"
    );
    // The twin may use the same request id: request ids are per lease.
    let twin_call = fixture
        .server
        .handle(
            as_lease(
                fixture.request(
                    r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"ace_echo","arguments":{"value":"twin"}}}"#,
                ),
                &twin,
            ),
            Arc::new(|_| {}),
        )
        .await;
    assert_eq!(
        result_of(&twin_call)
            .get("structuredContent")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str),
        Some("twin"),
        "the twin's own request id was refused as a duplicate"
    );
    gate.notify_waiters();
    assert_eq!(code_of(&first.await.expect("call")), "");
}

#[tokio::test]
async fn another_lease_never_inherits_an_open_family_and_an_ended_lease_forgets_its_own() {
    let fixture = Fixture::new(&[], 16, 4096);
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
    let core = |body: &str| {
        let mut request = fixture.request(body);
        request
            .headers
            .push(("x-ace-tools".to_owned(), "core".to_owned()));
        request
    };
    let lists_thread_start = |response: &HttpResponse| {
        result_of(response)
            .get("tools")
            .and_then(Value::as_array)
            .is_some_and(|tools| {
                tools
                    .iter()
                    .any(|tool| tool.get("name").and_then(Value::as_str) == Some("thread_start"))
            })
    };
    let opened = fixture
        .server
        .handle(
            core(r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"guide","arguments":{"topic":"ace-threads"}}}"#),
            Arc::new(|_| {}),
        )
        .await;
    assert_eq!(opened.status, 200);
    let mine = fixture
        .server
        .handle(
            core(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#),
            Arc::new(|_| {}),
        )
        .await;
    assert!(lists_thread_start(&mine), "the guide opened no family");
    let twin = fixture
        .credentials
        .issue(
            McpScope::new("session", "thread", "twin", &[]),
            &Abort::new(),
        )
        .expect("lease");
    let theirs = fixture
        .server
        .handle(
            as_lease(
                core(r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#),
                &twin,
            ),
            Arc::new(|_| {}),
        )
        .await;
    assert!(
        !lists_thread_start(&theirs),
        "a second lease inherited another lease's open family"
    );
    // The lease ends; a replacement carrying the same session id starts empty.
    fixture.lease.end();
    let replacement = fixture
        .credentials
        .issue(
            McpScope::new("session", "thread", "replacement", &[]),
            &Abort::new(),
        )
        .expect("lease");
    let inherited = fixture
        .server
        .handle(
            as_lease(
                core(r#"{"jsonrpc":"2.0","id":4,"method":"tools/list"}"#),
                &replacement,
            ),
            Arc::new(|_| {}),
        )
        .await;
    assert!(
        !lists_thread_start(&inherited),
        "a replacement lease inherited an ended lease's open family"
    );
}

#[test]
fn a_request_never_prints_its_bearer() {
    let request = HttpRequest {
        method: "POST".to_owned(),
        path: "/mcp".to_owned(),
        headers: vec![
            ("host".to_owned(), "127.0.0.1:1".to_owned()),
            (
                "authorization".to_owned(),
                "Bearer a-secret-bearer".to_owned(),
            ),
        ],
        body: b"{\"jsonrpc\":\"2.0\"}".to_vec(),
    };
    let printed = format!("{request:?}");
    assert!(
        !printed.contains("a-secret-bearer"),
        "the bearer reached a log: {printed}"
    );
    assert!(printed.contains("authorization"));
}
