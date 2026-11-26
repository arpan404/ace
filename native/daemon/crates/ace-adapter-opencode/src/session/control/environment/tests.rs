// SPDX-License-Identifier: Apache-2.0
//! The gate's cases (`agent-env.ts`, `session.ts:278`-`:308`): the environment one
//! session's shells run with, the two requests that set and settle it, the
//! refusal a failed set leaves, and the retry the gate's RPC gets.

use super::readiness::Step;
use super::{GATE_MS, MESSAGE_MAX_UTF16, apply, refusal, session_shell_environment, settle_step};
use ace_json::{Map, Value, json};

fn map(value: Value) -> Map {
    match value {
        Value::Object(map) => map,
        _ => panic!("an object"),
    }
}

#[test]
fn the_servers_credentials_never_reach_a_sessions_shell() {
    let inherited = map(json!({
        "PATH": "/usr/bin",
        "HOME": "/home/a",
        "OPENCODE_PASSWORD": "server",
        "OPENCODE_SERVER_PASSWORD": "server",
        "ACE_MCP_BEARER_TOKEN": "token",
        "ACE_MCP_TOKEN": "token",
        "ACE_DAEMON_TOKEN": "token",
        "ACE_DAEMON_TOKEN_FILE": "/run/token",
        "ACE_MARKET_SIGNER_TOKEN": "token",
        "ACE_GRANT_KEY": "key",
        "ACE_GRANT_PREVIOUS_KEY": "key",
        "ACE_ACCOUNT_ENCRYPTION_KEY": "key",
    }));
    let environment = session_shell_environment(&inherited, &Map::new());
    assert_eq!(
        environment,
        json!({ "PATH": "/usr/bin", "HOME": "/home/a" })
    );
}

#[test]
fn the_threads_variables_win_over_an_inherited_name() {
    let inherited = map(json!({ "ACE_THREAD_ID": "stale", "PATH": "/usr/bin" }));
    let agent_env = map(json!({ "ACE_THREAD_ID": "thread-a", "ACE_NO_INPUT": "1" }));
    assert_eq!(
        session_shell_environment(&inherited, &agent_env),
        json!({ "PATH": "/usr/bin", "ACE_THREAD_ID": "thread-a", "ACE_NO_INPUT": "1" })
    );
}

#[test]
fn setting_a_sessions_environment_settles_the_gate_after_it() {
    let environment = json!({ "ACE_THREAD_ID": "thread-a" });
    let requests = apply(Some(&environment), "ses_1", "/w").expect("the table's fields");
    assert_eq!(requests.len(), 2, "the PUT, then its settle");
    let (first, second) = (&requests[0], &requests[1]);
    assert_eq!(first.directory, "/w");
    assert_eq!(
        first.call.target(),
        "/api/session/ses_1/environment",
        "the id is in the path"
    );
    assert_eq!(
        first.call.body,
        Some(json!({ "variables": { "ACE_THREAD_ID": "thread-a" } }))
    );
    assert_eq!(
        second.call.target(),
        "/api/rpc/ace.agent.environment/settle?location%5Bdirectory%5D=%2Fw"
    );
    assert_eq!(
        second.call.body,
        Some(json!({ "input": { "sessionID": "ses_1", "ok": true } }))
    );
}

#[test]
fn a_session_without_an_environment_sends_nothing() {
    assert!(apply(None, "ses_1", "/w").expect("no request").is_empty());
    assert!(
        apply(Some(&json!(null)), "ses_1", "/w")
            .expect("no request")
            .is_empty()
    );
}

#[test]
fn a_failed_set_refuses_the_gates_tools_with_the_reason() {
    let request = refusal("ses_1", "/w", "set failed").expect("a request");
    assert_eq!(
        request.call.body,
        Some(json!({ "input": { "sessionID": "ses_1", "ok": false, "message": "set failed" } }))
    );
    // The contract bounds the message at 1,024 UTF-16 units.
    let long = "😀".repeat(MESSAGE_MAX_UTF16);
    let request = refusal("ses_1", "/w", &long).expect("a request");
    let fields = ace_json::to_string(&request.call.body.expect("a body"));
    let body = ace_json::parse(&fields).expect("JSON");
    let message = crate::translate::data::s_in(
        crate::translate::data::fields(
            crate::translate::data::fields(&body)
                .get("input")
                .expect("input"),
        ),
        "message",
    );
    assert_eq!(message.encode_utf16().count(), MESSAGE_MAX_UTF16);
}

#[test]
fn the_gates_rpc_is_retried_while_its_plugin_is_unregistered() {
    // The gate shares the readiness RPC's policy, with its own budget.
    let unregistered = json!({ "type": "rpc.unavailable" });
    assert_eq!(settle_step(&unregistered, 0.0), Step::Retry { in_ms: 100 });
    assert_eq!(settle_step(&unregistered, GATE_MS), Step::Unconfirmed);
    assert_eq!(
        settle_step(&json!({ "type": "rpc.internal" }), 0.0),
        Step::Fail
    );
}
