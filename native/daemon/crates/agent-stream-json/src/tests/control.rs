// SPDX-License-Identifier: Apache-2.0
//! `Controls` and every request's pinned wire shape. The initialize request is compared whole
//! with the handshake recordings.

use super::{parse, text};
use crate::control::{Controls, Initialize, Request};
use crate::error::ControlError;
use ace_json::{Map, Value};

const CODING_WIRE: &str =
    include_str!("../../../../../../fixtures/claude/handshake-2.1.331/coding.wire.jsonl");
const ISOLATED_WIRE: &str =
    include_str!("../../../../../../fixtures/claude/handshake-2.1.331/isolated.wire.jsonl");
const NATIVE_ACE_MCP: &str =
    include_str!("../../../../../../fixtures/claude/2.1.286/native-ace-mcp.jsonl");

/// The first `send`/`wire` `initialize` request in a recording.
fn initialize_frame(source: &str) -> Value {
    for line in source.lines() {
        let mut frame = parse(line);
        if frame.get("dir").and_then(Value::as_str) != Some("send") {
            continue;
        }
        let Some(data) = frame.get_mut("data") else {
            continue;
        };
        if data.get("type").and_then(Value::as_str) != Some("control_request") {
            continue;
        }
        let subtype = data
            .get("request")
            .and_then(|request| request.get("subtype"))
            .and_then(Value::as_str);
        if subtype == Some("initialize") {
            return data.take();
        }
    }
    panic!("the fixture records no initialize request");
}

/// ace's coding configuration: the `claude_code` preset with the two hooks E3-claude.3 adds.
fn initialize() -> Initialize {
    Initialize {
        hooks: vec![
            ("SubagentStart".to_owned(), vec!["hook_0".to_owned()]),
            ("SubagentStop".to_owned(), vec!["hook_1".to_owned()]),
        ],
        append_system_prompt: None,
        system_prompt: None,
        forward_subagent_text: true,
        per_task_stop_affordance: true,
    }
}

/// The envelope `Controls` builds for one request, under a fresh set.
fn requested(request: Request) -> Value {
    let mut controls = Controls::new();
    controls
        .request(request, 1)
        .expect("the controls are open")
        .1
}

fn request_text(envelope: &Value) -> String {
    text(envelope.get("request").expect("an envelope has a request"))
}

fn settings() -> Map {
    let mut settings = Map::new();
    settings.insert("effortLevel", Value::from("high"));
    settings
}

fn servers() -> Map {
    let mut servers = Map::new();
    servers.insert("ace", Value::from(Vec::<Value>::new()));
    servers
}

#[test]
fn the_coding_handshake_initialize_request_comes_back_byte_for_byte() {
    let mut recorded = initialize_frame(CODING_WIRE);
    *recorded.get_mut("request_id").expect("a request id") = Value::from("ace-1");
    assert_eq!(
        text(&requested(Request::Initialize(initialize()))),
        text(&recorded)
    );
}

#[test]
fn the_isolated_handshake_initialize_request_comes_back_byte_for_byte() {
    let mut init = initialize();
    init.system_prompt = Some(vec![String::new()]);
    let mut recorded = initialize_frame(ISOLATED_WIRE);
    *recorded.get_mut("request_id").expect("a request id") = Value::from("ace-1");
    assert_eq!(text(&requested(Request::Initialize(init))), text(&recorded));
}

#[test]
fn the_recorded_append_system_prompt_keeps_its_place() {
    let mut recorded = initialize_frame(NATIVE_ACE_MCP);
    let append = recorded
        .get("request")
        .and_then(|request| request.get("appendSystemPrompt"))
        .and_then(Value::as_str)
        .expect("the recording appends a prompt")
        .to_owned();
    let mut init = initialize();
    init.append_system_prompt = Some(append);
    *recorded.get_mut("request_id").expect("a request id") = Value::from("ace-1");
    assert_eq!(text(&requested(Request::Initialize(init))), text(&recorded));
}

#[test]
fn absent_subagent_flags_stay_absent() {
    let mut init = initialize();
    init.hooks.clear();
    init.forward_subagent_text = false;
    init.per_task_stop_affordance = false;
    assert_eq!(
        request_text(&requested(Request::Initialize(init))),
        r#"{"subtype":"initialize"}"#
    );
}

#[test]
fn request_ids_count_up_from_ace_one() {
    let mut controls = Controls::new();
    let (first, envelope) = controls
        .request(Request::McpStatus, 7)
        .expect("the controls are open");
    assert_eq!(first, "ace-1");
    assert_eq!(
        text(&envelope),
        r#"{"request_id":"ace-1","type":"control_request","request":{"subtype":"mcp_status"}}"#
    );
    let (second, _) = controls
        .request(Request::McpStatus, 8)
        .expect("the controls are open");
    assert_eq!(second, "ace-2");
}

#[test]
fn a_response_settles_exactly_one_tag() {
    let mut controls = Controls::new();
    let (id, _) = controls
        .request(
            Request::GetUsage {
                skip_behaviors: true,
            },
            41,
        )
        .expect("the controls are open");
    assert_eq!(controls.settle(&id), Some(41));
    assert_eq!(controls.settle(&id), None);
    assert_eq!(controls.settle("ace-99"), None);
}

#[test]
fn drain_returns_pending_tags_in_order_and_closes_the_controls() {
    let mut controls = Controls::new();
    controls
        .request(Request::SetModel(Some("opus".to_owned())), 1)
        .expect("the controls are open");
    controls
        .request(Request::McpStatus, 2)
        .expect("the controls are open");
    controls
        .request(Request::SetModel(None), 3)
        .expect("the controls are open");
    let (settled, _) = controls
        .request(Request::McpStatus, 4)
        .expect("the controls are open");
    assert_eq!(controls.settle(&settled), Some(4));
    assert_eq!(controls.drain(), vec![1, 2, 3]);
    assert_eq!(
        controls.request(Request::McpStatus, 5),
        Err(ControlError::Closed)
    );
}

#[test]
fn every_request_writes_its_pinned_fields_in_order() {
    let cases = [
        (
            Request::Interrupt {
                cancel_queued: false,
            },
            r#"{"subtype":"interrupt"}"#,
        ),
        (
            Request::Interrupt {
                cancel_queued: true,
            },
            r#"{"subtype":"interrupt","cancel_queued":true}"#,
        ),
        (Request::SetModel(None), r#"{"subtype":"set_model"}"#),
        (
            Request::SetModel(Some("opus".to_owned())),
            r#"{"subtype":"set_model","model":"opus"}"#,
        ),
        (
            Request::SetPermissionMode("plan".to_owned()),
            r#"{"subtype":"set_permission_mode","mode":"plan"}"#,
        ),
        (
            Request::ApplyFlagSettings(settings()),
            r#"{"subtype":"apply_flag_settings","settings":{"effortLevel":"high"}}"#,
        ),
        (
            Request::StopTask("child-one".to_owned()),
            r#"{"subtype":"stop_task","task_id":"child-one"}"#,
        ),
        (
            Request::BackgroundTasks { tool_use_id: None },
            r#"{"subtype":"background_tasks"}"#,
        ),
        (
            Request::BackgroundTasks {
                tool_use_id: Some("tool-1".to_owned()),
            },
            r#"{"subtype":"background_tasks","tool_use_id":"tool-1"}"#,
        ),
        (Request::McpStatus, r#"{"subtype":"mcp_status"}"#),
        (
            Request::McpSetServers(servers()),
            r#"{"subtype":"mcp_set_servers","servers":{"ace":[]}}"#,
        ),
        (
            Request::McpReconnect("project-tools".to_owned()),
            r#"{"subtype":"mcp_reconnect","serverName":"project-tools"}"#,
        ),
        (
            Request::McpToggle {
                server: "project-tools".to_owned(),
                enabled: false,
            },
            r#"{"subtype":"mcp_toggle","serverName":"project-tools","enabled":false}"#,
        ),
        (
            Request::GetUsage {
                skip_behaviors: false,
            },
            r#"{"subtype":"get_usage"}"#,
        ),
        (
            Request::GetUsage {
                skip_behaviors: true,
            },
            r#"{"subtype":"get_usage","skip_behaviors":true}"#,
        ),
    ];
    for (request, expected) in cases {
        assert_eq!(request_text(&requested(request)), expected);
    }
}
