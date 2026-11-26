// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::json_io::parse_typed;
use crate::state::{ApplyContext, CoreConfig, create_thread_state};

fn new_thread() -> ThreadState {
    create_thread_state(
        "t".to_owned(),
        None,
        CoreConfig {
            provider: "claude".to_owned(),
            silence_ms: 30_000.0,
            liveness: None,
        },
    )
    .unwrap()
}

#[test]
fn agent_status_extras_follow_reused_and_spread_records() {
    let mut state = new_thread();
    let mut events = Vec::new();
    let mut ids = |kind: &str| Some(kind.to_owned());
    let mut ctx = ApplyContext {
        now: 1,
        ids: &mut ids,
        resolving_interactions: None,
    };
    let record = crate::tree::ensure_agent(&mut state, "a", &mut ctx, &mut events).unwrap();
    let failed =
        r#"{"state":"failed","error":{"kind":"unknown","message":"failed"},"future":[1,null]}"#;
    let status: AgentStatus = parse_typed(failed).unwrap();
    assert_eq!(status.state(), "failed");
    assert_eq!(ace_json::ser::to_string(&status).unwrap(), failed);
    record.process_settled_status = Some(status);
    recompute_statuses(&mut state, 1, &mut events);
    assert_eq!(
        ace_json::ser::to_string(&state.agents["a"].agent.status).unwrap(),
        failed
    );

    state.agents.get_mut("a").unwrap().retry =
        Some(parse_typed(r#"{"on":"network","attempt":2,"retryFuture":true}"#).unwrap());
    recompute_statuses(&mut state, 2, &mut events);
    assert_eq!(
        ace_json::ser::to_string(&state.agents["a"].agent.status).unwrap(),
        r#"{"state":"blocked","refs":[],"on":"network","attempt":2,"retryFuture":true}"#
    );

    state.agents.get_mut("a").unwrap().limited =
        Some(parse_typed(r#"{"until":42,"limitFuture":"backoff"}"#).unwrap());
    recompute_statuses(&mut state, 3, &mut events);
    assert_eq!(
        ace_json::ser::to_string(&state.agents["a"].agent.status).unwrap(),
        r#"{"state":"blocked","on":"rate_limit","refs":[],"until":42,"limitFuture":"backoff"}"#
    );
}

#[test]
fn thread_status_extras_round_trip_until_the_status_is_replaced() {
    let mut state = new_thread();
    let stored = r#"{"state":"working","agents":2,"future":{"nested":null}}"#;
    state.status = parse_typed(stored).unwrap();
    assert_eq!(state.status.state(), "working");
    assert_eq!(ace_json::ser::to_string(&state.status).unwrap(), stored);

    state.queue_count = 1;
    recompute_statuses(&mut state, 1, &mut Vec::new());
    assert_eq!(
        ace_json::ser::to_string(&state.status).unwrap(),
        r#"{"state":"waiting","on":"queue"}"#
    );
}
