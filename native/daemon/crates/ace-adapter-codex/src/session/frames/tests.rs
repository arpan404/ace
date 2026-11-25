// SPDX-License-Identifier: Apache-2.0
//! The frame path: the credential scrub, the bound, the omittable rule and
//! the recorded form of a history reply.

use super::*;

#[test]
fn every_frame_carries_the_redacted_bearer_and_never_the_credential() {
    let bearer = "a".repeat(64);
    let frames = Frames::new(Some(bearer.clone()));
    let data = ace_json::parse(&format!("{{\"authorization\":\"Bearer {bearer}\"}}"))
        .expect("fixture parses");
    let emitted = frames
        .emit(FrameDir::Send, &data, "stdio", None)
        .expect("a small frame");
    assert_eq!(emitted.frames.len(), 1);
    assert_eq!(
        emitted.frames[0].text,
        format!("{{\"authorization\":\"Bearer {MCP_CREDENTIAL}\"}}")
    );
    assert!(!emitted.frames[0].text.contains(&bearer));
}

#[test]
fn without_a_bearer_the_frame_is_the_encoded_data_unchanged() {
    let frames = Frames::new(None);
    let data = ace_json::parse("{\"a\":1}").expect("fixture parses");
    let emitted = frames
        .emit(FrameDir::Recv, &data, "stdio", None)
        .expect("a small frame");
    assert_eq!(emitted.frames[0].text, "{\"a\":1}");
}

#[test]
fn a_received_frame_over_the_bound_on_a_shared_host_is_left_out_and_recovered() {
    let mut frames = Frames::new(None);
    frames.attach_shared();
    let padding = "x".repeat(MAX_PAYLOAD_BYTES);
    let data = ace_json::parse(&format!(
            "{{\"method\":\"item/agentMessage/delta\",\"params\":{{\"threadId\":\"t1\"}},\"padding\":\"{padding}\"}}"
        ))
        .expect("fixture parses");
    let emitted = frames
        .emit(FrameDir::Recv, &data, "stdio", None)
        .expect("the frame is left out, not fatal");
    assert!(emitted.recover_output);
    assert_eq!(emitted.frames.len(), 1);
    assert_eq!(emitted.frames[0].dir, FrameDir::Note);
    let note = ace_json::parse(&emitted.frames[0].text).expect("the note parses");
    assert_eq!(
        note.get("event").and_then(Value::as_str),
        Some("output-line-dropped")
    );
    assert_eq!(
        note.get("reason").and_then(Value::as_str),
        Some("frame-bound")
    );
    assert_eq!(note.get("phase").and_then(Value::as_str), Some("complete"));
    assert_eq!(
        note.pointer("/attributed/threadId").and_then(Value::as_str),
        Some("t1")
    );
    assert_eq!(
        note.pointer("/attributed/response")
            .and_then(Value::as_bool),
        Some(false)
    );
    let bytes = note.get("bytes").and_then(Value::as_f64).expect("a size");
    assert!(bytes > MAX_PAYLOAD_BYTES as f64);
}

#[test]
fn a_received_server_request_over_the_bound_is_never_left_out() {
    let mut frames = Frames::new(None);
    frames.attach_shared();
    let padding = "x".repeat(MAX_PAYLOAD_BYTES);
    let data = ace_json::parse(&format!(
        "{{\"id\":7,\"method\":\"item/tool/requestUserInput\",\"padding\":\"{padding}\"}}"
    ))
    .expect("fixture parses");
    let rejected = frames
        .emit(FrameDir::Recv, &data, "stdio", None)
        .expect_err("a server request is never omitted");
    assert!(rejected.fail_transport);
    assert_eq!(rejected.message, "Provider payload exceeds byte limit");
}

#[test]
fn a_received_frame_over_the_bound_on_a_private_host_fails_the_transport() {
    let frames = Frames::new(None);
    let padding = "x".repeat(MAX_PAYLOAD_BYTES);
    let data = ace_json::parse(&format!("{{\"padding\":\"{padding}\"}}")).expect("fixture parses");
    let rejected = frames
        .emit(FrameDir::Recv, &data, "stdio", None)
        .expect_err("a private host has nowhere to recover from");
    assert!(rejected.fail_transport);
}

#[test]
fn an_optional_catalog_frame_over_the_bound_is_recorded_and_left_out() {
    let mut frames = Frames::new(None);
    frames.attach_shared();
    let padding = "x".repeat(MAX_PAYLOAD_BYTES);
    let data = ace_json::parse(&format!(
        "{{\"id\":9,\"result\":{{\"padding\":\"{padding}\"}}}}"
    ))
    .expect("fixture parses");
    let emitted = frames
        .emit(FrameDir::Recv, &data, "stdio", Some("model/list"))
        .expect("an optional catalog frame is not fatal");
    assert!(!emitted.recover_output);
    assert_eq!(emitted.frames[0].dir, FrameDir::Note);
    assert!(
        emitted.frames[0]
            .text
            .contains("\"event\":\"optional-catalog-frame-omitted\",\"method\":\"model/list\"")
    );
}

#[test]
fn a_frame_over_the_structural_bound_is_refused_like_the_byte_bound() {
    let frames = Frames::new(None);
    let mut items = ace_json::Array::new();
    for index in 0..MAX_PAYLOAD_NODES {
        items.push(Value::from(index as f64));
    }
    let data = Value::Object(Map::from_iter([(
        JsString::from("result"),
        Value::Array(items),
    )]));
    let rejected = frames
        .emit(FrameDir::Recv, &data, "stdio", None)
        .expect_err("the structural bound refuses the frame");
    assert_eq!(
        rejected.message,
        "Provider payload exceeds structural limit"
    );
}

#[test]
fn a_history_reply_is_recorded_with_its_counts_and_no_turns() {
    let message = ace_json::parse(
            "{\"id\":3,\"result\":{\"thread\":{\"id\":\"t1\",\"turns\":[{\"id\":\"a\"},{\"id\":\"b\"}]},\"nextCursor\":\"c2\"}}",
        )
        .expect("fixture parses");
    assert_eq!(
        compact_history_reply(&message).to_json(),
        "{\"id\":3,\"result\":{\"thread\":{\"id\":\"t1\"},\"turns\":2}}"
    );
}

#[test]
fn a_failed_history_reply_is_recorded_whole() {
    let message =
        ace_json::parse("{\"id\":4,\"error\":{\"code\":-32601}}").expect("fixture parses");
    assert_eq!(compact_history_reply(&message), message);
}

#[test]
fn an_envelope_data_reply_is_recorded_as_a_turn_count() {
    let message = ace_json::parse(
        "{\"id\":5,\"result\":{\"data\":[{\"id\":\"a\"},{\"id\":\"b\"},{\"id\":\"c\"}]}}",
    )
    .expect("fixture parses");
    assert_eq!(
        compact_history_reply(&message).to_json(),
        "{\"id\":5,\"result\":{\"turns\":3,\"nextCursor\":null}}"
    );
}

#[test]
fn a_dropped_line_note_keeps_the_hosts_fields() {
    let attributed = LineAttribution {
        id: Some(RpcId::Number(42.0)),
        thread_id: Some(JsString::from("t1")),
        response: true,
    };
    assert_eq!(
        dropped_note(7, "complete", &attributed).to_json(),
        "{\"event\":\"output-line-dropped\",\"bytes\":7,\"phase\":\"complete\",\"attributed\":{\"response\":true,\"id\":42,\"threadId\":\"t1\"}}"
    );
}

#[test]
fn recv_is_the_only_direction_whose_rejection_fails_the_transport() {
    let frames = Frames::new(None);
    let padding = "x".repeat(MAX_PAYLOAD_BYTES);
    let data = ace_json::parse(&format!("{{\"padding\":\"{padding}\"}}")).expect("fixture parses");
    let rejected = frames
        .emit(FrameDir::Send, &data, "stdio", None)
        .expect_err("an execution frame over the bound is rejected");
    assert!(!rejected.fail_transport);
}
