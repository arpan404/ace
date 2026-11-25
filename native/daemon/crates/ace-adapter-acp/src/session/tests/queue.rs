// SPDX-License-Identifier: Apache-2.0
//! The prompts a session queues, and the turn that takes them (`session.ts:664`-`:797`).

use ace_adapter_api::session::Delivery;
use ace_json::{JsString, Value, json};

use super::{
    core_with_prompt, fence, prompt_reply, send, sent_id, sent_json_messages, session_core,
    settlements, steer_reply,
};
use crate::session::core::{AcpCore, AcpCoreConfig, AcpEffect};
use crate::session::input::InputSend;
use crate::session::input::STEER_TARGET_LOST;
use crate::session::mcp::McpConfig;
use crate::session::quirks::AcpSessionQuirks;

fn text(value: &str) -> Value {
    json!({ "type": "text", "text": value })
}

#[test]
fn a_prompt_required_steer_goes_in_as_the_next_prompt() {
    let (mut core, prompt) = core_with_prompt("t-required");
    // Unfenced: the send is not bound to the turn, so it is queued and sent next.
    let effects = send(&mut core, 10, Delivery::Steer, None);
    let id = sent_id(&effects, "_session/steering").unwrap_or_default();
    assert!(settlements(&effects, 10).is_empty());
    let queued = core.stdout_bytes(&steer_reply(&id, "promptRequired"));
    assert!(settlements(&queued, 10).is_empty(), "still queued");
    assert_eq!(core.queue_len(), 1);

    let ended = core.stdout_bytes(&prompt_reply(&prompt, "end_turn"));
    let sent = sent_json_messages(&ended);
    assert_eq!(
        sent[0].get("method").and_then(Value::as_str),
        Some("session/prompt")
    );
    assert!(
        !settlements(&ended, 1).is_empty(),
        "the first prompt settled"
    );
    assert!(
        settlements(&ended, 10).is_empty(),
        "the queued one is in flight"
    );
}

#[test]
fn a_queued_fenced_prompt_is_refused_unread_once_the_session_is_idle() {
    let (mut core, prompt) = core_with_prompt("t-fenced-queue");
    // This agent has no steering extension, so the steer is queued with its fence.
    core.steer_via_cancel = true;
    let fence = fence(true);
    let effects = send(&mut core, 12, Delivery::Steer, Some(&fence));
    assert!(sent_json_messages(&effects).is_empty());
    assert_eq!(core.queue_len(), 1);

    // Its turn ends before the queue could take it: refused unread, never written.
    let ended = core.stdout_bytes(&prompt_reply(&prompt, "end_turn"));
    assert_eq!(
        settlements(&ended, 12),
        vec![Err((
            "ACE_STEER_TARGET_LOST".to_owned(),
            STEER_TARGET_LOST.to_owned()
        ))]
    );
    assert!(sent_json_messages(&ended).is_empty());
}

#[test]
fn steer_via_cancel_queues_a_steer_instead_of_steering() {
    let (mut core, _prompt) = core_with_prompt("t-cancel-steer");
    core.steer_via_cancel = true;
    let effects = send(&mut core, 14, Delivery::Steer, None);
    assert!(sent_id(&effects, "_session/steering").is_none());
    assert_eq!(core.queue_len(), 1);
    assert_eq!(
        sent_json_messages(&effects).len(),
        0,
        "the running turn owns the pipe"
    );
}

#[test]
fn guidance_rides_the_first_prompt_of_the_connection_only() {
    let mut config = AcpCoreConfig::new("t-guidance", "/work", AcpSessionQuirks::generic());
    config.mcp = Some(McpConfig {
        instructions: Some("use ace tools".to_owned()),
        ..McpConfig::default()
    });
    let (mut core, _) = AcpCore::new(config);
    core.native_session_id = JsString::from("sess-1");
    let effects = send(&mut core, 16, Delivery::Queue, None);
    let sent = sent_json_messages(&effects);
    let prompt = sent[0]
        .pointer("/params/prompt")
        .and_then(Value::as_array)
        .map(|parts| parts.to_vec())
        .unwrap_or_default();
    assert_eq!(
        prompt[0].get("text").and_then(Value::as_str),
        Some("<ace-tool-guidance>\nuse ace tools\n</ace-tool-guidance>")
    );
    let id = sent_id(&effects, "session/prompt").unwrap_or_default();
    let ended = core.stdout_bytes(&prompt_reply(&id, "end_turn"));
    assert!(
        !settlements(&ended, 16).is_empty(),
        "the first prompt settles"
    );
    assert!(core.guided, "the guidance is spent");

    let next = send(&mut core, 17, Delivery::Queue, None);
    let prompt = sent_json_messages(&next)[0]
        .pointer("/params/prompt")
        .and_then(Value::as_array)
        .map(|parts| parts.to_vec())
        .unwrap_or_default();
    assert_eq!(prompt.len(), 1, "no second copy of ace's guidance");
    assert_eq!(prompt[0].get("type").and_then(Value::as_str), Some("text"));
}

#[test]
fn the_command_identity_is_published_before_the_prompt_it_belongs_to() {
    let mut core = session_core("t-identity");
    let input = vec![text("run it")];
    let mut effects = Vec::new();
    core.send(
        InputSend {
            operation: 15,
            input: &input,
            delivery: Delivery::Queue,
            command_id: Some("command-1"),
            origin: None,
            fence: None,
        },
        &mut effects,
    );
    let identity = effects.iter().position(
        |effect| matches!(effect, AcpEffect::Callback { name, .. } if *name == "onInputMessage"),
    );
    let write = effects
        .iter()
        .position(|effect| matches!(effect, AcpEffect::Write { .. }));
    assert!(
        identity.is_some() && identity < write,
        "identity before echo (behaviour.md 8)"
    );
}

#[test]
fn a_prompt_reply_without_a_stop_reason_fails_the_session_and_its_send() {
    let (mut core, prompt) = core_with_prompt("t-unconfirmed");
    let reply = json!({ "jsonrpc": "2.0", "id": prompt, "result": {} });
    let effects = core.stdout_bytes(format!("{}\n", reply.to_json()).as_bytes());
    assert!(core.closed);
    assert!(effects.iter().any(|effect| matches!(
        effect,
        AcpEffect::Fatal { message } if message == "ACP prompt completion is unconfirmed"
    )));
    assert_eq!(settlements(&effects, 1).len(), 1, "the send settles once");
}

#[test]
fn a_timeout_disabled_prompt_stays_unanswered_until_its_reply() {
    let (mut core, prompt) = core_with_prompt("t-no-timeout");
    let armed = core.peer.timer(&format!("request:{prompt}"));
    assert!(armed.is_empty(), "a prompt has no deadline");
    let ended = core.stdout_bytes(&prompt_reply(&prompt, "end_turn"));
    assert_eq!(settlements(&ended, 1).len(), 1);
    assert!(settlements(&ended, 1)[0].is_ok());
}

#[test]
fn a_closed_session_and_a_blocked_shell_refuse_a_send_before_queueing() {
    let mut closed = session_core("t-closed");
    closed.close(ace_adapter_api::session::CloseReason::User, &mut Vec::new());
    let effects = send(&mut closed, 18, Delivery::Queue, None);
    assert_eq!(
        settlements(&effects, 18),
        vec![Err((
            "ACE_INPUT_REJECTED".to_owned(),
            "ACP session closed".to_owned()
        ))]
    );
    assert_eq!(closed.queue_len(), 0);

    let mut blocked = session_core("t-blocked");
    blocked.shells.set_root(JsString::from("sess-1"));
    blocked.shells.prompt_started();
    blocked.shells.receive(&json!({
        "sessionId": "sess-1",
        "update": { "sessionUpdate": "tool_call", "toolCallId": "sh-1", "kind": "execute", "status": "in_progress" }
    }));
    blocked
        .shells
        .prompt_ended(&JsString::from("sess-1"), "cancelled");
    assert!(blocked.shells.blocked());
    let effects = send(&mut blocked, 19, Delivery::Queue, None);
    assert_eq!(
        settlements(&effects, 19),
        vec![Err((
            "ACE_INPUT_REJECTED".to_owned(),
            "ACP shell execution completion is unconfirmed".to_owned()
        ))]
    );
}
