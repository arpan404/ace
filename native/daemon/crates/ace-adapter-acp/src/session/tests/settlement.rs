// SPDX-License-Identifier: Apache-2.0
//! Settlement: frame order, every termination path, load replay and lenient decoding.

use ace_adapter_api::frame::FrameDirection;
use ace_json::{JsString, Value, json};
use ace_supervisor::peer::Timeout;

use super::{ack_writes, sent_json_messages, settlements};
use crate::session::core::{AcpCore, AcpCoreConfig, AcpEffect, CODE_OPEN_FAILED, CODE_RPC_ERROR};
use crate::session::open::ResumeTarget;
use crate::session::quirks::AcpSessionQuirks;

#[test]
fn settlement_runs_in_frame_order_inside_same_stdout_chunk() {
    let config = AcpCoreConfig::new("thread-order", "/work", AcpSessionQuirks::generic());
    let (mut core, _) = AcpCore::new(config);
    core.native_session_id = JsString::from("root");
    core.routing.bind_root(JsString::from("root"));
    core.shells.set_root(JsString::from("root"));

    // Send a prompt so prompt_id is tracked and shells.prompt_open == true.
    let mut req_effects = match core.request(
        "session/prompt",
        Some(&json!({ "sessionId": "root", "prompt": [] })),
        99,
        Timeout::Disabled,
    ) {
        Ok(e) => e,
        Err(err) => panic!("prompt request failed: {err}"),
    };
    ack_writes(&mut core, &mut req_effects);
    assert_eq!(core.prompt_frames, 1);
    assert!(core.prompt_id.is_some());

    // One stdout chunk holds BOTH the prompt reply AND a following tool_call update.
    // Because settlement runs inside the frame callback of line 1, line 2 sees prompt_open == false
    // and records the post-prompt tool as busy.
    let line1 = json!({ "jsonrpc": "2.0", "id": 1, "result": { "stopReason": "end_turn" } });
    let line2 = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "root",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "post-1", "kind": "read", "status": "in_progress" }
        }
    });
    let chunk = format!("{}\n{}\n", line1.to_json(), line2.to_json());
    let effects = core.stdout_bytes(chunk.as_bytes());
    assert!(core.prompt_id.is_none());
    assert!(
        core.shells.busy(),
        "line 2 in the same chunk must observe settled prompt"
    );
    assert_eq!(settlements(&effects, 99).len(), 1);
}

#[test]
fn session_load_drops_replay_but_tracks_live_updates_in_same_chunk_after_reply() {
    let mut config = AcpCoreConfig::new("thread-load", "/work", AcpSessionQuirks::generic());
    config.resume = Some(ResumeTarget {
        native_session_id: "sess-old".to_owned(),
    });
    let (mut core, _) = AcpCore::new(config);
    let mut e1 = core.start_open(7);
    ack_writes(&mut core, &mut e1);

    // Advertise loadSession only (not sessionCapabilities.resume) -> uses session/load.
    let init_reply = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "protocolVersion": 1,
            "agentCapabilities": { "loadSession": true }
        }
    });
    let mut e2 = core.stdout_bytes(format!("{}\n", init_reply.to_json()).as_bytes());
    ack_writes(&mut core, &mut e2);
    assert!(core.loading);

    // One chunk: replay tool (must be ignored) -> session/load reply -> live tool (must be tracked).
    let replay = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "sess-old",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "replayed-tool", "kind": "execute", "status": "in_progress" }
        }
    });
    let load_reply = json!({ "jsonrpc": "2.0", "id": 2, "result": { "sessionId": "sess-old" } });
    let live = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": "sess-old",
            "update": { "sessionUpdate": "tool_call", "toolCallId": "live-tool", "kind": "execute", "status": "in_progress" }
        }
    });
    let chunk = format!(
        "{}\n{}\n{}\n",
        replay.to_json(),
        load_reply.to_json(),
        live.to_json()
    );
    let e3 = core.stdout_bytes(chunk.as_bytes());
    assert!(!core.loading);
    assert!(!core.shells.knows(
        &JsString::from("sess-old"),
        &JsString::from("replayed-tool")
    ));
    assert!(
        core.shells
            .knows(&JsString::from("sess-old"), &JsString::from("live-tool"))
    );
    assert_eq!(settlements(&e3, 7).len(), 1);
    assert!(settlements(&e3, 7)[0].is_ok());
}

/// What the pending call's promise must settle as, for each path.
enum Expected {
    Ok(&'static str),
    Err(&'static str, &'static str),
}

#[test]
fn every_pending_call_settles_exactly_once_with_the_result_its_trigger_decides() {
    enum Path {
        Reply,
        RpcError,
        PeerTimeout,
        OpenStall,
        Fail,
        StdoutClosed,
        Finish,
    }

    let table: &[(&str, Path, Expected)] = &[
        (
            "normal reply + duplicate late reply",
            Path::Reply,
            Expected::Ok("{\"ok\":true}"),
        ),
        (
            "rpc error + duplicate late reply",
            Path::RpcError,
            Expected::Err(CODE_RPC_ERROR, "{\"code\":-32603,\"message\":\"boom\"}"),
        ),
        (
            "peer timeout + late reply",
            Path::PeerTimeout,
            Expected::Err(CODE_RPC_ERROR, "JSON-RPC request timed out: custom/ping"),
        ),
        (
            "open stall timer + late reply + finish",
            Path::OpenStall,
            Expected::Err(
                CODE_OPEN_FAILED,
                "ACP session opening made no progress within 30 seconds",
            ),
        ),
        (
            "fail_session + second fail + finish",
            Path::Fail,
            Expected::Err(CODE_RPC_ERROR, "transport broke"),
        ),
        (
            "stdout_closed + finish",
            Path::StdoutClosed,
            Expected::Err(
                CODE_RPC_ERROR,
                "ACP transport stdout closed before process termination",
            ),
        ),
        (
            "finish + duplicate reply",
            Path::Finish,
            Expected::Err(CODE_RPC_ERROR, "ACP process exited"),
        ),
    ];

    for (label, path, expected) in table {
        let config = AcpCoreConfig::new("t", "/work", AcpSessionQuirks::generic());
        let (mut core, _) = AcpCore::new(config);
        let mut all_effects = Vec::new();
        let target_id = 55u64;

        match path {
            Path::OpenStall => {
                let mut e = core.start_open(target_id);
                ack_writes(&mut core, &mut e);
                all_effects.extend(e);
                let mut e2 = core.stdout_bytes(
                    b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1}}\n",
                );
                ack_writes(&mut core, &mut e2);
                all_effects.extend(e2);
                let Some(wire_key) = core.deadlines.wire_key("open").map(str::to_owned) else {
                    panic!("{label}: expected open deadline to be armed");
                };
                // Receiving a notification re-arms the open deadline; old key is ignored.
                all_effects.extend(core.stdout_bytes(
                    b"{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{\"sessionId\":\"s\",\"update\":{\"sessionUpdate\":\"unknown_kind\"}}}\n",
                ));
                all_effects.extend(core.timer(&wire_key));
                assert!(
                    settlements(&all_effects, target_id).is_empty(),
                    "{label}: stale open timer must not fire"
                );
                let Some(fresh_key) = core.deadlines.wire_key("open").map(str::to_owned) else {
                    panic!("{label}: expected refreshed open deadline");
                };
                all_effects.extend(core.timer(&fresh_key));
                // Late reply and finish must not settle a second time.
                all_effects.extend(core.stdout_bytes(
                    b"{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"sessionId\":\"s\"}}\n",
                ));
                all_effects.extend(core.finish(json!({ "code": 0 }), "0"));
            }
            _ => {
                let mut e = match core.request(
                    "custom/ping",
                    Some(&json!({})),
                    target_id,
                    Timeout::After(5_000.0),
                ) {
                    Ok(e) => e,
                    Err(err) => panic!("{label}: request failed: {err}"),
                };
                ack_writes(&mut core, &mut e);
                let timer_key = e.iter().find_map(|eff| match eff {
                    AcpEffect::ArmTimer { key, .. } => Some(key.clone()),
                    _ => None,
                });
                all_effects.extend(e);

                match path {
                    Path::Reply => {
                        all_effects.extend(core.stdout_bytes(
                            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n",
                        ));
                        all_effects.extend(core.stdout_bytes(
                            b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":false}}\n",
                        ));
                    }
                    Path::RpcError => {
                        all_effects.extend(core.stdout_bytes(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32603,\"message\":\"boom\"}}\n"));
                        all_effects.extend(
                            core.stdout_bytes(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n"),
                        );
                    }
                    Path::PeerTimeout => {
                        let key = timer_key.unwrap_or_default();
                        all_effects.extend(core.timer(&key));
                        all_effects.extend(
                            core.stdout_bytes(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n"),
                        );
                    }
                    Path::Fail => {
                        all_effects.extend(core.fail_session("transport broke"));
                        all_effects.extend(core.fail_session("second fault"));
                        all_effects.extend(core.finish(json!({ "code": 1 }), "1"));
                    }
                    Path::StdoutClosed => {
                        all_effects.extend(core.stdout_closed());
                        all_effects.extend(core.finish(json!({ "code": 1 }), "1"));
                    }
                    Path::Finish => {
                        all_effects.extend(core.finish(json!({ "code": 0 }), "0"));
                        all_effects.extend(
                            core.stdout_bytes(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n"),
                        );
                    }
                    Path::OpenStall => unreachable!(),
                }
            }
        }

        let got = settlements(&all_effects, target_id);
        assert_eq!(
            got.len(),
            1,
            "{label}: expected exactly one settlement, got {got:?}"
        );
        match expected {
            Expected::Ok(json) => {
                assert_eq!(&got[0], &Ok((*json).to_owned()), "{label}");
            }
            Expected::Err(code, message) => {
                assert_eq!(
                    got[0].as_ref().err(),
                    Some(&((*code).to_owned(), (*message).to_owned())),
                    "{label}"
                );
            }
        }
    }
}

#[test]
fn lenient_decoding_keeps_unknown_methods_malformed_lines_and_handles_server_requests() {
    let config = AcpCoreConfig::new("t-lenient", "/work", AcpSessionQuirks::generic());
    let (mut core, _) = AcpCore::new(config);
    core.native_session_id = JsString::from("root");
    core.routing.bind_root(JsString::from("root"));
    core.shells.set_root(JsString::from("root"));

    // 1. Unknown notification & malformed stdout line never fail the session.
    let e1 = core.stdout_bytes(
        b"not json at all\n{\"jsonrpc\":\"2.0\",\"method\":\"vendor/unknown\",\"params\":{\"x\":1}}\n",
    );
    assert!(!core.closed);
    assert!(e1.iter().any(|e| matches!(
        e,
        AcpEffect::Frame {
            dir: FrameDirection::Recv,
            channel,
            text,
        } if channel == "stdio-text" && text == "\"not json at all\""
    )));
    assert!(e1.iter().any(|e| matches!(
        e,
        AcpEffect::Frame {
            dir: FrameDirection::Recv,
            channel,
            text,
        } if channel == "stdio" && text.contains("\"vendor/unknown\"") && text.contains("\"x\":1")
    )));

    // 2. Server requests: cursor/task -> {}, unknown -> -32601, request_permission -> held in pending.
    let mut e2 = core.stdout_bytes(
        concat!(
            "{\"jsonrpc\":\"2.0\",\"id\":\"c1\",\"method\":\"cursor/task\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":\"u1\",\"method\":\"vendor/ask\",\"params\":{}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"session/request_permission\",\"params\":{\"sessionId\":\"root\",\"toolCall\":{\"toolCallId\":\"sh-req\",\"kind\":\"execute\",\"title\":\"Run ls\"},\"options\":[{\"optionId\":\"allow\",\"name\":\"Allow\",\"kind\":\"allow_once\"}]}}\n"
        )
        .as_bytes(),
    );
    ack_writes(&mut core, &mut e2);
    let replies = sent_json_messages(&e2);
    assert_eq!(replies.len(), 2);
    assert_eq!(replies[0].get("id").and_then(Value::as_str), Some("c1"));
    assert_eq!(replies[0].get("result"), Some(&json!({})));
    assert_eq!(replies[1].get("id").and_then(Value::as_str), Some("u1"));
    assert_eq!(
        replies[1].pointer("/error/code").and_then(Value::as_f64),
        Some(-32601.0)
    );
    // Permission request held in pending and registered its approval-first tool into shells.
    assert_eq!(core.pending.len(), 1);
    assert!(
        core.shells
            .knows(&JsString::from("root"), &JsString::from("sh-req"))
    );

    // Cancelling questions answers with cancelled outcome and clears pending + shell tool.
    let mut cancel_effects = Vec::new();
    core.cancel_questions(None, None, &mut cancel_effects);
    ack_writes(&mut core, &mut cancel_effects);
    assert!(core.pending.is_empty());
    assert!(
        !core
            .shells
            .knows(&JsString::from("root"), &JsString::from("sh-req"))
    );
    let cancel_replies = sent_json_messages(&cancel_effects);
    assert_eq!(
        cancel_replies[0]
            .pointer("/result/outcome/outcome")
            .and_then(Value::as_str),
        Some("cancelled")
    );
}

/// The leader's exit ends the work it started while its pipes still drain: a
/// buffered reply is captured, never allowed to resolve the call (`jsonrpc.ts:265`).
#[test]
fn leader_exit_settles_pending_calls_before_a_buffered_reply_can() {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        "t-exit",
        "/work",
        AcpSessionQuirks::generic(),
    ));
    let Ok(_sent) = core.request("custom/ping", Some(&json!({})), 61, Timeout::Disabled) else {
        panic!("request refused");
    };
    let exit_effects = core.mark_exited();
    let settled = settlements(&exit_effects, 61);
    assert_eq!(settled.len(), 1, "the exit ends the call: {settled:?}");
    let Err((code, message)) = &settled[0] else {
        panic!("the exit must settle the call as a failure: {settled:?}");
    };
    assert_eq!(code, "ACE_ACP_RPC_ERROR");
    assert_eq!(message, "process exited");

    let reply = json!({ "jsonrpc": "2.0", "id": 1, "result": { "ok": true } });
    let drained = core.stdout_bytes(format!("{}\n", reply.to_json()).as_bytes());
    assert!(
        settlements(&drained, 61).is_empty(),
        "a buffered reply never settles a call the exit ended"
    );
    assert!(
        drained.iter().any(|effect| matches!(
            effect,
            AcpEffect::Frame {
                dir: FrameDirection::Recv,
                channel,
                ..
            } if channel == "stdio"
        )),
        "the drain still captures frames: {drained:?}"
    );
}
