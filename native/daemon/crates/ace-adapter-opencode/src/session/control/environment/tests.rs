// SPDX-License-Identifier: Apache-2.0
//! The gate's cases (`agent-env.ts`, `session.ts:278`-`:308`): the environment one
//! session's shells run with, the two requests that set and settle it, the
//! refusal a failed set leaves, and the retry the gate's RPC gets.

use super::readiness::Step;
use super::{
    MESSAGE_MAX_UTF16, SETTLE_BUDGET_MS, apply, refusal, session_shell_environment, settle_step,
    truncate_utf16,
};
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
}

#[test]
fn the_reason_is_cut_in_utf16_units_even_inside_a_surrogate_pair() {
    // `String.prototype.slice` cuts between the halves of an emoji; the message the plugin
    // receives carries the lone high surrogate, one unit shorter than a whole-pair cut.
    let reason = format!("{}😀y", "x".repeat(1_023));
    let message = ace_json::to_string(&Value::String(truncate_utf16(&reason, MESSAGE_MAX_UTF16)));
    assert!(message.ends_with("\\ud83d\""), "{message}");
    assert_eq!(message.len(), 1 + 1_023 + 6 + 1, "{message}");
    // An emoji that ends exactly at the bound stays whole.
    let whole = "😀".repeat(MESSAGE_MAX_UTF16 / 2);
    let message = ace_json::to_string(&Value::String(truncate_utf16(&whole, MESSAGE_MAX_UTF16)));
    assert_eq!(message, format!("\"{whole}\""), "whole pairs stay whole");
}

#[test]
fn the_gates_rpc_is_retried_while_its_plugin_is_unregistered() {
    // The settle retries on the client's ten-second budget (`aceToolsReadyBudgetMs`), not the
    // plugin's thirty-second tool gate.
    let unregistered = json!({ "type": "rpc.unavailable" });
    assert_eq!(settle_step(&unregistered, 0.0), Step::Retry { in_ms: 100 });
    assert_eq!(
        settle_step(&unregistered, SETTLE_BUDGET_MS - 500.0),
        Step::Retry { in_ms: 500 }
    );
    assert_eq!(
        settle_step(&unregistered, SETTLE_BUDGET_MS - 499.0),
        Step::Unconfirmed
    );
    assert_eq!(
        settle_step(&json!({ "type": "rpc.internal" }), 0.0),
        Step::Fail
    );
}
