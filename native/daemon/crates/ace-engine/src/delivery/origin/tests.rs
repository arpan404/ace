// SPDX-License-Identifier: Apache-2.0
//! `turn-origin.test.ts`'s cases, moved: whose run a delegation call comes from.

use super::*;
use ace_core::state::{AgentRecord, CoreConfig, create_thread_state};
use ace_json::Value;

fn value(text: &str) -> Value {
    ace_json::parse(text).expect("json")
}

/// A thread with a root and a child, the runs they are in, and the thread's last run number.
fn state(root_run: Option<&str>, child_run: Option<&str>, latest: i64) -> ThreadState {
    let mut state = create_thread_state(
        "thread-1".to_owned(),
        None,
        CoreConfig {
            provider: "codex".to_owned(),
            silence_ms: 1_000.0,
            liveness: None,
        },
    )
    .expect("state");
    state.root_key = Some("root".to_owned());
    let record = |id: &str, parent: &str, active: Option<&str>, last: Option<&str>| {
        let mut extra = String::new();
        if let Some(active) = active {
            extra.push_str(&format!(r#","activeRun":"{active}""#));
        }
        if let Some(last) = last {
            extra.push_str(&format!(r#","lastRun":"{last}""#));
        }
        let record: AgentRecord = ace_json::from_value(&value(&format!(
            r#"{{"agent":{{"id":"{id}","threadId":"thread-1","parentId":{parent},"origin":"root","native":{{"provider":"codex"}},"status":{{"state":"idle"}},"fidelity":"full","cwd":"/test","background":false,"createdAt":1}},"activity":"idle","lastSignalAt":1{extra}}}"#
        )))
        .expect("record");
        record
    };
    state.agents.insert(
        "root".to_owned(),
        record("agent-root", "null", root_run, None),
    );
    state.agents.insert(
        "child".to_owned(),
        record("agent-child", r#""agent-root""#, child_run, None),
    );
    state
        .indexes
        .agent_keys_by_id
        .insert("agent-root".to_owned(), "root".to_owned());
    state
        .indexes
        .agent_keys_by_id
        .insert("agent-child".to_owned(), "child".to_owned());
    for (seq, id) in ["run-root", "run-child", "run-last"].iter().enumerate() {
        let run: ace_core::runs::Run = ace_json::from_value(&value(&format!(
            r#"{{"id":"{id}","seq":{},"threadId":"thread-1","agentId":"agent-root","trigger":"user","state":"completed","startedAt":1}}"#,
            seq + 1
        )))
        .expect("run");
        state.runs.insert((*id).to_owned(), run);
    }
    state.run_seq = Some(latest);
    state
}

#[test]
fn the_roots_running_run_is_the_root_and_the_childs_own_is_never_it() {
    let state = state(Some("run-root"), Some("run-child"), 7);
    let root = turn_origin(Some(&state), "agent-root");
    assert_eq!(
        root.root.as_ref().map(|run| run.id.as_str()),
        Some("run-root")
    );
    assert_eq!(
        root.root_turn, root.root,
        "with no last run the turn is the running one"
    );
    assert_eq!(root.origin, root.root, "the root is its own origin");
    assert_eq!(root.latest, 7);
    let child = turn_origin(Some(&state), "agent-child");
    assert_eq!(
        child.origin.as_ref().map(|run| run.id.as_str()),
        Some("run-child"),
        "a subagent's origin is its own run, never the root's"
    );
    assert_eq!(
        active_run(Some(&state), "agent-child").as_deref(),
        Some("run-child")
    );
    assert_eq!(
        active_run(Some(&state), "agent-root").as_deref(),
        Some("run-root")
    );
}

#[test]
fn an_ended_turn_has_no_origin_and_an_unknown_agent_reads_none() {
    let state = state(None, None, 3);
    let ended = turn_origin(Some(&state), "agent-root");
    assert_eq!(ended.root, None);
    assert_eq!(ended.origin, None);
    assert_eq!(active_run(Some(&state), "agent-root"), None);
    let unknown = turn_origin(Some(&state), "nobody");
    assert_eq!(unknown.origin, None);
    // No state at all: nothing to compare against.
    assert_eq!(turn_origin(None, "agent-root"), TurnOrigin::default());
    assert_eq!(active_run(None, "agent-root"), None);
    assert!(delegations_in_flight(None).is_empty());
}

#[test]
fn a_request_id_is_bounded_in_code_points_as_the_zod_schema_counts() {
    // `DelegateTask.requestId` is `z.string().min(1).max(256)`, and zod counts code points: 256
    // emoji pass, 257 do not.
    let request = |count: usize| {
        let mut state = state(None, None, 1);
        state.indexes.live_tools.insert("call".to_owned(), true);
        state.items.insert(
            "call".to_owned(),
            ace_json::from_value(&value(&format!(
                r#"{{"id":"call","threadId":"thread-1","agentId":"agent-root","createdAt":1,"complete":false,"type":"tool_call","call":{{"id":"call","agentId":"agent-root","kind":"mcp","title":"Delegate","status":"running","detail":{{"kind":"mcp","server":"ace","tool":"delegate","arguments":{{"tasks":[{{"requestId":"{}"}}]}}}},"startedAt":1}}}}"#,
                "🌱".repeat(count)
            )))            .expect("item"),
        );
        delegations_in_flight(Some(&state))
    };
    assert_eq!(request(256), vec!["🌱".repeat(256)]);
    assert!(request(257).is_empty());
}

#[test]
fn a_live_delegate_call_names_its_in_flight_requests_and_other_tools_do_not() {
    let mut state = state(None, None, 1);
    state.indexes.live_tools.insert("call".to_owned(), true);
    state.items.insert(
        "call".to_owned(),
        ace_json::from_value(&value(
            r#"{"id":"call","threadId":"thread-1","agentId":"agent-root","createdAt":1,"complete":false,"type":"tool_call","call":{"id":"call","agentId":"agent-root","kind":"mcp","title":"Delegate","status":"running","detail":{"kind":"mcp","server":"ace","tool":"delegate","arguments":{"tasks":[{"requestId":"one"},{"requestId":"two"},{"nope":1}]}},"startedAt":1}}"#,
        ))
        .expect("item"),
    );
    assert_eq!(delegations_in_flight(Some(&state)), vec!["one", "two"]);
    // A different tool, and ace's own shell call, name nothing.
    state.items.insert(
        "call".to_owned(),
        ace_json::from_value(&value(
            r#"{"id":"call","threadId":"thread-1","agentId":"agent-root","createdAt":1,"complete":false,"type":"tool_call","call":{"id":"call","agentId":"agent-root","kind":"shell","title":"Run","status":"running","detail":{"kind":"shell","command":"ls"},"startedAt":1}}"#,
        ))
        .expect("item"),
    );
    assert!(delegations_in_flight(Some(&state)).is_empty());
}
