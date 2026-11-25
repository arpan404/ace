// SPDX-License-Identifier: Apache-2.0
//! The open handshake: `initialize`, MCP filtering, guidance and resume failures.

use ace_json::{JsString, Value, json};

use super::{ack_writes, gemini_profile, note_frames, sent_json_messages, settlements};
use crate::session::core::{
    AcpCore, AcpCoreConfig, AcpEffect, CODE_OPEN_FAILED, CODE_RESUME_UNAVAILABLE,
    CODE_RESUME_UNSUPPORTED,
};
use crate::session::mcp::McpConfig;
use crate::session::open::ResumeTarget;
use crate::session::quirks::AcpSessionQuirks;

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
