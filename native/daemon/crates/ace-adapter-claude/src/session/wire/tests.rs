// SPDX-License-Identifier: Apache-2.0
//! Wire cases no session file reaches: the two capture bounds, the confirmation-before-frame
//! order, the channel table, the 16 MiB framers, the task index, the rate-limit callback and the
//! terminal barrier.

use ace_json::Value;

use super::{ClaudeWire, Effect, FrameDir, WireConfig};
use crate::session::capture::{CaptureError, capture};

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
        assert_eq!(effects.len(), 1, "{line}");
        let (dir, seen, _) = frame(&effects[0]);
        assert_eq!(dir, FrameDir::Recv);
        assert_eq!(seen, channel);
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
fn notes_route_by_channel() {
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
    assert_eq!(null_type.len(), 1, "a non-string type stops at onWire");
    assert_eq!(frame(&null_type[0]).1, "wire");
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
