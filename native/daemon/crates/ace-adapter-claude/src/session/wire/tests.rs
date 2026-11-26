// SPDX-License-Identifier: Apache-2.0
//! Wire cases no session file reaches: the two capture bounds, the confirmation-before-frame
//! order, the channel table, the 16 MiB framers, the task index, the rate-limit callback and the
//! terminal barrier.

use ace_json::Value;

use super::{ClaudeWire, Effect, FrameDir, LINE_BYTES, WireConfig};
use crate::session::capture::{CaptureError, capture};
use crate::session::error::ClaudeError;

const NATIVE_ACE_MCP: &str =
    include_str!("../../../../../../../fixtures/claude/2.1.286/native-ace-mcp.jsonl");
const APPROVAL: &str =
    include_str!("../../../../../../../fixtures/claude/2.1.286/approval-edit.jsonl");

fn new_wire() -> ClaudeWire {
    wire_with_session("session-1")
}

fn wire_with_session(session_id: &str) -> ClaudeWire {
    ClaudeWire::new(WireConfig {
        session_id: session_id.to_owned(),
        root_key: "root".to_owned(),
        bearer: None,
        hooks: Vec::new(),
        resume: false,
    })
}

fn push_line(wire: &mut ClaudeWire, line: &str) -> Vec<Effect> {
    wire.stdout_bytes(format!("{line}\n").as_bytes())
}

fn frame(effect: &Effect) -> (FrameDir, &'static str, &str) {
    match effect {
        Effect::Frame { dir, channel, text } => (*dir, channel, text),
        other => panic!("expected a frame, got {other:?}"),
    }
}

/// One recorded frame's `data`, moved out of the JSONL line.
fn recorded(source: &str, pick: impl Fn(&Value) -> bool) -> Value {
    for line in source.lines() {
        let mut value = ace_json::parse(line).expect("a fixture line parses");
        let Some(data) = value.get_mut("data") else {
            continue;
        };
        let data = data.take();
        if pick(&data) {
            return data;
        }
    }
    panic!("the fixture holds the requested line");
}

fn is_type(data: &Value, kind: &str) -> bool {
    data.get("type").and_then(Value::as_str) == Some(kind)
}

#[test]
fn the_structural_limit_counts_every_value_once() {
    let inside = Value::from(vec![Value::Null; 32_767]);
    assert!(capture(&inside, None).is_ok(), "32,768 nodes");
    let outside = Value::from(vec![Value::Null; 32_768]);
    assert_eq!(capture(&outside, None), Err(CaptureError::Structural));
}

#[test]
fn the_byte_limit_counts_utf8_bytes_with_an_emoji_at_the_limit() {
    // A JSON string of exactly 1 MiB: quotes plus 262,143 astral characters plus two spaces.
    let emoji = "\u{1f600}".repeat(262_143);
    let at_limit = Value::from(format!("{emoji}  "));
    let text = capture(&at_limit, None).expect("exactly one MiB is admitted");
    assert_eq!(text.len(), 1024 * 1024);
    assert!(
        text.encode_utf16().count() < 1024 * 1024,
        "the unit pre-check passes"
    );
    let over = Value::from(format!("{emoji}  x"));
    assert_eq!(capture(&over, None), Err(CaptureError::Bytes));
}

#[test]
fn an_elided_attachment_and_the_bearer_are_scrubbed_from_the_capture() {
    let mut map = ace_json::Map::new();
    map.insert("attachment", Value::from("A".repeat(20_000).as_str()));
    map.insert("bearer", Value::from("secret-token"));
    let text = capture(&Value::Object(map), Some("secret-token")).expect("under both bounds");
    assert!(text.contains("[ace: "), "the attachment is elided: {text}");
    assert!(!text.contains("secret-token"), "the bearer is gone: {text}");
    assert!(text.contains("<ACE_MCP_CREDENTIAL>"));
}

#[test]
fn a_recorded_init_line_confirms_before_its_frame() {
    let init = recorded(NATIVE_ACE_MCP, |data| {
        is_type(data, "system") && data.get("subtype").and_then(Value::as_str) == Some("init")
    });
    let session = init
        .get("session_id")
        .and_then(Value::as_str)
        .expect("the init names its session")
        .to_owned();
    let mut wire = wire_with_session(&session);
    let effects = push_line(&mut wire, &ace_json::to_string(&init));
    assert_eq!(effects.len(), 2);
    match &effects[0] {
        Effect::Callback { name, json } => {
            assert_eq!(*name, "onSessionConfirmed");
            assert_eq!(json, &format!("\"{session}\""));
        }
        other => panic!("the callback comes first, got {other:?}"),
    }
    assert_eq!(
        frame(&effects[1]),
        (FrameDir::Recv, "sdk", ace_json::to_string(&init).as_str())
    );
}

#[test]
fn a_parentless_user_line_confirms_once_and_a_child_line_does_not() {
    let parentless = r#"{"type":"user","session_id":"session-1","parent_tool_use_id":null,"message":{"role":"user","content":[]}}"#;
    let mut wire = new_wire();
    let first = push_line(&mut wire, parentless);
    assert!(matches!(
        first.as_slice(),
        [Effect::Callback { .. }, Effect::Frame { .. }]
    ));
    let second = push_line(&mut wire, parentless);
    assert!(matches!(second.as_slice(), [Effect::Frame { .. }]));

    let child = r#"{"type":"user","session_id":"session-1","parent_tool_use_id":"tool-1","message":{"role":"user","content":[]}}"#;
    let mut fresh = new_wire();
    let effects = push_line(&mut fresh, child);
    assert!(matches!(effects.as_slice(), [Effect::Frame { .. }]));
}

#[test]
fn control_lines_keep_their_frame_channels() {
    let cases = [
        (
            r#"{"type":"control_request","request_id":"r","request":{"subtype":"can_use_tool"}}"#,
            "wire",
        ),
        (
            r#"{"type":"control_response","response":{"subtype":"success","request_id":"r","response":{}}}"#,
            "wire",
        ),
        (
            r#"{"type":"control_cancel_request","request_id":"r"}"#,
            "sdk",
        ),
    ];
    for (line, channel) in cases {
        let effects = push_line(&mut new_wire(), line);
        let (dir, seen, _) = frame(&effects[0]);
        assert_eq!(dir, FrameDir::Recv, "{line}");
        assert_eq!(seen, channel, "{line}");
    }

    let malformed = push_line(&mut new_wire(), "not json");
    assert_eq!(
        frame(&malformed[0]),
        (
            FrameDir::Recv,
            "wire",
            r#"{"type":"malformed_stdout","line":"not json"}"#
        )
    );
}

#[test]
fn a_stderr_line_over_16_mib_is_dropped_and_noted() {
    let mut bytes = vec![b'x'; 16 * 1024 * 1024 + 1];
    bytes.push(b'\n');
    let effects = new_wire().stderr_bytes(&bytes);
    assert_eq!(effects.len(), 2);
    assert_eq!(
        frame(&effects[0]),
        (
            FrameDir::Stderr,
            "sdk",
            "\"ace dropped a stderr line of 16777217 bytes\""
        )
    );
    assert!(matches!(
        &effects[1],
        Effect::ArmTimer { key, ms } if key == "notes" && *ms == 1_000.0
    ));
}

#[test]
fn the_task_index_resolves_and_cascades() {
    let mut wire = new_wire();
    push_line(
        &mut wire,
        r#"{"type":"system","subtype":"task_started","task_id":"parent-task","tool_use_id":"spawn-parent","session_id":"session-1"}"#,
    );
    push_line(
        &mut wire,
        r#"{"type":"assistant","parent_tool_use_id":"spawn-parent","session_id":"session-1","message":{"role":"assistant","content":[{"type":"tool_use","id":"spawn-child","name":"Agent","input":{}}]}}"#,
    );
    push_line(
        &mut wire,
        r#"{"type":"system","subtype":"task_started","task_id":"child-task","tool_use_id":"spawn-child","session_id":"session-1"}"#,
    );
    assert_eq!(
        wire.task_cascade(Some("spawn-parent")),
        r#"{"ids":["child-task"],"uncertain":false}"#
    );
    assert_eq!(wire.task_cascade(None), r#"{"ids":[],"uncertain":true}"#);
    assert_eq!(
        wire.task_target("spawn-child").expect("the child resolves"),
        r#"{"id":"child-task","spawn":"spawn-child","parent":"spawn-parent","live":true,"run":"","route":"spawn-child"}"#
    );
}

#[test]
fn a_rate_limit_event_emits_the_callback_after_its_frame() {
    let event = recorded(APPROVAL, |data| is_type(data, "rate_limit_event"));
    let info = event
        .get("rate_limit_info")
        .expect("the event carries info");
    let effects = push_line(&mut new_wire(), &ace_json::to_string(&event));
    assert_eq!(effects.len(), 2);
    assert_eq!(
        frame(&effects[0]),
        (FrameDir::Recv, "sdk", ace_json::to_string(&event).as_str())
    );
    match &effects[1] {
        Effect::Callback { name, json } => {
            assert_eq!(*name, "onRateLimit");
            assert_eq!(json, &ace_json::to_string(info));
        }
        other => panic!("the callback follows the frame, got {other:?}"),
    }
}

#[test]
fn notes_route_by_channel_and_unknown_channels_are_dropped() {
    let mut wire = new_wire();
    let accounts =
        wire.note(r#"{"channel":"accounts","data":{"type":"rate_limit_observation_failed"}}"#);
    assert_eq!(
        frame(&accounts[0]),
        (
            FrameDir::Note,
            "accounts",
            r#"{"type":"rate_limit_observation_failed"}"#
        )
    );
}

#[test]
fn finish_delivers_a_final_line_without_a_newline() {
    let mut wire = new_wire();
    assert!(wire.stdout_bytes(br#"{"type":"keep_alive"}"#).is_empty());
    let effects = wire.finish();
    assert_eq!(
        frame(&effects[0]),
        (FrameDir::Recv, "sdk", r#"{"type":"keep_alive"}"#)
    );
    assert!(matches!(
        &effects[1],
        Effect::CancelTimer { key } if key == "notes"
    ));
    assert!(matches!(effects.last(), Some(Effect::Drained)));
    assert!(wire.finish().is_empty());
}

#[test]
fn an_empty_stdout_line_is_malformed_stdout() {
    let effects = new_wire().stdout_bytes(b"\n");
    assert_eq!(
        frame(&effects[0]),
        (
            FrameDir::Recv,
            "wire",
            r#"{"type":"malformed_stdout","line":""}"#
        )
    );
}

#[test]
fn a_bare_cr_ends_a_stdout_line() {
    let mut wire = new_wire();
    let effects = wire.stdout_bytes(b"{\"type\":\"keep_alive\"}\r");
    assert_eq!(
        frame(&effects[0]),
        (FrameDir::Recv, "sdk", r#"{"type":"keep_alive"}"#)
    );
    assert!(
        wire.stdout_bytes(b"\n").is_empty(),
        "the LF of a split CRLF is skipped"
    );
}

#[test]
fn a_known_and_unknown_type_keep_the_frame_set_they_have_today() {
    // `native-ace-mcp.jsonl` seq 5-8: an unknown type is `recv/wire` and then `recv/sdk`.
    let line = recorded(NATIVE_ACE_MCP, |data| is_type(data, "command_lifecycle"));
    let text = ace_json::to_string(&line);
    let effects = push_line(&mut new_wire(), &text);
    assert_eq!(effects.len(), 2);
    assert_eq!(frame(&effects[0]), (FrameDir::Recv, "wire", text.as_str()));
    assert_eq!(frame(&effects[1]), (FrameDir::Recv, "sdk", text.as_str()));
    let null_type = push_line(&mut new_wire(), r#"{"type":null,"x":1}"#);
    assert_eq!(null_type.len(), 2);
    assert_eq!(frame(&null_type[1]).1, "sdk");
}

#[test]
fn a_resumed_wire_starts_confirmed() {
    let mut wire = ClaudeWire::new(WireConfig {
        session_id: "session-1".to_owned(),
        root_key: "root".to_owned(),
        bearer: None,
        hooks: Vec::new(),
        resume: true,
    });
    let parentless = r#"{"type":"user","session_id":"session-1","parent_tool_use_id":null,"message":{"role":"user","content":[]}}"#;
    let effects = push_line(&mut wire, parentless);
    assert!(matches!(effects.as_slice(), [Effect::Frame { .. }]));
}

#[test]
fn a_fatal_or_finish_latches_every_later_input() {
    let mut wire = new_wire();
    wire.stdout_bytes(&vec![b'x'; 16 * 1024 * 1024 + 1]);
    assert!(wire.stdout_bytes(b"{\"type\":\"keep_alive\"}\n").is_empty());
    assert!(wire.stderr_bytes(b"a line\n").is_empty());
    assert!(wire.note(r#"{"channel":"accounts","data":{}}"#).is_empty());

    let mut finished = new_wire();
    finished.finish();
    assert!(
        finished
            .stdout_bytes(b"{\"type\":\"keep_alive\"}\n")
            .is_empty()
    );
    assert!(finished.stderr_bytes(b"a line\n").is_empty());
    assert!(
        finished
            .note(r#"{"channel":"accounts","data":{}}"#)
            .is_empty()
    );
}

#[test]
fn the_16_mib_gate_counts_raw_bytes_per_line() {
    const LIMIT: usize = 16 * 1024 * 1024;
    let gate = "Process output line exceeded limit (line limit 16777216 bytes)";
    // A bare base64 run: not JSON, and elided to a marker, so the line stays cheap to capture.
    let exact = vec![b'A'; LIMIT];
    let mut chunk = exact.clone();
    chunk.push(b'\n');
    assert_eq!(frame(&new_wire().stdout_bytes(&chunk)[0]).1, "wire");

    let mut over = exact.clone();
    over.push(b'x');
    over.push(b'\n');
    let effects = new_wire().stdout_bytes(&over);
    assert!(matches!(&effects[0], Effect::Fatal { message } if message == gate));

    // A CR or LF resets the count, so a chunk past 16 MiB of two lines is admitted.
    for delimiter in [b'\r', b'\n'] {
        let mut chunk = vec![b'A'; LIMIT - 1];
        chunk.push(delimiter);
        chunk.extend_from_slice(b"{\"type\":\"keep_alive\"}\n");
        let effects = new_wire().stdout_bytes(&chunk);
        assert_eq!(effects.len(), 2, "both lines are framed");
        assert_eq!(frame(&effects[1]).1, "sdk");
    }
}

#[test]
fn a_capture_failure_and_a_task_capacity_error_keep_their_class_prefixes() {
    let huge = format!(
        r#"{{"type":"keep_alive","data":"{}"}}"#,
        " ".repeat(1024 * 1024)
    );
    let capture = push_line(&mut new_wire(), &huge);
    assert!(matches!(
        &capture[0],
        Effect::Fatal { message } if message == "RangeError: Provider payload exceeds byte limit"
    ));

    let mut tasks = new_wire();
    for index in 0..512 {
        push_line(
            &mut tasks,
            &format!(
                r#"{{"type":"system","subtype":"task_started","task_id":"task-{index}","tool_use_id":"spawn-{index}"}}"#
            ),
        );
    }
    let over = push_line(
        &mut tasks,
        r#"{"type":"system","subtype":"task_started","task_id":"task-over","tool_use_id":"spawn-over"}"#,
    );
    assert!(matches!(
        &over[over.len() - 1],
        Effect::Fatal { message } if message == "Error: Claude live task capacity reached"
    ));
}

#[test]
fn a_control_request_is_written_then_framed_on_acknowledgement() {
    let mut wire = new_wire();
    let cases = [
        (r#"{"subtype":"mcp_status"}"#, r#"{"subtype":"mcp_status"}"#),
        (
            r#"{"subtype":"interrupt","cancel_queued":true}"#,
            r#"{"subtype":"interrupt","cancel_queued":true}"#,
        ),
        (
            r#"{"subtype":"initialize","hooks":{"SubagentStart":[{"hookCallbackIds":["hook_0"]}]},"forwardSubagentText":true,"perTaskStopAffordance":true}"#,
            r#"{"subtype":"initialize","hooks":{"SubagentStart":[{"hookCallbackIds":["hook_0"]}]},"forwardSubagentText":true,"perTaskStopAffordance":true}"#,
        ),
    ];
    for (index, (json, expected)) in cases.iter().enumerate() {
        let effects = wire
            .control(json, index as u64)
            .expect("the controls are open");
        assert_eq!(effects.len(), 1);
        let Effect::Write { wire: bytes } = &effects[0] else {
            panic!("a control request writes");
        };
        let id = format!("ace-{}", index + 1);
        assert_eq!(
            String::from_utf8_lossy(bytes),
            format!(
                "{{\"request_id\":\"{id}\",\"type\":\"control_request\",\"request\":{expected}}}\n"
            )
        );
        let frame_text = format!(
            "{{\"request_id\":\"{id}\",\"type\":\"control_request\",\"request\":{expected}}}"
        );
        assert_eq!(
            frame(&wire.stdin_written()[0]),
            (FrameDir::Send, "wire", frame_text.as_str())
        );
    }
}

#[test]
fn a_control_response_frames_first_then_settles_its_tag() {
    let mut wire = new_wire();
    wire.control(r#"{"subtype":"interrupt"}"#, 41)
        .expect("open");
    let success = push_line(
        &mut wire,
        r#"{"type":"control_response","response":{"subtype":"success","request_id":"ace-1","response":{"still_queued":[]}}}"#,
    );
    assert_eq!(frame(&success[0]).1, "wire");
    assert!(matches!(
        &success[1],
        Effect::Settle { id: 41, result: Ok(text) } if text == r#"{"still_queued":[]}"#
    ));

    wire.control(r#"{"subtype":"stop_task","task_id":"t"}"#, 42)
        .expect("open");
    let error = push_line(
        &mut wire,
        r#"{"type":"control_response","response":{"subtype":"error","request_id":"ace-2","error":"Synthetic stop failure"}}"#,
    );
    assert!(matches!(
        &error[1],
        Effect::Settle { id: 42, result: Err(ClaudeError::Provider(text)) }
            if text == "Synthetic stop failure"
    ));

    let unknown = push_line(
        &mut wire,
        r#"{"type":"control_response","response":{"subtype":"success","request_id":"ace-99","response":null}}"#,
    );
    assert_eq!(unknown.len(), 1);
}

#[test]
fn a_permission_is_framed_peeked_and_answered_in_order() {
    let mut wire = new_wire();
    let effects = push_line(
        &mut wire,
        r#"{"type":"control_request","request_id":"request-1","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{"file_path":"a.ts"},"tool_use_id":"tool-1","permission_suggestions":[]}}"#,
    );
    assert_eq!(effects.len(), 2);
    assert_eq!(frame(&effects[1]).1, "can_use_tool");
    let data = ace_json::parse(frame(&effects[1]).2).expect("the frame is JSON");
    assert_eq!(data.get("toolName").and_then(Value::as_str), Some("Edit"));
    assert_eq!(
        data.pointer("/options/requestId").and_then(Value::as_str),
        Some("request-1")
    );
    let peek = ace_json::parse(&wire.peek_interaction("request-1").expect("pending"))
        .expect("the request is JSON");
    assert_eq!(peek.get("kind").and_then(Value::as_str), Some("approval"));

    let (found, effects) = wire.answer_interaction(
        "request-1",
        r#"{"behavior":"allow"}"#,
        r#"{"kind":"approval","optionId":"allow_once"}"#,
    );
    assert!(found);
    assert_eq!(
        frame(&effects[0]),
        (
            FrameDir::Send,
            "can_use_tool",
            r#"{"requestId":"request-1","result":{"behavior":"allow"},"resolution":{"kind":"approval","optionId":"allow_once"}}"#
        )
    );
    assert!(matches!(&effects[1], Effect::Write { .. }));
    assert_eq!(frame(&wire.stdin_written()[0]).1, "wire");
    assert!(wire.peek_interaction("request-1").is_none());
    assert!(!wire.answer_interaction("request-1", "{}", "{}").0);
}

#[test]
fn an_elicitation_and_a_dialog_keep_their_frame_shapes() {
    let mut wire = new_wire();
    let elicitation = push_line(
        &mut wire,
        r#"{"type":"control_request","request_id":"request-2","request":{"subtype":"elicitation","mcp_server_name":"project-tools","message":"Pick a color","mode":"form","requested_schema":{"type":"object"}}}"#,
    );
    assert_eq!(
        frame(&elicitation[1]),
        (
            FrameDir::Recv,
            "elicitation",
            r#"{"requestId":"request-2","request":{"kind":"elicitation","server":"project-tools","message":"Pick a color","mode":"form","schema":{"type":"object"}},"native":{"serverName":"project-tools","message":"Pick a color","mode":"form","requestedSchema":{"type":"object"}}}"#
        )
    );
    assert!(wire.peek_interaction("request-2").is_some());

    let dialog = push_line(
        &mut wire,
        r#"{"type":"control_request","request_id":"request-3","request":{"subtype":"request_user_dialog","dialog_kind":"future-kind","payload":{}}}"#,
    );
    assert_eq!(
        frame(&dialog[1]),
        (
            FrameDir::Recv,
            "user_dialog",
            r#"{"dialogKind":"future-kind","payload":{}}"#
        )
    );
    let Effect::Write { wire: bytes } = &dialog[2] else {
        panic!("the dialog is answered");
    };
    assert_eq!(
        String::from_utf8_lossy(bytes),
        "{\"type\":\"control_response\",\"response\":{\"subtype\":\"success\",\"request_id\":\"request-3\",\"response\":{\"behavior\":\"cancelled\"}}}\n"
    );
}

#[test]
fn a_cancel_and_expire_answer_with_the_kind_default() {
    let permission = r#"{"type":"control_request","request_id":"request-4","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{}}}"#;
    let mut wire = new_wire();
    push_line(&mut wire, permission);
    let cancelled = push_line(
        &mut wire,
        r#"{"type":"control_cancel_request","request_id":"request-4"}"#,
    );
    assert_eq!(
        frame(&cancelled[0]),
        (
            FrameDir::Recv,
            "interaction_lifecycle",
            r#"{"requestId":"request-4","state":"cancelled"}"#
        )
    );
    let Effect::Write { wire: bytes } = &cancelled[1] else {
        panic!("the default answer is written");
    };
    assert!(String::from_utf8_lossy(bytes).contains("Claude request ended."));
    assert_eq!(frame(&cancelled[2]).1, "sdk");

    // A cancel seen before its request makes the late registration expire at once.
    let mut late = new_wire();
    push_line(
        &mut late,
        r#"{"type":"control_cancel_request","request_id":"request-5"}"#,
    );
    let late_permission = push_line(
        &mut late,
        r#"{"type":"control_request","request_id":"request-5","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{}}}"#,
    );
    assert_eq!(late_permission.len(), 4);
    assert_eq!(frame(&late_permission[2]).1, "interaction_lifecycle");

    let mut expiring = new_wire();
    push_line(&mut expiring, permission);
    let expired = expiring.expire();
    assert_eq!(
        frame(&expired[0]),
        (
            FrameDir::Recv,
            "interaction_lifecycle",
            r#"{"requestId":"request-4","state":"expired"}"#
        )
    );
    assert!(matches!(&expired[1], Effect::Write { .. }));
    assert!(expiring.expire().is_empty());
}

#[test]
fn the_interaction_cap_and_duplicate_ids_fail_before_a_frame() {
    let mut full = new_wire();
    for index in 0..256 {
        push_line(
            &mut full,
            &format!(
                r#"{{"type":"control_request","request_id":"request-{index}","request":{{"subtype":"can_use_tool","tool_name":"Edit","input":{{}}}}}}"#
            ),
        );
    }
    let over = push_line(
        &mut full,
        r#"{"type":"control_request","request_id":"request-256","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{}}}"#,
    );
    assert_eq!(over.len(), 2);
    assert!(matches!(
        &over[1],
        Effect::Fatal { message } if message == "Error: Claude interaction capacity reached"
    ));

    let mut duplicate = new_wire();
    let line = r#"{"type":"control_request","request_id":"request-1","request":{"subtype":"can_use_tool","tool_name":"Edit","input":{}}}"#;
    push_line(&mut duplicate, line);
    let again = push_line(&mut duplicate, line);
    assert!(matches!(
        &again[1],
        Effect::Fatal { message } if message == "Error: Duplicate Claude request id"
    ));
}

#[test]
fn hooks_frame_observations_and_wait_for_the_prompt_callback() {
    let mut wire = new_wire();
    let observation = push_line(
        &mut wire,
        r#"{"type":"control_request","request_id":"hook-1","request":{"subtype":"hook_callback","callback_id":"hook_0","input":{"hook_event_name":"SubagentStart","session_id":"session-1"}}}"#,
    );
    assert_eq!(
        frame(&observation[1]),
        (
            FrameDir::Recv,
            "observational_hook",
            r#"{"hook_event_name":"SubagentStart","session_id":"session-1"}"#
        )
    );
    let Effect::Write { wire: bytes } = &observation[2] else {
        panic!("the observation is answered");
    };
    assert!(String::from_utf8_lossy(bytes).contains("\"response\":{}"));

    let prompt = push_line(
        &mut wire,
        r#"{"type":"control_request","request_id":"hook-2","request":{"subtype":"hook_callback","callback_id":"hook_1","input":{"hook_event_name":"UserPromptSubmit"}}}"#,
    );
    assert_eq!(prompt.len(), 2);
    assert!(matches!(
        &prompt[1],
        Effect::Callback { name: "hook:UserPromptSubmit", json } if json == r#"["hook-2"]"#
    ));
    let answer = wire.answer_hook(
        "hook-2",
        r#"{"hookSpecificOutput":{"additionalContext":"x"}}"#,
    );
    assert!(matches!(&answer[0], Effect::Write { .. }));
    assert_eq!(frame(&wire.stdin_written()[0]).1, "wire");
    assert!(wire.answer_hook("hook-2", "{}").is_empty());
}

#[test]
fn an_unknown_control_subtype_is_answered_with_the_error_envelope() {
    let mut wire = new_wire();
    let effects = push_line(
        &mut wire,
        r#"{"type":"control_request","request_id":"request-9","request":{"subtype":"future_kind"}}"#,
    );
    assert_eq!(effects.len(), 2);
    let Effect::Write { wire: bytes } = &effects[1] else {
        panic!("the unknown request is answered");
    };
    assert_eq!(
        String::from_utf8_lossy(bytes),
        "{\"type\":\"control_response\",\"response\":{\"subtype\":\"error\",\"request_id\":\"request-9\",\"error\":\"Unsupported control request: future_kind\"}}\n"
    );
}

#[test]
fn send_refuses_whole_then_frames_each_write() {
    let message = r#"{"type":"user","uuid":"uuid-1","session_id":"s","message":{"role":"user","content":"hi"},"priority":"next"}"#;
    let mut wire = new_wire();
    let effects = wire
        .send(&format!("[{message}]"), Some("command-1"))
        .expect("the input is admitted");
    assert_eq!(effects.len(), 2);
    assert!(matches!(
        &effects[0],
        Effect::Callback { name: "onInputMessage", json }
            if json == r#"{"commandId":"command-1","nativeId":"uuid-1"}"#
    ));
    assert!(matches!(&effects[1], Effect::Write { .. }));
    assert_eq!(
        frame(&wire.stdin_written()[0]),
        (FrameDir::Send, "sdk", message)
    );

    let mut full = new_wire();
    for _ in 0..256 {
        full.send(&format!("[{message}]"), None).expect("admitted");
    }
    assert_eq!(
        full.send(&format!("[{message}]"), None),
        Err(ClaudeError::Refused(
            "Claude input capacity reached".to_owned()
        ))
    );

    let mut refused = new_wire();
    refused
        .send(&format!("[{message}]"), None)
        .expect("admitted");
    assert!(matches!(
        &refused.write_refused()[0],
        Effect::Fatal { message } if message == "Claude stdin closed"
    ));
    assert_eq!(
        refused.send(&format!("[{message}]"), None),
        Err(ClaudeError::Refused("Claude stdin closed".to_owned()))
    );
}

#[test]
fn the_outbound_bound_counts_utf8_bytes_with_an_emoji_at_the_limit() {
    // `{"text":""}` plus a newline is 12 bytes; the emoji makes the limit byte-counted.
    let pad = LINE_BYTES - 12 - 4;
    let at_limit = format!("[{{\"text\":\"{}\u{1f600}\"}}]", "a".repeat(pad));
    let mut wire = new_wire();
    assert_eq!(
        wire.send(&at_limit, None),
        Err(ClaudeError::Refused(
            "Provider payload exceeds byte limit".to_owned()
        )),
        "exactly 16 MiB passes the line bound and stops at the 1 MiB frame bound"
    );
    let over = format!("[{{\"text\":\"{}\u{1f600}a\"}}]", "a".repeat(pad));
    assert_eq!(
        new_wire().send(&over, None),
        Err(ClaudeError::Refused(
            "Claude outbound frame capacity reached".to_owned()
        ))
    );
}

#[test]
fn a_stdin_error_is_fatal_and_refuses_later_sends() {
    let mut wire = new_wire();
    assert!(matches!(
        &wire.stdin_error("write EPIPE")[0],
        Effect::Fatal { message } if message == "write EPIPE"
    ));
    assert_eq!(
        wire.send("[]", None),
        Err(ClaudeError::Refused("write EPIPE".to_owned()))
    );
}
