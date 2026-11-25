// SPDX-License-Identifier: Apache-2.0
//! Behavioral unit tests for the ACP session core and capture (E3-acp.1).

use ace_adapter_api::frame::FrameDirection;
use ace_json::{JsString, Value, json};
use ace_supervisor::peer::Timeout;

use super::core::{
    AcpCore, AcpCoreConfig, AcpEffect, CODE_OPEN_FAILED, CODE_RESUME_UNAVAILABLE,
    CODE_RESUME_UNSUPPORTED, CODE_RPC_ERROR,
};
use super::frames::MAX_PROVIDER_PAYLOAD_BYTES;
use super::io::AcpSessionCore;
use super::mcp::McpConfig;
use super::negotiation::CompatibilityProfile;
use super::open::ResumeTarget;
use super::quirks::AcpSessionQuirks;

fn ack_writes(core: &mut AcpCore, effects: &mut Vec<AcpEffect>) {
    let mut i = 0;
    while i < effects.len() {
        if let AcpEffect::Write { ticket, .. } = effects[i] {
            let follow = core.written(ticket);
            effects.extend(follow);
        }
        i += 1;
    }
}

fn sent_json_messages(effects: &[AcpEffect]) -> Vec<Value> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Write { wire, .. } => {
                let text = std::str::from_utf8(wire).ok()?.trim();
                ace_json::parse(text).ok()
            }
            _ => None,
        })
        .collect()
}

fn settlements(effects: &[AcpEffect], facade_id: u64) -> Vec<Result<String, (String, String)>> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Settle { id, result } if *id == facade_id => Some(match result {
                Ok(json) => Ok(json.clone()),
                Err(err) => Err((err.code.to_owned(), err.message.clone())),
            }),
            _ => None,
        })
        .collect()
}

fn note_frames(effects: &[AcpEffect], channel: &str) -> Vec<Value> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            AcpEffect::Frame {
                dir: FrameDirection::Note,
                channel: ch,
                text,
            } if ch == channel => ace_json::parse(text).ok(),
            _ => None,
        })
        .collect()
}

fn gemini_profile() -> CompatibilityProfile {
    CompatibilityProfile {
        id: "gemini-043".to_owned(),
        agent: "gemini".to_owned(),
        version: "0.43.0".to_owned(),
        compatible: None,
        legacy_model: true,
        deny_selectors: false,
        deny_resume: false,
        deny_http_mcp: false,
        subagent_sessions: false,
    }
}

#[test]
fn open_handshake_negotiates_capabilities_filters_mcp_servers_and_emits_notes() {
    let mut config = AcpCoreConfig::new("thread-1", "/work", AcpSessionQuirks::generic());
    config.version = Some("0.43.0".to_owned());
    config.profile = Some(gemini_profile());
    config.mcp = Some(McpConfig {
        http_servers: vec![json!({ "name": "ace", "type": "http", "url": "http://127.0.0.1:99" })],
        stdio_servers: vec![json!({ "name": "ace", "command": "node", "args": ["bridge.js"] })],
        configured_servers: vec![
            json!({ "name": "local-stdio", "command": "tool-bin" }),
            json!({ "name": "remote-http", "type": "http", "url": "https://example.test/mcp" }),
            json!({ "name": "remote-sse", "type": "sse", "url": "https://example.test/sse" }),
        ],
        secrets: vec!["top-secret-lease".to_owned()],
        instructions: Some("use ace tools".to_owned()),
        developer_instructions: None,
    });

    let (mut core, init_effects) = AcpCore::new(config);
    assert_eq!(
        note_frames(&init_effects, "recorder"),
        vec![json!({ "event": "process-start" })]
    );

    let mut effects = core.start_open(10);
    ack_writes(&mut core, &mut effects);
    let sent = sent_json_messages(&effects);
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].get("method").and_then(Value::as_str),
        Some("initialize")
    );
    assert_eq!(
        sent[0]
            .pointer("/params/protocolVersion")
            .and_then(Value::as_f64),
        Some(1.0)
    );
    let init_id = sent[0].get("id").and_then(Value::as_f64).unwrap_or(0.0) as i64;

    // Agent responds with a compatible newer version, stdio-only MCP (http: false, sse: false),
    // and unknown extra fields that must survive raw capture.
    let init_reply = json!({
        "jsonrpc": "2.0",
        "id": init_id,
        "result": {
            "protocolVersion": 1,
            "agentInfo": { "name": "gemini-cli", "version": "0.45.0", "extraVendor": "kept" },
            "agentCapabilities": {
                "loadSession": true,
                "promptCapabilities": { "image": true, "embeddedContext": true },
                "mcpCapabilities": { "http": false, "sse": false },
                "futureFeature": { "nested": true }
            }
        }
    });
    let mut step2 = core.stdout_bytes(format!("{}\n", init_reply.to_json()).as_bytes());
    ack_writes(&mut core, &mut step2);

    // Diagnostic notes for version change and unverified compatible profile.
    let diag = note_frames(&step2, "diagnostic");
    assert_eq!(diag.len(), 2);
    assert_eq!(
        diag[0].get("event").and_then(Value::as_str),
        Some("acp-version-changed")
    );
    assert_eq!(
        diag[1].get("event").and_then(Value::as_str),
        Some("acp-version-unverified")
    );

    // Stdio-only agent skips HTTP and SSE servers with mcp-server-skipped notes.
    let skipped = note_frames(&step2, "recorder");
    assert_eq!(
        skipped,
        vec![
            json!({ "event": "mcp-server-skipped", "name": "remote-http", "transport": "http" }),
            json!({ "event": "mcp-server-skipped", "name": "remote-sse", "transport": "sse" }),
        ]
    );

    // Next outbound RPC is session/new with only local-stdio + injected stdio server.
    let sent2 = sent_json_messages(&step2);
    assert_eq!(sent2.len(), 1);
    assert_eq!(
        sent2[0].get("method").and_then(Value::as_str),
        Some("session/new")
    );
    let mcp_servers = sent2[0]
        .pointer("/params/mcpServers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert_eq!(mcp_servers.len(), 2);
    assert_eq!(
        mcp_servers[0].get("name").and_then(Value::as_str),
        Some("local-stdio")
    );
    assert_eq!(
        mcp_servers[1].get("name").and_then(Value::as_str),
        Some("ace")
    );
    assert_eq!(
        mcp_servers[1].get("command").and_then(Value::as_str),
        Some("node")
    );

    let new_id = sent2[0].get("id").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let new_reply = json!({
        "jsonrpc": "2.0",
        "id": new_id,
        "result": {
            "sessionId": "sess-42",
            "modes": {
                "currentModeId": "default",
                "availableModes": [
                    { "id": "plan", "name": "Plan" },
                    { "id": "default", "name": "Manual" },
                    { "id": "yolo", "name": "YOLO" }
                ]
            },
            "models": {
                "currentModelId": "gemini-2.5",
                "availableModels": [{ "modelId": "gemini-2.5", "name": "Gemini 2.5" }]
            }
        }
    });
    let step3 = core.stdout_bytes(format!("{}\n", new_reply.to_json()).as_bytes());
    let settled = settlements(&step3, 10);
    assert_eq!(settled.len(), 1);
    let Ok(open_json) = &settled[0] else {
        panic!("expected open to succeed");
    };
    let parsed = ace_json::parse(open_json).unwrap_or(Value::Null);
    assert_eq!(
        parsed.get("nativeSessionId").and_then(Value::as_str),
        Some("sess-42")
    );
    assert_eq!(parsed.get("steerViaCancel"), Some(&Value::Bool(true)));
    assert_eq!(
        parsed.get("mcpTransport").and_then(Value::as_str),
        Some("stdio")
    );
    assert_eq!(
        parsed.pointer("/capabilities/planMode"),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        parsed.pointer("/support/coverage").and_then(Value::as_str),
        Some("source_profile")
    );
    assert_eq!(
        parsed.pointer("/support/modelSelection"),
        Some(&Value::Bool(true))
    );
    assert_eq!(
        parsed.pointer("/support/modeSelection"),
        Some(&Value::Bool(true))
    );
    // Capabilities callback and session metadata callback both fired.
    assert!(step3.iter().any(|e| matches!(
        e,
        AcpEffect::Callback {
            name: "onCapabilities",
            ..
        }
    )));
    assert!(step3.iter().any(|e| matches!(
        e,
        AcpEffect::Callback {
            name: "onSessionMetadata",
            ..
        }
    )));
}

/// An agent that needs a sign-in method is reported, not answered here:
/// `openWithSignIn` stays TypeScript around the native open (E3-acp.3).
#[test]
fn auth_required_settles_the_open_rather_than_selecting_a_sign_in_method() {
    let (mut core, mut sent) = opened_antigravity_core(1);
    let auth_err = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "error": { "code": -32000, "message": "Authentication required" }
    });
    let ended = core.stdout_bytes(format!("{}\n", auth_err.to_json()).as_bytes());
    let settled = settlements(&ended, 1);
    assert_eq!(settled.len(), 1);
    let Err((code, message)) = &settled[0] else {
        panic!("the open must fail: {settled:?}");
    };
    assert_eq!(code, CODE_OPEN_FAILED);
    assert!(message.contains("Authentication required"), "{message}");
    sent.extend(ended);
    assert!(
        sent_json_messages(&sent)
            .iter()
            .all(|message| message.get("method").and_then(Value::as_str) != Some("authenticate")),
        "nothing selects a sign-in method in Rust"
    );
}

/// Antigravity names the session in an update before answering `session/new`,
/// and that name settles the open (`session.ts:222`, `:295`).
#[test]
fn antigravity_names_the_session_before_answering_session_new() {
    let (mut core, _) = opened_antigravity_core(1);
    let pre_update = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": { "sessionId": "agy-sess-1", "update": { "sessionUpdate": "custom_init" } }
    });
    let new_ok = json!({ "jsonrpc": "2.0", "id": 2, "result": {} });
    let combined = format!("{}\n{}\n", pre_update.to_json(), new_ok.to_json());
    let opened = core.stdout_bytes(combined.as_bytes());
    let settled = settlements(&opened, 1);
    assert_eq!(settled.len(), 1);
    assert!(settled[0].is_ok());
    assert_eq!(core.native_session_id, JsString::from("agy-sess-1"));
    assert!(!core.steer_via_cancel);
    assert!(core.guided);
}

/// An Antigravity core past `initialize`, with `session/new` carrying ace's guidance.
fn opened_antigravity_core(facade_id: u64) -> (AcpCore, Vec<AcpEffect>) {
    let mut config = AcpCoreConfig::new("thread-agy", "/work", AcpSessionQuirks::antigravity());
    config.version = Some("1.2.1".to_owned());
    config.mcp = Some(McpConfig {
        instructions: Some("follow ace guidance".to_owned()),
        ..McpConfig::default()
    });
    let (mut core, _) = AcpCore::new(config);
    let mut sent = core.start_open(facade_id);
    ack_writes(&mut core, &mut sent);
    let init_reply = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "protocolVersion": 1,
            "agentInfo": { "name": "antigravity-acp", "version": "1.2.1" },
            "_meta": { "steering": { "supported": true } },
            "agentCapabilities": {
                "loadSession": true,
                "_meta": { "antigravity": { "systemPrompt": { "append": true } } }
            }
        }
    });
    let mut after_init = core.stdout_bytes(format!("{}\n", init_reply.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_init);
    let sent_new = sent_json_messages(&after_init);
    assert_eq!(
        sent_new[0]
            .pointer("/params/_meta/antigravity/systemPrompt/append")
            .and_then(Value::as_str),
        Some("follow ace guidance")
    );
    sent.extend(after_init);
    (core, sent)
}

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

#[test]
fn resume_open_classifies_unsupported_and_unavailable_failures() {
    // 1. Agent does not advertise load/resume -> resume_unsupported before sending session/load.
    let mut cfg1 = AcpCoreConfig::new("t-res-1", "/work", AcpSessionQuirks::generic());
    cfg1.resume = Some(ResumeTarget {
        native_session_id: "old".to_owned(),
    });
    let (mut core1, _) = AcpCore::new(cfg1);
    let mut e1 = core1.start_open(1);
    ack_writes(&mut core1, &mut e1);
    let e2 =
        core1.stdout_bytes(b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1}}\n");
    let settled = settlements(&e2, 1);
    assert_eq!(settled.len(), 1);
    assert_eq!(
        settled[0].as_ref().err().map(|(c, _)| c.as_str()),
        Some(CODE_RESUME_UNSUPPORTED)
    );

    // 2. Agent advertises sessionCapabilities.resume -> sends session/resume -> -32002 -> resume_unavailable.
    let mut cfg2 = AcpCoreConfig::new("t-res-2", "/work", AcpSessionQuirks::generic());
    cfg2.resume = Some(ResumeTarget {
        native_session_id: "missing-id".to_owned(),
    });
    let (mut core2, _) = AcpCore::new(cfg2);
    let mut f1 = core2.start_open(2);
    ack_writes(&mut core2, &mut f1);
    let mut f2 = core2.stdout_bytes(
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{\"sessionCapabilities\":{\"resume\":{}}}}}\n",
    );
    ack_writes(&mut core2, &mut f2);
    assert_eq!(
        sent_json_messages(&f2)[0]
            .get("method")
            .and_then(Value::as_str),
        Some("session/resume")
    );
    let f3 = core2.stdout_bytes(
        b"{\"jsonrpc\":\"2.0\",\"id\":2,\"error\":{\"code\":-32002,\"message\":\"not found\"}}\n",
    );
    let settled2 = settlements(&f3, 2);
    assert_eq!(settled2.len(), 1);
    assert_eq!(
        settled2[0].as_ref().err().map(|(c, _)| c.as_str()),
        Some(CODE_RESUME_UNAVAILABLE)
    );
}

/// An outbound frame whose capture throws ends the session, and none of that
/// step's effects follow it: TS never reaches the write (`jsonrpc.ts:285`).
#[test]
fn uncapturable_outbound_frame_fails_before_any_byte_reaches_stdin() {
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
        12,
        Timeout::Disabled,
    ) else {
        panic!("request refused");
    };
    assert!(
        effects
            .iter()
            .any(|effect| matches!(effect, AcpEffect::Fatal { .. })),
        "the capture failure is fatal"
    );
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, AcpEffect::Write { .. })),
        "no line reaches stdin after its frame failed to capture"
    );
    let settled = settlements(&effects, 12);
    assert_eq!(settled.len(), 1, "the call settles once: {settled:?}");
    assert!(settled[0].is_err());
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

/// An agent that takes system-prompt text gets ace's guidance in `_meta`, from
/// the lease when it carried instructions and from the daemon's rendered
/// developer instructions otherwise (`session.ts:155`, `:447`).
#[test]
fn system_prompt_append_carries_lease_or_developer_instructions() {
    let cases = [
        (Some("lease guidance".to_owned()), "lease guidance"),
        (None, "developer guidance"),
    ];
    for (lease, expected) in cases {
        let mut config =
            AcpCoreConfig::new("thread-guidance", "/work", AcpSessionQuirks::antigravity());
        config.version = Some("1.2.1".to_owned());
        config.mcp = Some(McpConfig {
            instructions: lease.clone(),
            developer_instructions: Some("developer guidance".to_owned()),
            ..McpConfig::default()
        });
        let (mut core, _) = AcpCore::new(config);
        let mut opened = core.start_open(3);
        ack_writes(&mut core, &mut opened);
        let init_reply = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "protocolVersion": 1,
                "agentInfo": { "name": "antigravity-acp", "version": "1.2.1" },
                "_meta": { "steering": { "supported": true } },
                "agentCapabilities": {
                    "loadSession": true,
                    "_meta": { "antigravity": { "systemPrompt": { "append": true } } }
                }
            }
        });
        let mut after = core.stdout_bytes(format!("{}\n", init_reply.to_json()).as_bytes());
        ack_writes(&mut core, &mut after);
        let sent = sent_json_messages(&after);
        assert_eq!(
            sent[0]
                .pointer("/params/_meta/antigravity/systemPrompt/append")
                .and_then(Value::as_str),
            Some(expected),
            "lease instructions {lease:?}"
        );
    }
}

/// A launch's saved mode, model and effort each apply, in that order, before the
/// open settles; only then does the daemon hear what runs (`session.ts:495`–`:509`).
#[test]
fn open_applies_saved_mode_model_and_effort_before_it_settles() {
    let mut config = AcpCoreConfig::new("t-saved", "/work", AcpSessionQuirks::generic());
    config.permission_mode = Some("plan".to_owned());
    config.model = Some("model-b".to_owned());
    let (mut core, opened, mut effects) = open_with_saved(config, 21);
    assert!(
        settlements(&effects, 21).is_empty(),
        "the open waits for its saved options"
    );
    let sent = sent_json_messages(&opened);
    assert_eq!(
        sent[0].get("method").and_then(Value::as_str),
        Some("session/set_mode")
    );
    assert_eq!(
        sent[0].pointer("/params/modeId").and_then(Value::as_str),
        Some("plan")
    );

    let mode_ok =
        json!({ "jsonrpc": "2.0", "id": 3, "result": { "modes": { "currentModeId": "plan" } } });
    let mut after_mode = core.stdout_bytes(format!("{}\n", mode_ok.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_mode);
    effects.extend(after_mode.clone());
    assert!(settlements(&after_mode, 21).is_empty());
    let sent = sent_json_messages(&after_mode);
    assert_eq!(
        sent[0].get("method").and_then(Value::as_str),
        Some("session/set_model")
    );
    assert_eq!(
        sent[0].pointer("/params/modelId").and_then(Value::as_str),
        Some("model-b")
    );

    let model_ok = json!({ "jsonrpc": "2.0", "id": 4, "result": { "models": { "currentModelId": "model-b" } } });
    let settled = core.stdout_bytes(format!("{}\n", model_ok.to_json()).as_bytes());
    let done = settlements(&settled, 21);
    assert_eq!(
        done.len(),
        1,
        "the open settles after its last saved option"
    );
    let parsed = ace_json::parse(done[0].as_ref().map(String::as_str).unwrap_or("null"))
        .unwrap_or(Value::Null);
    assert_eq!(parsed.get("refusedOptions"), Some(&json!([])));
    assert_eq!(
        parsed.get("nativeSessionId").and_then(Value::as_str),
        Some("sess-1")
    );
}

/// A saved option the agent no longer lists is reported refused, never failed:
/// the start goes on and the daemon records what runs instead (`session.ts:496`).
#[test]
fn open_reports_saved_options_the_agent_no_longer_lists_as_refused() {
    let mut config = AcpCoreConfig::new("t-refused", "/work", AcpSessionQuirks::generic());
    config.permission_mode = Some("plan".to_owned());
    config.model = Some("model-b".to_owned());
    config.effort = Some("high".to_owned());
    let reply = json!({ "jsonrpc": "2.0", "id": 2, "result": { "sessionId": "sess-1" } });
    let (_core, _opened, effects) = open_with_saved_reply(config, 22, &reply);
    let done = settlements(&effects, 22);
    assert_eq!(done.len(), 1);
    let parsed = ace_json::parse(done[0].as_ref().map(String::as_str).unwrap_or("null"))
        .unwrap_or(Value::Null);
    assert_eq!(
        parsed.get("refusedOptions"),
        Some(&json!(["permissionMode", "model", "effort"]))
    );
}

/// A model's reply can reset the mode: the mode ace set is restored before the open
/// settles, and a restore the agent refuses is swallowed, not reported (`session.ts:577`).
#[test]
fn open_restores_the_saved_mode_a_model_reply_reset() {
    let mut config = AcpCoreConfig::new("t-restore", "/work", AcpSessionQuirks::generic());
    config.permission_mode = Some("plan".to_owned());
    config.model = Some("model-b".to_owned());
    let reply = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
            "sessionId": "sess-1",
            "configOptions": [
                option("model", "model", "model-a"),
                option("mode", "mode", "default")
            ]
        }
    });
    let (mut core, _opened, mut effects) = open_with_saved_reply(config, 23, &reply);

    let mode_ok = json!({
        "jsonrpc": "2.0",
        "id": 3,
        "result": { "configOptions": [option("model", "model", "model-a"), option("mode", "mode", "plan")] }
    });
    let mut after_mode = core.stdout_bytes(format!("{}\n", mode_ok.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_mode);
    effects.extend(after_mode);

    // The model's reply carries fresh options, with the mode back at its default.
    let model_reset = json!({
        "jsonrpc": "2.0",
        "id": 4,
        "result": { "configOptions": [option("model", "model", "model-b"), option("mode", "mode", "default")] }
    });
    let mut after_model = core.stdout_bytes(format!("{}\n", model_reset.to_json()).as_bytes());
    ack_writes(&mut core, &mut after_model);
    effects.extend(after_model.clone());
    assert!(settlements(&after_model, 23).is_empty());
    let sent = sent_json_messages(&after_model);
    assert_eq!(
        sent[0].pointer("/params/configId").and_then(Value::as_str),
        Some("mode")
    );
    assert_eq!(
        sent[0].pointer("/params/value").and_then(Value::as_str),
        Some("plan")
    );

    // The agent refuses the restore: the open still succeeds, with nothing refused.
    let restore_err = json!({
        "jsonrpc": "2.0",
        "id": 5,
        "error": { "code": -32603, "message": "mode locked" }
    });
    let settled = core.stdout_bytes(format!("{}\n", restore_err.to_json()).as_bytes());
    let done = settlements(&settled, 23);
    assert_eq!(done.len(), 1);
    let Ok(open_json) = &done[0] else {
        panic!("a refused restore never fails the start: {done:?}");
    };
    let parsed = ace_json::parse(open_json).unwrap_or(Value::Null);
    assert_eq!(parsed.get("refusedOptions"), Some(&json!([])));
}

/// One `configOptions` select listing both saved values.
fn option(id: &str, category: &str, current: &str) -> Value {
    let values: Vec<Value> = if category == "model" {
        vec![json!({ "value": "model-a" }), json!({ "value": "model-b" })]
    } else {
        vec![json!({ "value": "plan" }), json!({ "value": "default" })]
    };
    json!({
        "id": id,
        "category": category,
        "type": "select",
        "currentValue": current,
        "options": values
    })
}

/// A core whose `session/new` reply lists `plan`/`default`, two models and no effort
/// level, already past `initialize`.
fn open_with_saved(
    config: AcpCoreConfig,
    facade_id: u64,
) -> (AcpCore, Vec<AcpEffect>, Vec<AcpEffect>) {
    let reply = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "result": {
            "sessionId": "sess-1",
            "modes": {
                "currentModeId": "default",
                "availableModes": [{ "id": "plan" }, { "id": "default" }]
            },
            "models": {
                "currentModelId": "model-a",
                "availableModels": [{ "modelId": "model-a" }, { "modelId": "model-b" }]
            }
        }
    });
    open_with_saved_reply(config, facade_id, &reply)
}

fn open_with_saved_reply(
    config: AcpCoreConfig,
    facade_id: u64,
    new_reply: &Value,
) -> (AcpCore, Vec<AcpEffect>, Vec<AcpEffect>) {
    let (mut core, _) = AcpCore::new(config);
    let mut effects = core.start_open(facade_id);
    ack_writes(&mut core, &mut effects);
    let mut init = core.stdout_bytes(
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":1,\"agentCapabilities\":{}}}\n",
    );
    ack_writes(&mut core, &mut init);
    effects.extend(init);
    let mut opened = core.stdout_bytes(format!("{}\n", new_reply.to_json()).as_bytes());
    ack_writes(&mut core, &mut opened);
    effects.extend(opened.clone());
    (core, opened, effects)
}

/// Abandon ends the call that is still pending and only then drains: without that
/// settlement the facade's open promise would never settle (`io.rs:115`).
#[test]
fn abandon_settles_a_call_still_pending_before_it_drains() {
    let (mut core, _) = AcpCore::new(AcpCoreConfig::new(
        "t-abandon",
        "/work",
        AcpSessionQuirks::generic(),
    ));
    let Ok(sent) = core.request("custom/ping", Some(&json!({})), 77, Timeout::Disabled) else {
        panic!("request refused");
    };
    assert!(
        sent.iter()
            .any(|effect| matches!(effect, AcpEffect::Write { .. })),
        "the call is still pending: {sent:?}"
    );

    let effects = core.abandon();
    let settled = settlements(&effects, 77);
    assert_eq!(
        settled.len(),
        1,
        "abandon settles the pending call: {settled:?}"
    );
    assert_eq!(
        settled[0],
        Err((
            CODE_RPC_ERROR.to_owned(),
            "ACP session abandoned before start".to_owned()
        ))
    );
    assert!(matches!(effects.last(), Some(AcpEffect::Drained)));
}

#[test]
fn session_io_shell_publishes_process_start_and_settles_on_abandon() {
    let config = AcpCoreConfig::new("t-io", "/work", AcpSessionQuirks::generic());
    let session = AcpSessionCore::new(config);
    // Starting open before child ports are attached triggers write refusal -> settles once.
    session.start_open(42);
    session.abandon();

    let batch = session.queue().take_batch(64, 1024 * 1024);
    let json = ace_json::ser::to_string(&batch).unwrap_or_default();
    assert!(json.contains("process-start"));
    assert!(json.contains(CODE_OPEN_FAILED));
    assert!(json.contains("\"drained\""));
}
