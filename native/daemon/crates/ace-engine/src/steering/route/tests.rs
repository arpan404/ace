// SPDX-License-Identifier: Apache-2.0
//! `steer-yield.test.ts`, moved: the route table for cancel-and-restart sessions and the
//! provider's own steer timings.

use super::*;
use ace_core::state::{AgentRecord, CoreConfig, ThreadState, create_thread_state};
use ace_json::Value;

fn value(text: &str) -> Value {
    ace_json::parse(text).expect("json")
}

/// The ACP capabilities: steer by cancelling the turn and restarting it.
fn acp() -> Value {
    value(r#"{"steer":true,"steeringMode":"interrupt-restart"}"#)
}

/// A provider whose own steer waits for the running tool (Claude, Codex, Pi, OpenCode).
fn after_tool() -> Value {
    value(r#"{"steer":true,"steerTiming":"after_tool"}"#)
}

/// A state whose root is in a run, and with a live shell call the root waits on.
fn state(active_run: Option<&str>, foreground: bool) -> ThreadState {
    let mut state = create_thread_state(
        "thread-1".to_owned(),
        None,
        CoreConfig {
            provider: "antigravity".to_owned(),
            silence_ms: 1_000.0,
            liveness: None,
        },
    )
    .expect("state");
    state.root_key = Some("root".to_owned());
    let record: AgentRecord = ace_json::from_value(
        &value(&format!(
            r#"{{"agent":{{"id":"agent-1","threadId":"thread-1","parentId":null,"origin":"root","native":{{"provider":"antigravity","nativeId":"native-1"}},"status":{{"state":"idle"}},"fidelity":"full","cwd":"/test","background":false,"createdAt":1}},"activity":"thinking","lastSignalAt":1{}}}"#,
            active_run
                .map(|run| format!(r#","activeRun":"{run}""#))
                .unwrap_or_default()
        )),
    )
    .expect("record");
    state.agents.insert("root".to_owned(), record);
    if foreground {
        state.indexes.live_tools.insert("call-1".to_owned(), true);
        state.items.insert(
            "call-1".to_owned(),
            ace_json::from_value(&value(
                r#"{"id":"call-1","threadId":"thread-1","agentId":"agent-1","createdAt":1,"complete":false,"type":"tool_call","call":{"id":"call-1","agentId":"agent-1","kind":"shell","title":"Run","status":"running","detail":{"kind":"shell","command":"ls"},"startedAt":1}}"#,
            ))
            .expect("item"),
        );
    }
    state
}

fn yield_pending(run: &str) -> SteerYield {
    SteerYield {
        run: run.to_owned(),
        state: YieldState::Pending,
        intent_id: Some(7),
    }
}

#[test]
fn a_cancel_and_restart_session_yields_the_persons_steer_mid_turn() {
    let cancel = SessionSteer {
        steer_via_cancel: true,
        background_tools: false,
    };
    assert_eq!(
        steer_route(true, &state(Some("run-1"), false), &acp(), None, cancel),
        Some(SteerRoute::Yield)
    );
    // Idle: the sends lane takes it, so the steering lane stays free to cancel later turns.
    assert_eq!(
        steer_route(true, &state(None, false), &acp(), None, cancel),
        None
    );
    assert_eq!(
        steer_route(
            true,
            &state(None, false),
            &acp(),
            Some(&yield_pending("run-1")),
            cancel
        ),
        None
    );
}

#[test]
fn a_cancel_already_in_flight_or_refused_waits_for_the_turn_end() {
    let cancel = SessionSteer {
        steer_via_cancel: true,
        background_tools: false,
    };
    assert_eq!(
        steer_route(
            true,
            &state(Some("run-1"), false),
            &acp(),
            Some(&yield_pending("run-1")),
            cancel
        ),
        None
    );
    let refused = SteerYield {
        run: "run-1".to_owned(),
        state: YieldState::Refused,
        intent_id: Some(7),
    };
    assert_eq!(
        steer_route(
            true,
            &state(Some("run-1"), false),
            &acp(),
            Some(&refused),
            cancel
        ),
        None
    );
}

#[test]
fn a_follow_up_that_is_not_the_persons_never_interrupts_the_turn() {
    let cancel = SessionSteer {
        steer_via_cancel: true,
        background_tools: false,
    };
    assert_eq!(
        steer_route(false, &state(Some("run-1"), false), &acp(), None, cancel),
        None
    );
    // The provider's steer restarts the turn: an agent's message waits for the turn to end.
    assert_eq!(
        steer_route(
            false,
            &state(Some("run-1"), false),
            &acp(),
            None,
            SessionSteer::default()
        ),
        None
    );
}

#[test]
fn a_provider_whose_steer_waits_for_tools_lets_a_person_steer_through_by_yielding() {
    let idle = state(None, false);
    assert_eq!(
        steer_route(true, &idle, &after_tool(), None, SessionSteer::default()),
        Some(SteerRoute::Native)
    );
    let busy = state(Some("run-1"), true);
    assert_eq!(
        steer_route(true, &busy, &after_tool(), None, SessionSteer::default()),
        Some(SteerRoute::Yield)
    );
    // A session that moves the command to the background hands the steer over instead.
    let backgrounds = SessionSteer {
        steer_via_cancel: false,
        background_tools: true,
    };
    assert_eq!(
        steer_route(true, &busy, &after_tool(), None, backgrounds),
        Some(SteerRoute::Native)
    );
    // Another agent's message waits for the command, and so does a person's after a refusal.
    assert_eq!(
        steer_route(false, &busy, &after_tool(), None, SessionSteer::default()),
        Some(SteerRoute::Native)
    );
    let refused = SteerYield {
        run: "run-1".to_owned(),
        state: YieldState::Refused,
        intent_id: Some(7),
    };
    assert_eq!(
        steer_route(
            true,
            &busy,
            &after_tool(),
            Some(&refused),
            SessionSteer::default()
        ),
        Some(SteerRoute::Native)
    );
}

#[test]
fn a_provider_whose_steer_cuts_into_the_command_takes_only_the_persons_steer() {
    // `steerTiming` absent: the steer cuts into a running command.
    let cuts_in = value(r#"{"steer":true}"#);
    let busy = state(Some("run-1"), true);
    assert_eq!(
        steer_route(true, &busy, &cuts_in, None, SessionSteer::default()),
        Some(SteerRoute::Native)
    );
    assert_eq!(
        steer_route(false, &busy, &cuts_in, None, SessionSteer::default()),
        None
    );
}

#[test]
fn a_yield_that_is_still_winding_down_holds_every_steer() {
    let state = state(Some("run-1"), false);
    assert!(yield_in_flight(&state, Some(&yield_pending("run-1"))));
    assert!(!yield_in_flight(&state, Some(&yield_pending("run-2"))));
    assert!(!yield_in_flight(&state, None));
    assert_eq!(root_run(&state).as_deref(), Some("run-1"));
    let mut ended = state;
    ended.agents.get_mut("root").expect("root").active_run = None;
    assert!(!yield_in_flight(&ended, Some(&yield_pending("run-1"))));
}

#[test]
fn a_send_the_person_made_or_chose_is_theirs_and_a_childs_result_is_not() {
    let header = |trigger: Option<&str>| IntentHeader {
        id: 1,
        command_id: "c".to_owned(),
        thread_id: "thread-1".to_owned(),
        kind: "thread.send".to_owned(),
        status: "queued".to_owned(),
        attempts: 0,
        awaiting: false,
        ack_target: None,
        delivery: "steer".to_owned(),
        acknowledged: false,
        trigger: trigger.map(str::to_owned),
        submitted_generation: None,
        resolution_generation: None,
        resolution_id: None,
    };
    assert!(is_person_steer(&header(None), false));
    assert!(is_person_steer(&header(Some("user")), false));
    assert!(is_person_steer(&header(Some("subagent_result")), true));
    assert!(!is_person_steer(&header(Some("subagent_result")), false));
    assert!(!is_person_steer(&header(Some("parent_agent")), false));
}
