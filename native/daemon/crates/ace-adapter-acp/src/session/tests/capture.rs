// SPDX-License-Identifier: Apache-2.0
//! What a frame that cannot be captured may still do, and the order frames keep.

use ace_adapter_api::frame::FrameDirection;
use ace_json::{JsString, json};
use ace_supervisor::peer::{Direction, PeerEffect, Timeout};

use super::{ack_writes, settlements};
use crate::session::core::{AcpCore, AcpCoreConfig, AcpEffect, CODE_RPC_ERROR};
use crate::session::frames::MAX_PROVIDER_PAYLOAD_BYTES;
use crate::session::quirks::AcpSessionQuirks;

/// An outbound request whose frame cannot be captured rejects only its own call, as
/// `#send` throws at the observer before the write (`jsonrpc.ts:285`, `:229`), and the
/// session lives on.
#[test]
fn an_uncapturable_outbound_frame_rejects_only_its_call() {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        "t-big-send",
        "/work",
        AcpSessionQuirks::generic(),
    ));
    // Prose is never elided (only attachment bytes are), so capture cannot shrink it.
    let blob = "hello world! ".repeat(MAX_PROVIDER_PAYLOAD_BYTES / 10);
    let Ok(effects) = core.request(
        "custom/huge",
        Some(&json!({ "blob": blob })),
        13,
        Timeout::Disabled,
    ) else {
        panic!("request refused");
    };
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, AcpEffect::Write { .. })),
        "no line reaches stdin after its frame failed to capture"
    );
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, AcpEffect::Fatal { .. })),
        "only the call fails, not the session: {effects:?}"
    );
    let settled = settlements(&effects, 13);
    assert_eq!(settled.len(), 1);
    assert_eq!(
        settled[0],
        Err((
            CODE_RPC_ERROR.to_owned(),
            "Provider payload exceeds byte limit".to_owned()
        ))
    );
    assert!(!core.closed, "the session lives on");
    // The dropped write released its charge: the next request still takes the pipe.
    let Ok(next) = core.request("custom/ping", Some(&json!({})), 14, Timeout::Disabled) else {
        panic!("the peer still accepts work");
    };
    assert!(
        next.iter()
            .any(|effect| matches!(effect, AcpEffect::Write { .. })),
        "the write queue moves on: {next:?}"
    );
}

/// A reply ace sends answers an agent's request and carries no promise: an uncapturable
/// one fails the session (`#answer` then `#report`, `jsonrpc.ts:344`-`:369`), and its id
/// is never taken for a pending call's, since `#send`'s rejection settles requests only.
#[test]
fn an_uncapturable_reply_fails_the_session_even_when_its_id_matches_a_pending_call() {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        "t-reply-collision",
        "/work",
        AcpSessionQuirks::generic(),
    ));
    let Ok(sent) = core.request("custom/ping", Some(&json!({})), 41, Timeout::Disabled) else {
        panic!("request refused");
    };
    assert!(
        sent.iter()
            .any(|effect| matches!(effect, AcpEffect::Write { .. })),
        "the pending call holds wire id 1"
    );
    let blob = "hello world! ".repeat(MAX_PROVIDER_PAYLOAD_BYTES / 10);
    let reply = json!({ "jsonrpc": "2.0", "id": 1, "result": { "blob": blob } });
    let mut effects = Vec::new();
    core.apply_peer_effects(
        vec![
            PeerEffect::Frame {
                dir: Direction::Send,
                value: reply,
            },
            PeerEffect::Write {
                wire: b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n".to_vec(),
                ticket: 99,
            },
        ],
        &mut effects,
    );
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, AcpEffect::Fatal { .. })),
        "a reply's capture failure fails the session"
    );
    assert!(core.closed);
    assert_eq!(
        settlements(&effects, 41).len(),
        1,
        "the pending call still settles once"
    );
}

/// A notification has no promise to reject, so its capture failure reaches `onError`
/// and fails the session (`jsonrpc.ts:241`-`:247`).
#[test]
fn an_uncapturable_notification_fails_the_session() {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        "t-big-notify",
        "/work",
        AcpSessionQuirks::generic(),
    ));
    let blob = "hello world! ".repeat(MAX_PROVIDER_PAYLOAD_BYTES / 10);
    let Ok(effects) = core.notify("custom/huge", Some(&json!({ "blob": blob }))) else {
        panic!("notification refused");
    };
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, AcpEffect::Fatal { .. })),
        "a notification's capture failure is fatal"
    );
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, AcpEffect::Write { .. })),
        "no line reaches stdin"
    );
    assert!(core.closed);
}

/// An inbound reply whose capture throws never settles its call successfully:
/// TS stops before dispatch (`jsonrpc.ts:299`), so the call fails with the
/// capture error instead.
#[test]
fn uncapturable_inbound_reply_never_settles_its_call() {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        "t-big-recv",
        "/work",
        AcpSessionQuirks::generic(),
    ));
    let Ok(_sent) = core.request("custom/ping", Some(&json!({})), 34, Timeout::Disabled) else {
        panic!("request refused");
    };
    let padding = "hello world! ".repeat(MAX_PROVIDER_PAYLOAD_BYTES / 10);
    let line = json!({ "jsonrpc": "2.0", "id": 1, "result": { "padding": padding } });
    let effects = core.stdout_bytes(format!("{}\n", line.to_json()).as_bytes());
    let settled = settlements(&effects, 34);
    assert_eq!(settled.len(), 1, "the call settles once: {settled:?}");
    let Err((code, message)) = &settled[0] else {
        panic!("an uncapturable reply must not settle successfully: {settled:?}");
    };
    assert_eq!(code, "ACE_ACP_RPC_ERROR");
    assert_eq!(message, "Provider payload exceeds byte limit");
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, AcpEffect::Fatal { .. })),
        "the capture failure is fatal"
    );
}

/// A reply whose frame cannot be captured closes the peer, as the TypeScript observer
/// does before it reports (`jsonrpc.ts:300`-`:305`), so the lines still draining after
/// it never reach the state.
#[test]
fn an_uncapturable_reply_closes_the_peer_and_drops_the_lines_after_it() {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        "t-close-recv",
        "/work",
        AcpSessionQuirks::generic(),
    ));
    let Ok(_sent) = core.request("custom/ping", Some(&json!({})), 35, Timeout::Disabled) else {
        panic!("request refused");
    };
    let padding = "hello world! ".repeat(MAX_PROVIDER_PAYLOAD_BYTES / 10);
    let reply = json!({ "jsonrpc": "2.0", "id": 1, "result": { "padding": padding } });
    let late = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "root",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "late-1", "kind": "read", "status": "in_progress" }
        }
    });
    let chunk = format!("{}\n{}\n", reply.to_json(), late.to_json());
    let effects = core.stdout_bytes(chunk.as_bytes());
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, AcpEffect::Fatal { .. })),
        "the capture failure is fatal"
    );
    assert!(
        !effects.iter().any(|effect| matches!(
            effect,
            AcpEffect::Frame {
                dir: FrameDirection::Recv,
                channel,
                text,
            } if channel == "stdio" && text.contains("late-1")
        )),
        "a closed peer drops the lines after the failure"
    );
}

/// The prompt-end cancellation replies are captured after the prompt-end frame
/// that was received: TS settles local state synchronously and sends them once
/// the handler resumes (`jsonrpc.ts:344`), so the translator sees the end first.
#[test]
fn prompt_end_cancellation_replies_are_captured_after_the_prompt_end_frame() {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        "t-order-reply",
        "/work",
        AcpSessionQuirks::generic(),
    ));
    core.native_session_id = JsString::from("root");
    core.routing.bind_root(JsString::from("root"));
    core.shells.set_root(JsString::from("root"));

    // The agent asks for permission: held in `pending` until the prompt ends.
    let ask = json!({
        "jsonrpc": "2.0",
        "id": 7,
        "method": "session/request_permission",
        "params": {
            "sessionId": "root",
            "toolCall": { "toolCallId": "sh-order", "kind": "execute", "title": "Run ls" },
            "options": [{ "optionId": "allow", "name": "Allow", "kind": "allow_once" }]
        }
    });
    let mut asked = core.stdout_bytes(format!("{}\n", ask.to_json()).as_bytes());
    ack_writes(&mut core, &mut asked);
    assert_eq!(core.pending.len(), 1);

    let Ok(mut sent) = core.request(
        "session/prompt",
        Some(&json!({ "sessionId": "root", "prompt": [] })),
        5,
        Timeout::Disabled,
    ) else {
        panic!("prompt request refused");
    };
    ack_writes(&mut core, &mut sent);

    let reply = json!({ "jsonrpc": "2.0", "id": 1, "result": { "stopReason": "cancelled" } });
    let effects = core.stdout_bytes(format!("{}\n", reply.to_json()).as_bytes());
    assert!(core.prompt_id.is_none());
    assert!(core.pending.is_empty(), "the end cancels the open request");

    let prompt_end = effects
        .iter()
        .position(|effect| {
            matches!(
                effect,
                AcpEffect::Frame { dir: FrameDirection::Recv, channel, text }
                    if channel == "stdio" && text.contains("stopReason")
            )
        })
        .unwrap_or(usize::MAX);
    let cancellation = effects
        .iter()
        .position(|effect| {
            matches!(
                effect,
                AcpEffect::Frame { dir: FrameDirection::Send, channel, text }
                    if channel == "stdio" && text.contains("cancelled")
            )
        })
        .unwrap_or(usize::MAX);
    assert!(
        prompt_end < cancellation,
        "the prompt-end frame comes before the replies it cancels: {effects:?}"
    );
}
