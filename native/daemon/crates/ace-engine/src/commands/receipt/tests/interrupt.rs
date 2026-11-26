// SPDX-License-Identifier: Apache-2.0
//! The Stop's refusals and the agent it names (`handler.ts:417`-`:451`).

use super::*;

#[test]
fn an_unknown_agent_a_stale_run_and_an_unsupported_goal_refuse() {
    let receipt = Receipt::new(LimitOverrides::default());
    assert_eq!(
        receipt.handle(
            r#"{"id":"a","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","agentId":"nobody"}}"#
        ),
        result("a", "agent_not_found")
    );
    assert_eq!(
        receipt.handle(
            r#"{"id":"r","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","runId":"run-1"}}"#
        ),
        result("r", "stale_interrupt")
    );
    assert_eq!(
        receipt.handle(
            r#"{"id":"g","deviceId":"device","payload":{"type":"thread.goal.set","threadId":"t","goal":{"text":"x"}}}"#
        ),
        result("g", "unsupported_goal")
    );
}

#[test]
fn a_stop_that_names_the_root_turns_run_interrupts_it() {
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.state(&header_with_root_run("t", "run-1", "active"));
    // The web's Stop carries `runId` and no `agentId` (`live-actions.ts:100`): the run is looked
    // up under the root's **state** key, whose record id is not the key itself.
    let accepted = receipt.handle(
        r#"{"id":"stop","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","cascade":true,"runId":"run-1"}}"#,
    );
    assert_eq!(
        accepted.get("ok").and_then(Value::as_bool),
        Some(true),
        "{accepted}"
    );
    assert_eq!(
        receipt.text("SELECT reason AS value FROM engine_queue WHERE thread_id='t'"),
        Some("stopped".to_owned())
    );
    // A run the root is not in, or one that already ended, is stale.
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.state(&header_with_root_run("t", "run-2", "active"));
    assert_eq!(
        receipt.handle(
            r#"{"id":"r","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","runId":"run-1"}}"#
        ),
        result("r", "stale_interrupt")
    );
    let receipt = Receipt::new(LimitOverrides::default());
    receipt.state(&header_with_root_run("t", "run-1", "ended"));
    assert_eq!(
        receipt.handle(
            r#"{"id":"r","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","runId":"run-1"}}"#
        ),
        result("r", "stale_interrupt")
    );
}

#[test]
fn a_read_only_child_adapter_refuses_a_stop_of_its_child() {
    let read_only = r#"[{"provider":"codex","adapter":1,"capabilities":{"steer":true,"childControls":"read-only"},"discovery":{},"current":true}]"#;
    let receipt = Receipt::with_registry(LimitOverrides::default(), read_only);
    receipt.state(&header_with_agents(
        "t",
        &[
            StoredAgent {
                key: "root",
                id: "root",
                parent: None,
                run: Some("run-1"),
            },
            StoredAgent {
                key: "child",
                id: "child-agent",
                parent: Some("root"),
                run: None,
            },
        ],
        &[("run-1", "active")],
    ));
    // Cursor's SDK adapter cannot control a child (`adapter-cursor/src/policy.ts:17`): the Stop
    // is refused where its root's own Stop is fine.
    assert_eq!(
        receipt.handle(
            r#"{"id":"child","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","agentId":"child-agent"}}"#
        ),
        result("child", "unsupported_child_control")
    );
    assert_eq!(
        receipt
            .handle(
                r#"{"id":"root","deviceId":"device","payload":{"type":"thread.interrupt","threadId":"t","agentId":"root"}}"#
            )
            .get("ok")
            .and_then(Value::as_bool),
        Some(true)
    );
}
