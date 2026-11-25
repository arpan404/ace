// SPDX-License-Identifier: Apache-2.0
//! The answer envelopes and the host shapes of section 2's mapping, including the fields only
//! the fake and the recordings show.

use super::{parse, text};
use crate::host::{elicitation_request, error, permission_options, success, user_dialog_request};
use crate::message::{HostRequest, Line, classify};
use ace_json::{Map, Value};

const APPROVAL: &str =
    include_str!("../../../../../../fixtures/claude/2.1.286/approval-edit.jsonl");

fn object(value: &Value) -> &Map {
    value.as_object().expect("the test value is an object")
}

fn mapped(value: Map) -> String {
    text(&Value::Object(value))
}

#[test]
fn an_unknown_control_request_is_answered_with_the_error_envelope() {
    let json = r#"{"type":"control_request","request_id":"request-9","request":{"subtype":"future_kind"}}"#;
    let Line::HostRequest {
        request_id,
        request,
        value,
    } = classify(parse(json))
    else {
        panic!("an unknown control request is a host request");
    };
    let HostRequest::Other { subtype } = request else {
        panic!("an unknown subtype stays other");
    };
    assert_eq!(subtype, "future_kind");
    assert_eq!(text(&value), text(&parse(json)));
    let answer = error(
        &request_id,
        &format!("Unsupported control request: {subtype}"),
    );
    assert_eq!(
        text(&answer),
        r#"{"type":"control_response","response":{"subtype":"error","request_id":"request-9","error":"Unsupported control request: future_kind"}}"#
    );
}

#[test]
fn a_success_answer_carries_its_response_after_the_request_id() {
    let answer = success("ace-1", parse(r#"{"backgrounded":true}"#));
    assert_eq!(
        text(&answer),
        r#"{"type":"control_response","response":{"subtype":"success","request_id":"ace-1","response":{"backgrounded":true}}}"#
    );
}

#[test]
fn a_permission_request_maps_every_dts_option_under_its_own_name() {
    let raw = parse(
        r#"{
            "subtype":"can_use_tool",
            "tool_name":"Bash",
            "input":{},
            "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
            "blocked_path":"/tmp/x",
            "mcp_server":{"name":"project-tools","source":"project"},
            "decision_reason":"Contains simple_expansion",
            "title":"Claude wants to run a command",
            "display_name":"Bash",
            "description":"Print 60 ticks",
            "default_to_no":true,
            "suppress_always_allow_rule":true,
            "tool_use_id":"tool-1",
            "agent_id":"agent-1",
            "matched_ask_rule":{"source":"projectSettings","tool_name":"Bash","rule_content":"git *"}
        }"#,
    );
    assert_eq!(
        mapped(permission_options(object(&raw), "request-1")),
        r#"{"suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],"blockedPath":"/tmp/x","mcpServer":{"name":"project-tools","source":"project"},"decisionReason":"Contains simple_expansion","title":"Claude wants to run a command","displayName":"Bash","description":"Print 60 ticks","defaultToNo":true,"suppressAlwaysAllowRule":true,"toolUseID":"tool-1","agentID":"agent-1","requestId":"request-1","matchedAskRule":{"source":"projectSettings","toolName":"Bash","ruleContent":"git *"}}"#
    );
}

#[test]
fn a_permission_with_no_optional_fields_writes_only_the_request_id() {
    let raw = parse(r#"{"subtype":"can_use_tool","tool_name":"Edit","input":{}}"#);
    assert_eq!(
        mapped(permission_options(object(&raw), "request-2")),
        r#"{"requestId":"request-2"}"#
    );
}

#[test]
fn a_recorded_permission_request_maps_back_to_the_options_it_was_shown_with() {
    let mut data = None;
    for line in APPROVAL.lines() {
        let mut frame = parse(line);
        if frame.get("dir").and_then(Value::as_str) == Some("recv")
            && frame.get("channel").and_then(Value::as_str) == Some("can_use_tool")
        {
            data = Some(frame.get_mut("data").expect("data").take());
            break;
        }
    }
    let mut data = data.expect("the recording shows a permission");
    let expected = text(data.get("options").expect("options"));
    let request_id = data
        .get("options")
        .and_then(|options| options.get("requestId"))
        .and_then(Value::as_str)
        .expect("the recording names the request")
        .to_owned();
    let mut options = data.get_mut("options").expect("options").take();
    let mut raw = Map::new();
    raw.insert("subtype", Value::from("can_use_tool"));
    raw.insert(
        "tool_name",
        data.get_mut("toolName").expect("toolName").take(),
    );
    raw.insert("input", data.get_mut("input").expect("input").take());
    let renames = [
        ("suggestions", "permission_suggestions"),
        ("displayName", "display_name"),
        ("description", "description"),
        ("toolUseID", "tool_use_id"),
        ("decisionReason", "decision_reason"),
        ("requestId", "request_id"),
    ];
    for (mapped, wire) in renames {
        if let Some(value) = options
            .as_object_mut()
            .expect("options is an object")
            .remove(mapped)
        {
            raw.insert(wire, value);
        }
    }
    assert_eq!(
        mapped(permission_options(&raw, &request_id)),
        expected,
        "the recorded options come back byte for byte"
    );
}

#[test]
fn a_form_elicitation_maps_to_the_host_callback_shape() {
    let raw = parse(
        r#"{"subtype":"elicitation","mcp_server_name":"project-tools","message":"Pick a color","mode":"form","requested_schema":{"type":"object"},"title":"Consent","display_name":"Colors","description":"From project MCP"}"#,
    );
    assert_eq!(
        mapped(elicitation_request(object(&raw))),
        r#"{"serverName":"project-tools","message":"Pick a color","mode":"form","requestedSchema":{"type":"object"},"title":"Consent","displayName":"Colors","description":"From project MCP"}"#
    );
}

#[test]
fn a_url_elicitation_keeps_its_url_and_elicitation_id() {
    let raw = parse(
        r#"{"subtype":"elicitation","mcp_server_name":"project-tools","message":"Open this","mode":"url","url":"https://example.test/consent","elicitation_id":"url-ask"}"#,
    );
    assert_eq!(
        mapped(elicitation_request(object(&raw))),
        r#"{"serverName":"project-tools","message":"Open this","mode":"url","url":"https://example.test/consent","elicitationId":"url-ask"}"#
    );
}

#[test]
fn a_user_dialog_maps_dialog_kind_payload_and_tool_use_id() {
    let raw = parse(
        r#"{"subtype":"request_user_dialog","dialog_kind":"future-kind","payload":{"question":"go?"},"tool_use_id":"tool-1"}"#,
    );
    assert_eq!(
        mapped(user_dialog_request(object(&raw))),
        r#"{"dialogKind":"future-kind","payload":{"question":"go?"},"toolUseID":"tool-1"}"#
    );
    let bare =
        parse(r#"{"subtype":"request_user_dialog","dialog_kind":"future-kind","payload":{}}"#);
    assert_eq!(
        mapped(user_dialog_request(object(&bare))),
        r#"{"dialogKind":"future-kind","payload":{}}"#
    );
}
