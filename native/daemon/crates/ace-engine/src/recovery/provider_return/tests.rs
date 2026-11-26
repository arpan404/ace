// SPDX-License-Identifier: Apache-2.0
//! The cross-provider plan: a returning provider resumes its own session with only the delta; a
//! new provider gets the full excerpt; a different backend is never resumed.

use super::*;

fn handoff(excerpts: i64, omitted: i64) -> Value {
    let items: Vec<String> = (0..excerpts)
        .map(|at| format!(r#"{{"citation":{{"itemId":"i-{at}"}},"text":"line {at}"}}"#))
        .collect();
    let excerpts = if items.is_empty() {
        "[]".to_owned()
    } else {
        format!("[{}]", items.join(","))
    };
    ace_json::parse(&format!(
        r#"{{"sourceThreadId":"t","throughSeq":9,"history":{{"threadId":"t","before":null,"limit":20,"tool":"read"}},"excerpts":{excerpts},"omittedItems":{omitted}}}"#
    ))
    .unwrap()
}

fn left(backend: &str, through: i64) -> LeftSession {
    LeftSession {
        provider: "claude".to_owned(),
        instance_id: None,
        backend: backend.to_owned(),
        through_seq: through,
        native_session_id: "native-1".to_owned(),
    }
}

#[test]
fn a_provider_the_thread_has_not_run_on_gets_the_full_excerpt() {
    let full = handoff(2, 0);
    let plan = plan_cross_provider(&full, None, Some("cursor-sdk"), None);
    assert!(plan.resume.is_none());
    assert_eq!(plan.handoff, Some(full));
    assert_eq!(plan.fallback, None);
}

#[test]
fn a_remembered_session_on_another_backend_is_never_resumed() {
    let full = handoff(2, 0);
    let plan = plan_cross_provider(&full, Some(left("acp", 4)), Some("cursor-sdk"), None);
    assert!(plan.resume.is_none());
    assert_eq!(plan.handoff, Some(full));
}

#[test]
fn a_returning_provider_resumes_with_only_what_happened_since() {
    let full = handoff(5, 0);
    let delta = handoff(2, 0);
    let plan = plan_cross_provider(&full, Some(left("acp", 4)), Some("acp"), Some(&delta));
    assert_eq!(plan.resume.as_ref().map(|left| left.through_seq), Some(4));
    assert_eq!(plan.handoff, Some(delta));
    assert_eq!(plan.fallback, Some(full));
}

#[test]
fn nothing_happened_while_away_so_no_handoff_goes_in_front() {
    let full = handoff(5, 0);
    let delta = handoff(0, 0);
    let plan = plan_cross_provider(&full, Some(left("acp", 4)), Some("acp"), Some(&delta));
    assert!(plan.resume.is_some());
    assert_eq!(plan.handoff, None);
    assert_eq!(plan.fallback, Some(full.clone()));
    // Items left out of the delta also count as something that happened.
    let omitted = handoff(0, 3);
    let plan = plan_cross_provider(&full, Some(left("acp", 4)), Some("acp"), Some(&omitted));
    assert_eq!(plan.handoff, Some(omitted));
}

#[test]
fn only_a_missing_resumed_session_with_a_fallback_abandons_the_return() {
    assert!(should_abandon_return(true, true));
    assert!(!should_abandon_return(false, true));
    assert!(!should_abandon_return(true, false));
}
