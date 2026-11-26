// SPDX-License-Identifier: Apache-2.0
//! The readiness policy's cases (`mcp-ready.ts`): the retry table, the patience
//! boundary that turns a missing plugin into "unconfirmed", and what a reply must
//! prove.

use super::{BUDGET_MS, ReadyError, Step, ready, step};
use ace_json::json;

const UNREGISTERED: &str = r#"{"type":"rpc.unavailable","message":"RPC is unavailable"}"#;

fn unavailable() -> ace_json::Value {
    ace_json::parse(UNREGISTERED).expect("JSON")
}

#[test]
fn a_failure_that_is_not_a_missing_plugin_is_real() {
    let broken = json!({ "type": "rpc.internal", "message": "boom" });
    assert_eq!(step(&broken, 0.0, BUDGET_MS), Step::Fail);
    assert_eq!(step(&broken, 9_000.0, BUDGET_MS), Step::Fail);
    // A reply that is not an object at all is not the plugin's absence either.
    assert_eq!(step(&json!("rpc.unavailable"), 0.0, BUDGET_MS), Step::Fail);
}

#[test]
fn a_missing_plugin_retries_with_a_doubling_delay_up_to_half_a_second() {
    let error = unavailable();
    for (elapsed, in_ms) in [
        (0.0, 100),
        (399.0, 100),
        (400.0, 200),
        (800.0, 400),
        (1_200.0, 500),
        (2_400.0, 500),
        (9_000.0, 500),
    ] {
        assert_eq!(
            step(&error, elapsed, BUDGET_MS),
            Step::Retry { in_ms },
            "elapsed {elapsed}"
        );
    }
}

#[test]
fn the_budget_turns_a_missing_plugin_into_unconfirmed() {
    let error = unavailable();
    assert_eq!(step(&error, 9_500.0, BUDGET_MS), Step::Retry { in_ms: 500 });
    assert_eq!(step(&error, 9_501.0, BUDGET_MS), Step::Unconfirmed);
    // The second readiness check before a queued input gives up at once.
    assert_eq!(step(&error, 0.0, 0.0), Step::Unconfirmed);
}

#[test]
fn a_reply_proves_the_context_tool_only_with_a_description() {
    assert_eq!(
        ready(&json!({ "tools": [{ "name": "ace_context", "description": "ace's context" }] })),
        Ok(())
    );
    assert_eq!(
        ready(&json!({
            "tools": [
                { "name": "bash", "description": "run a command" },
                { "name": "ace_context", "description": "ace's context" },
            ]
        })),
        Ok(())
    );
    assert_eq!(
        ready(&json!({ "tools": [{ "name": "ace_context", "description": "" }] })),
        Err(ReadyError::MissingTool)
    );
    assert_eq!(
        ready(&json!({ "tools": [{ "name": "bash", "description": "run a command" }] })),
        Err(ReadyError::MissingTool)
    );
    assert_eq!(ready(&json!({ "tools": [] })), Err(ReadyError::MissingTool));
}

#[test]
fn a_reply_of_the_wrong_shape_is_malformed_not_missing() {
    assert_eq!(ready(&json!({})), Err(ReadyError::Malformed));
    assert_eq!(ready(&json!([])), Err(ReadyError::Malformed));
    assert_eq!(
        ready(&json!({ "tools": [{ "name": "ace_context" }] })),
        Err(ReadyError::Malformed)
    );
    assert_eq!(
        ready(&json!({ "tools": [{ "name": 1, "description": "x" }] })),
        Err(ReadyError::Malformed)
    );
    let tools: Vec<ace_json::Value> = (0..=super::MAX_TOOLS)
        .map(|_| json!({ "name": "ace_context", "description": "d" }))
        .collect();
    assert_eq!(
        ready(&json!({ "tools": tools })),
        Err(ReadyError::Malformed),
        "the catalog's bound is 256 tools"
    );
}
