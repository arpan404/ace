// SPDX-License-Identifier: Apache-2.0
//! `classify` over the recordings, the eleven known types, and every shape that stays unknown;
//! the user message line.

use super::{parse, text};
use crate::message::{HostRequest, Line, MessageKind, Outcome, classify};
use crate::user::user_message;
use ace_json::Value;

const APPROVAL: &str =
    include_str!("../../../../../../fixtures/claude/2.1.286/approval-edit.jsonl");

fn kind_named(name: &str) -> MessageKind {
    match name {
        "system" => MessageKind::System,
        "assistant" => MessageKind::Assistant,
        "user" => MessageKind::User,
        "result" => MessageKind::Result,
        "stream_event" => MessageKind::StreamEvent,
        "rate_limit_event" => MessageKind::RateLimitEvent,
        other => panic!("unexpected recorded type {other}"),
    }
}

#[test]
fn every_recorded_stdout_line_classifies_as_its_message_kind() {
    let mut seen = std::collections::BTreeSet::new();
    for line in APPROVAL.lines() {
        let mut frame = parse(line);
        if frame.get("dir").and_then(Value::as_str) != Some("recv") {
            continue;
        }
        if frame.get("channel").and_then(Value::as_str) != Some("sdk") {
            continue;
        }
        let data = frame.get_mut("data").expect("a frame has data").take();
        let name = data
            .get("type")
            .and_then(Value::as_str)
            .expect("a recorded line has a type")
            .to_owned();
        match classify(data) {
            Line::Message { kind, .. } => assert_eq!(kind, kind_named(&name)),
            other => panic!("{name} classified as {other:?}"),
        }
        seen.insert(name);
    }
    let names: Vec<&str> = seen.iter().map(String::as_str).collect();
    assert_eq!(
        names,
        [
            "assistant",
            "rate_limit_event",
            "result",
            "stream_event",
            "system",
            "user",
        ]
    );
}

#[test]
fn the_five_types_the_recordings_do_not_contain_are_messages_too() {
    let kinds = [
        ("keep_alive", MessageKind::KeepAlive),
        ("tool_progress", MessageKind::ToolProgress),
        ("tool_use_summary", MessageKind::ToolUseSummary),
        ("auth_status", MessageKind::AuthStatus),
        ("prompt_suggestion", MessageKind::PromptSuggestion),
    ];
    for (name, kind) in kinds {
        let line = classify(parse(&format!(r#"{{"type":"{name}"}}"#)));
        assert!(matches!(line, Line::Message { kind: seen, .. } if seen == kind));
    }
}

#[test]
fn a_line_with_no_string_type_stays_unknown_and_whole() {
    for json in [
        "null",
        "[]",
        "42",
        r#"{"type":7}"#,
        r#"{"no_type":true}"#,
        r#"{"type":"command_lifecycle","state":"queued"}"#,
        r#"{"type":"control_future","payload":1}"#,
    ] {
        let expected = text(&parse(json));
        match classify(parse(json)) {
            Line::Unknown { value } => assert_eq!(text(&value), expected),
            other => panic!("{json} classified as {other:?}"),
        }
    }
}

#[test]
fn control_requests_map_to_their_host_requests() {
    let cases = [
        (
            r#"{"type":"control_request","request_id":"request-1","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{}}}"#,
            "request-1",
            HostRequest::CanUseTool,
        ),
        (
            r#"{"type":"control_request","request_id":"request-2","request":{"subtype":"elicitation","mcp_server_name":"s","message":"m"}}"#,
            "request-2",
            HostRequest::Elicitation,
        ),
        (
            r#"{"type":"control_request","request_id":"request-3","request":{"subtype":"request_user_dialog","dialog_kind":"future-kind","payload":{}}}"#,
            "request-3",
            HostRequest::UserDialog,
        ),
        (
            r#"{"type":"control_request","request_id":"request-4","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{}}}"#,
            "request-4",
            HostRequest::HookCallback {
                callback_id: "hook_0".to_owned(),
            },
        ),
        (
            r#"{"type":"control_request","request_id":"request-5","request":{"subtype":"future_kind"}}"#,
            "request-5",
            HostRequest::Other {
                subtype: "future_kind".to_owned(),
            },
        ),
        (
            r#"{"type":"control_request","request":{"subtype":"future_kind"}}"#,
            "",
            HostRequest::Other {
                subtype: "future_kind".to_owned(),
            },
        ),
        (
            r#"{"type":"control_request","request_id":"request-6","request":{}}"#,
            "request-6",
            HostRequest::Other {
                subtype: String::new(),
            },
        ),
    ];
    for (json, id, request) in cases {
        match classify(parse(json)) {
            Line::HostRequest {
                request_id,
                request: seen,
                value,
            } => {
                assert_eq!(request_id, id);
                assert_eq!(seen, request);
                assert_eq!(text(&value), text(&parse(json)));
            }
            other => panic!("{json} classified as {other:?}"),
        }
    }
}

#[test]
fn control_responses_carry_their_outcome_and_request_id() {
    let success = r#"{"type":"control_response","response":{"subtype":"success","request_id":"ace-1","response":{}}}"#;
    assert!(matches!(
        classify(parse(success)),
        Line::ControlResponse {
            outcome: Outcome::Success,
            ..
        }
    ));
    let error = r#"{"type":"control_response","response":{"subtype":"error","request_id":"request-9","error":"Synthetic stop failure"}}"#;
    match classify(parse(error)) {
        Line::ControlResponse {
            request_id,
            outcome,
            ..
        } => {
            assert_eq!(request_id, "request-9");
            assert_eq!(outcome, Outcome::Error("Synthetic stop failure".to_owned()));
        }
        other => panic!("{error} classified as {other:?}"),
    }
    assert!(matches!(
        classify(parse(r#"{"type":"control_response","response":{}}"#)),
        Line::ControlResponse { ref request_id, .. } if request_id.is_empty()
    ));
}

#[test]
fn a_cancel_request_keeps_the_id_it_cancels() {
    match classify(parse(
        r#"{"type":"control_cancel_request","request_id":"request-1"}"#,
    )) {
        Line::Cancel { request_id, .. } => assert_eq!(request_id, "request-1"),
        other => panic!("classified as {other:?}"),
    }
}

#[test]
fn a_user_message_keeps_ace_object_field_for_field() {
    let content = parse(r#"[{"type":"text","text":"hi"}]"#);
    let synthetic = user_message("uuid-1", "session-1", content, "now", true);
    assert_eq!(
        text(&synthetic),
        r#"{"type":"user","uuid":"uuid-1","session_id":"session-1","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"text","text":"hi"}]},"priority":"now","isSynthetic":true}"#
    );
    let plain = user_message(
        "uuid-2",
        "session-1",
        Value::from("plain text"),
        "next",
        false,
    );
    assert_eq!(
        text(&plain),
        r#"{"type":"user","uuid":"uuid-2","session_id":"session-1","parent_tool_use_id":null,"message":{"role":"user","content":"plain text"},"priority":"next"}"#
    );
}
