// SPDX-License-Identifier: Apache-2.0
//! Codex's MCP controls (`mcp-controls.ts`): what ace writes, in which order,
//! and what a status read reports after a write.

use ace_json::Value;

use super::*;
use crate::session::state::{Session, SessionConfig};

fn session() -> Session {
    let mut session = Session::new(SessionConfig {
        scope: "scope-1".to_owned(),
        started: 0.0,
        cwd: "/repo".to_owned(),
        bearer: None,
        redact: Box::new(|line: &str| line.to_owned()),
        foreign: Box::new(|_| false),
    });
    session.attached("root-1", false, false);
    session
}

fn json(text: &str) -> Value {
    ace_json::parse(text).expect("fixture parses")
}

fn request(effect: &Effect) -> (u64, String, Value) {
    match effect {
        Effect::Request {
            call,
            method,
            params,
            ..
        } => (*call, method.clone(), params.clone()),
        other => panic!("expected a request, got {other:?}"),
    }
}

fn settled(effect: &Effect) -> &Value {
    match effect {
        Effect::Settle {
            result: Ok(value), ..
        } => value,
        other => panic!("expected a settlement, got {other:?}"),
    }
}

fn failed(effect: &Effect) -> &str {
    match effect {
        Effect::Settle {
            result: Err(failure),
            ..
        } => &failure.message,
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[test]
fn adding_a_command_server_writes_its_config_key_upserts_then_reloads_before_it_settles() {
    let mut session = session();
    let effects = session.mcp_add(
        1,
        "root-1",
        "docs",
        &json(r#"{"transport":"command","command":"docs-mcp","args":["--stdio"]}"#),
    );
    let (call, method, params) = request(&effects[0]);
    assert_eq!(method, "config/value/write");
    assert_eq!(
        params.get("keyPath").and_then(Value::as_str),
        Some("mcp_servers.docs")
    );
    assert_eq!(
        params.get("mergeStrategy").and_then(Value::as_str),
        Some("upsert")
    );
    assert_eq!(
        params.get("value"),
        Some(&json(r#"{"command":"docs-mcp","args":["--stdio"]}"#))
    );
    let effects = session.mcp_settled(call, Ok(&json("{}"))).expect("a write");
    let (reload, method, _) = request(&effects[0]);
    assert_eq!(method, "config/mcpServer/reload");
    let effects = session
        .mcp_settled(reload, Ok(&json("{}")))
        .expect("a reload");
    assert!(settled(&effects[0]).is_null());
}

#[test]
fn an_http_server_writes_only_its_url() {
    let mut session = session();
    let effects = session.mcp_add(
        2,
        "root-1",
        "remote",
        &json(r#"{"transport":"http","url":"https://example.invalid/mcp"}"#),
    );
    let (_, _, params) = request(&effects[0]);
    assert_eq!(
        params.get("value"),
        Some(&json(r#"{"url":"https://example.invalid/mcp"}"#))
    );
}

#[test]
fn a_name_the_dotted_config_path_cannot_carry_is_refused_before_anything_is_written() {
    let mut session = session();
    let effects = session.mcp_add(
        3,
        "root-1",
        "a.b",
        &json(r#"{"transport":"command","command":"x"}"#),
    );
    assert_eq!(effects.len(), 1);
    assert_eq!(
        failed(&effects[0]),
        "Manage this server name in Codex configuration"
    );
}

#[test]
fn a_url_with_credentials_query_or_fragment_is_not_an_endpoint_ace_writes() {
    let mut session = session();
    for url in [
        "https://user:pw@example.invalid/mcp",
        "https://example.invalid/mcp?x=1",
        "https://example.invalid/mcp#frag",
        "ftp://example.invalid/mcp",
    ] {
        let effects = session.mcp_add(
            4,
            "root-1",
            "remote",
            &json(&format!(r#"{{"transport":"http","url":{url:?}}}"#)),
        );
        assert!(
            failed(&effects[0]).starts_with("MCP server URL must be an http"),
            "{url}"
        );
    }
}

#[test]
fn replacing_a_live_server_is_refused() {
    let mut session = session();
    let effects = session.mcp_replace(5);
    assert_eq!(
        failed(&effects[0]),
        "Codex does not support replacing live MCP servers"
    );
}

#[test]
fn disabling_a_server_is_written_then_reported_over_its_runtime_status() {
    let mut session = session();
    let effects = session.mcp_toggle(6, "root-1", "docs", false);
    let (call, _, params) = request(&effects[0]);
    assert_eq!(
        params.get("keyPath").and_then(Value::as_str),
        Some("mcp_servers.docs.enabled")
    );
    assert_eq!(params.get("value"), Some(&Value::Bool(false)));
    let effects = session.mcp_settled(call, Ok(&json("{}"))).expect("a write");
    let (reload, ..) = request(&effects[0]);
    session
        .mcp_settled(reload, Ok(&json("{}")))
        .expect("a reload");
    let effects = session.mcp_status(7, "root-1");
    let (page, method, params) = request(&effects[0]);
    assert_eq!(method, "mcpServerStatus/list");
    assert_eq!(params.get("limit").and_then(Value::as_f64), Some(100.0));
    let effects = session
        .mcp_settled(
            page,
            Ok(&json(
                r#"{"data":[{"name":"docs","runtimeStatus":"connected"},{"name":"other","runtimeStatus":null}],"nextCursor":null}"#,
            )),
        )
        .expect("a status page");
    assert_eq!(
        settled(&effects[0]),
        &json(r#"[{"name":"docs","status":"disabled"},{"name":"other","status":"unknown"}]"#,)
    );
}

#[test]
fn a_status_read_walks_every_page_with_its_cursor() {
    let mut session = session();
    let effects = session.mcp_status(8, "root-1");
    let (page, ..) = request(&effects[0]);
    let effects = session
        .mcp_settled(
            page,
            Ok(&json(r#"{"data":[{"name":"a"}],"nextCursor":"c2"}"#)),
        )
        .expect("a status page");
    let (next, _, params) = request(&effects[0]);
    assert_eq!(params.get("cursor").and_then(Value::as_str), Some("c2"));
    let effects = session
        .mcp_settled(
            next,
            Ok(&json(r#"{"data":[{"name":"b"}],"nextCursor":null}"#)),
        )
        .expect("a status page");
    assert_eq!(
        settled(&effects[0]),
        &json(r#"[{"name":"a","status":"unknown"},{"name":"b","status":"unknown"}]"#)
    );
}

#[test]
fn a_repeated_status_cursor_ends_the_read_instead_of_looping() {
    let mut session = session();
    let effects = session.mcp_status(9, "root-1");
    let (page, ..) = request(&effects[0]);
    let effects = session
        .mcp_settled(page, Ok(&json(r#"{"data":[],"nextCursor":"c2"}"#)))
        .expect("a status page");
    let (next, ..) = request(&effects[0]);
    let effects = session
        .mcp_settled(next, Ok(&json(r#"{"data":[],"nextCursor":"c2"}"#)))
        .expect("a status page");
    assert_eq!(failed(&effects[0]), "Repeated discovery cursor");
}
