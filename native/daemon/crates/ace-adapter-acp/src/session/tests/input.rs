// SPDX-License-Identifier: Apache-2.0
//! Prompts, steering and the admission every send passes through
//! (`session.ts:591`-`:797`).

use ace_adapter_api::session::Delivery;
use ace_json::{Value, json};

use super::{
    core_with_prompt, fence, send, sent_id, sent_json_messages, session_core, settlements,
    steer_reply,
};
use crate::session::input::{InputSend, STEER_TARGET_LOST};

#[test]
fn a_stale_fence_refuses_the_send_before_anything_is_written_or_queued() {
    let mut core = session_core("t-stale");
    let fence = fence(false);
    let effects = send(&mut core, 7, Delivery::Steer, Some(fence));
    assert_eq!(
        settlements(&effects, 7),
        vec![Err((
            "ACE_STEER_TARGET_LOST".to_owned(),
            STEER_TARGET_LOST.to_owned()
        ))]
    );
    assert!(
        sent_json_messages(&effects).is_empty(),
        "nothing is written"
    );
    assert_eq!(core.queue_len(), 0, "nothing is queued");
}

#[test]
fn a_current_fence_with_no_prompt_in_flight_queues_the_prompt_instead_of_steering() {
    let mut core = session_core("t-no-prompt");
    let fence = fence(true);
    let effects = send(&mut core, 8, Delivery::Steer, Some(fence));
    let sent = sent_json_messages(&effects);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].get("method").and_then(Value::as_str),
        Some("session/prompt")
    );
    assert!(
        sent_id(&effects, "_session/steering").is_none(),
        "no turn, no steer"
    );
    assert!(
        settlements(&effects, 8).is_empty(),
        "the prompt is in flight"
    );
}

#[test]
fn a_current_fence_steers_into_the_running_prompt_in_one_step() {
    let (mut core, _prompt) = core_with_prompt("t-steer");
    let fence = fence(true);
    let effects = send(&mut core, 9, Delivery::Steer, Some(fence));
    let sent = sent_json_messages(&effects);
    assert_eq!(
        sent[0].get("method").and_then(Value::as_str),
        Some("_session/steering")
    );
    assert_eq!(
        sent[0]
            .pointer("/params/_meta/steering/idleBehavior")
            .and_then(Value::as_str),
        Some("promptRequired")
    );
    assert_eq!(
        sent[0].pointer("/params/sessionId").and_then(Value::as_str),
        Some("sess-1")
    );
    assert!(
        settlements(&effects, 9).is_empty(),
        "the reply settles the send"
    );

    let id = sent_id(&effects, "_session/steering").unwrap_or_default();
    let settled = core.stdout_bytes(&steer_reply(&id, "injected"));
    assert_eq!(settlements(&settled, 9).len(), 1);
    assert!(settlements(&settled, 9)[0].is_ok());
}

/// A steer whose frame went out and is then lost settles as uncertain, never as a refusal:
/// TS's `batch.written` never covers a steer, so it refuses and the engine sends it again
/// (behaviour.md 20).
#[test]
fn close_settles_a_written_steer_as_uncertain() {
    let (mut core, _prompt) = core_with_prompt("t-written-steer");
    let effects = send(&mut core, 80, Delivery::Steer, None);
    assert_eq!(
        sent_json_messages(&effects)[0]
            .get("method")
            .and_then(Value::as_str),
        Some("_session/steering"),
        "the steer reached the wire"
    );

    let mut closed = Vec::new();
    core.close(ace_adapter_api::session::CloseReason::User, &mut closed);
    assert_eq!(
        settlements(&closed, 80),
        vec![Err((
            "ACE_ACP_RPC_ERROR".to_owned(),
            "ACP session closed".to_owned()
        ))]
    );
}

/// The same when the reply itself fails: the peer's error settles the written steer as
/// uncertain (`input.rs::finish_steer`'s error arm).
#[test]
fn a_written_steer_whose_reply_fails_settles_uncertain() {
    let (mut core, _prompt) = core_with_prompt("t-steer-reply-fail");
    let effects = send(&mut core, 81, Delivery::Steer, None);
    assert!(sent_id(&effects, "_session/steering").is_some());

    // The leader exits: the peer settles every call still waiting on it.
    let exited = core.mark_exited();
    let settled = settlements(&exited, 81);
    assert_eq!(settled.len(), 1);
    assert_eq!(
        settled[0].as_ref().err().map(|(code, _)| code.as_str()),
        Some("ACE_ACP_RPC_ERROR"),
        "written, so uncertain"
    );
}

#[test]
fn a_steer_outcome_the_agent_did_not_take_refuses_the_send() {
    let (mut core, _prompt) = core_with_prompt("t-outcome");
    let effects = send(&mut core, 11, Delivery::Steer, None);
    let id = sent_id(&effects, "_session/steering").unwrap_or_default();
    let settled = core.stdout_bytes(&steer_reply(&id, "failed"));
    assert_eq!(
        settlements(&settled, 11),
        vec![Err((
            "ACE_INPUT_REJECTED".to_owned(),
            "The agent couldn't take the steer (failed)".to_owned()
        ))]
    );
}

/// An input whose mention never resolved is refused as unread input, before anything is
/// queued: TS throws it outside `send`'s own try (`session.ts:602`), which reports an input
/// that never ran as an unexpected failure (behaviour.md 20).
#[test]
fn a_command_that_never_resolved_is_refused_as_input() {
    let mut core = session_core("t-unresolved");
    let input = vec![json!({
        "type": "mention",
        "name": "x",
        "invocation": { "type": "skill" }
    })];
    let mut effects = Vec::new();
    core.send(
        InputSend {
            operation: 20,
            input: &input,
            delivery: Delivery::Queue,
            command_id: None,
            origin: None,
            fence: None,
        },
        &mut effects,
    );
    assert_eq!(
        settlements(&effects, 20),
        vec![Err((
            "ACE_INPUT_REJECTED".to_owned(),
            "Unresolved command mention".to_owned()
        ))]
    );
    assert!(sent_json_messages(&effects).is_empty());
    assert_eq!(core.queue_len(), 0);
}
