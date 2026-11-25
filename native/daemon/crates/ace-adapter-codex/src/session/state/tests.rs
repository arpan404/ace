// SPDX-License-Identifier: Apache-2.0
//! The frame handler's statement order (`session.ts:185`-`:353`), the
//! notification and server-request callbacks, and the correlation deadline.

use ace_json::Value;
use ace_supervisor::peer::Direction;

use super::*;
use crate::session::frames::FrameDir;
use crate::session::host::RequestAnswer;

fn session() -> Session {
    let mut session = Session::new(SessionConfig {
        scope: "scope-1".to_owned(),
        started: 0.0,
        bearer: None,
        redact: Box::new(|line: &str| line.to_owned()),
        foreign: Box::new(|_| false),
    });
    session.attached("root-1", false, false);
    session
}

fn json(text: &str) -> Value {
    ace_json::parse(text).expect("fixture parses")
}

fn frame_text(effect: &Effect) -> Option<&str> {
    match effect {
        Effect::Frame { text, .. } => Some(text),
        _ => None,
    }
}

fn note(effect: &Effect) -> Option<Value> {
    let Effect::Frame { dir, text, .. } = effect else {
        return None;
    };
    (*dir == FrameDir::Note).then(|| ace_json::parse(text).expect("a note parses"))
}

#[test]
fn a_turn_start_records_its_control_request_before_the_reply_sets_the_turn() {
    let mut session = session();
    let effects = session.frame(
        Direction::Send,
        &json("{\"id\":7,\"method\":\"turn/start\",\"params\":{\"threadId\":\"root-1\"}}"),
        None,
        0.0,
    );
    assert_eq!(
        frame_text(&effects[0]),
        Some("{\"id\":7,\"method\":\"turn/start\",\"params\":{\"threadId\":\"root-1\"}}")
    );
    assert_eq!(session.control_requests.len(), 1);
    assert_eq!(session.active.len(), 0);
    // The reply's note comes before the frame: the TypeScript emits it while it
    // reads the control request, then `emit`s the frame.
    let effects = session.frame(
        Direction::Recv,
        &json("{\"id\":7,\"result\":{\"turn\":{\"id\":\"turn-1\"}}}"),
        None,
        0.0,
    );
    let permission = note(&effects[0]).expect("the applied mode is a note");
    assert_eq!(
        permission.get("event").and_then(Value::as_str),
        Some("permission-mode-applied")
    );
    assert_eq!(
        frame_text(&effects[1]),
        Some("{\"id\":7,\"result\":{\"turn\":{\"id\":\"turn-1\"}}}")
    );
    assert_eq!(
        session.active.get("root-1").map(String::as_str),
        Some("turn-1")
    );
    assert!(session.control_requests.is_empty());
}

#[test]
fn a_turn_start_reply_for_a_turn_that_already_completed_does_not_mark_it_running() {
    let mut session = session();
    session.frame(
        Direction::Send,
        &json("{\"id\":7,\"method\":\"turn/start\",\"params\":{\"threadId\":\"root-1\"}}"),
        None,
        0.0,
    );
    session.frame(
        Direction::Recv,
        &json("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"root-1\",\"turn\":{\"id\":\"turn-1\"}}}"),
        None,
        0.0,
    );
    session.frame(
        Direction::Recv,
        &json("{\"id\":7,\"result\":{\"turn\":{\"id\":\"turn-1\"}}}"),
        None,
        0.0,
    );
    assert!(session.active.is_empty());
}

#[test]
fn a_received_frame_for_an_unknown_thread_schedules_its_recovery_after_the_frame() {
    let mut session = session();
    let effects = session.frame(
        Direction::Recv,
        &json("{\"method\":\"turn/started\",\"params\":{\"threadId\":\"child-1\",\"turn\":{\"id\":\"t2\"}}}"),
        None,
        0.0,
    );
    assert_eq!(
        frame_text(&effects[0]),
        Some(
            "{\"method\":\"turn/started\",\"params\":{\"threadId\":\"child-1\",\"turn\":{\"id\":\"t2\"}}}"
        )
    );
    assert_eq!(
        effects[1],
        Effect::ArmTimer {
            key: "child-1".to_owned(),
            ms: 2_000.0
        }
    );
    assert_eq!(
        session.active.get("child-1").map(String::as_str),
        Some("t2")
    );
}

#[test]
fn a_history_reply_is_recorded_with_its_counts_on_the_history_channel() {
    let mut session = session();
    session.frame(
        Direction::Send,
        &json("{\"id\":3,\"method\":\"thread/turns/list\",\"params\":{\"threadId\":\"root-1\"}}"),
        None,
        0.0,
    );
    let effects = session.frame(
        Direction::Recv,
        &json("{\"id\":3,\"result\":{\"thread\":{\"id\":\"root-1\",\"turns\":[{\"id\":\"a\"}]}}}"),
        None,
        0.0,
    );
    let Effect::Frame { channel, text, .. } = &effects[0] else {
        panic!("the frame is published");
    };
    assert_eq!(*channel, "codex-history");
    assert_eq!(
        text,
        "{\"id\":3,\"result\":{\"thread\":{\"id\":\"root-1\"},\"turns\":1}}"
    );
    assert!(session.history_replies.is_empty());
}

#[test]
fn a_completed_turn_rejects_the_interactions_it_left_open() {
    let mut session = session();
    let answer = session.request(
        &RpcId::Number(11.0),
        "item/tool/requestUserInput",
        Some(&json("{\"threadId\":\"root-1\",\"turnId\":\"turn-1\"}")),
    );
    assert_eq!(answer, RequestAnswer::Deferred);
    assert_eq!(session.pending.len(), 1);
    let effects = session.frame(
        Direction::Recv,
        &json("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"root-1\",\"turn\":{\"id\":\"turn-1\"}}}"),
        None,
        0.0,
    );
    assert!(session.pending.is_empty());
    assert_eq!(
        effects.last(),
        Some(&Effect::AnswerError {
            id: RpcId::Number(11.0),
            message: "Turn ended before interaction was answered".to_owned()
        })
    );
}

#[test]
fn a_request_resolved_elsewhere_fails_its_interaction_once() {
    let mut session = session();
    session.request(
        &RpcId::Number(11.0),
        "item/tool/requestUserInput",
        Some(&json("{\"threadId\":\"root-1\"}")),
    );
    let effects = session.frame(
        Direction::Recv,
        &json("{\"method\":\"serverRequest/resolved\",\"params\":{\"requestId\":11}}"),
        None,
        0.0,
    );
    assert_eq!(
        effects.last(),
        Some(&Effect::AnswerError {
            id: RpcId::Number(11.0),
            message: "Interaction resolved on another connection".to_owned()
        })
    );
    let again = session.frame(
        Direction::Recv,
        &json("{\"method\":\"serverRequest/resolved\",\"params\":{\"requestId\":11}}"),
        None,
        0.0,
    );
    assert!(
        !again
            .iter()
            .any(|effect| matches!(effect, Effect::AnswerError { .. }))
    );
}

#[test]
fn a_turn_that_never_correlates_retires_the_transport_at_its_deadline() {
    let mut session = session();
    session.frame(
        Direction::Send,
        &json("{\"id\":9,\"method\":\"turn/start\",\"params\":{\"threadId\":\"root-1\"}}"),
        None,
        1_000.0,
    );
    let effects = session.frame(
        Direction::Recv,
        &json("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"root-1\",\"turn\":{\"id\":\"turn-1\"}}}"),
        None,
        1_000.0,
    );
    assert!(effects.contains(&Effect::ArmTimer {
        key: "correlation:9".to_owned(),
        ms: 30_000.0
    }));
    // Before the deadline the timer re-arms with what is left.
    let effects = session.timer("correlation:9", 20_000.0);
    assert_eq!(
        effects,
        vec![Effect::ArmTimer {
            key: "correlation:9".to_owned(),
            ms: 11_000.0
        }]
    );
    let effects = session.timer("correlation:9", 31_000.0);
    let timeout = note(&effects[0]).expect("the timeout is a note");
    assert_eq!(
        timeout.get("event").and_then(Value::as_str),
        Some("turn-correlation-timeout")
    );
    assert_eq!(
        timeout.get("threadId").and_then(Value::as_str),
        Some("root-1")
    );
    // The session's own transport stops after the note.
    assert!(effects.contains(&Effect::Cleanup));
    assert!(effects.iter().any(|effect| matches!(
        effect,
        Effect::Detach {
            reason: super::super::host::Retirement::RpcFailed,
            ..
        } | Effect::Retire {
            reason: super::super::host::Retirement::RpcFailed,
        }
    )));
    // A reply clears the deadline, so a later timer does nothing.
    session = self::session();
    session.frame(
        Direction::Send,
        &json("{\"id\":9,\"method\":\"turn/start\",\"params\":{\"threadId\":\"root-1\"}}"),
        None,
        1_000.0,
    );
    session.frame(
        Direction::Recv,
        &json("{\"id\":9,\"result\":{\"turn\":{\"id\":\"turn-1\"}}}"),
        None,
        1_000.0,
    );
    assert!(session.timer("correlation:9", 31_000.0).is_empty());
}

#[test]
fn a_command_item_belongs_to_its_thread_while_it_runs() {
    let mut session = session();
    session.frame(
        Direction::Recv,
        &json("{\"method\":\"item/started\",\"params\":{\"threadId\":\"root-1\",\"item\":{\"id\":\"cmd-1\",\"type\":\"commandExecution\"}}}"),
        None,
        0.0,
    );
    assert_eq!(
        session.shells.get("cmd-1").map(String::as_str),
        Some("root-1")
    );
    session.frame(
        Direction::Recv,
        &json("{\"method\":\"item/commandExecution/outputDelta\",\"params\":{\"threadId\":\"root-1\",\"itemId\":\"cmd-2\"}}"),
        None,
        0.0,
    );
    assert_eq!(
        session.shells.get("cmd-2").map(String::as_str),
        Some("root-1")
    );
    session.frame(
        Direction::Recv,
        &json("{\"method\":\"item/completed\",\"params\":{\"threadId\":\"root-1\",\"item\":{\"id\":\"cmd-1\",\"type\":\"commandExecution\"}}}"),
        None,
        0.0,
    );
    assert!(!session.shells.contains_key("cmd-1"));
    assert!(session.completed_shells.contains("cmd-1"));
}

#[test]
fn an_async_question_is_known_once_and_kept_for_the_interaction_layer() {
    let mut session = session();
    let item = "{\"method\":\"item/completed\",\"params\":{\"threadId\":\"root-1\",\"item\":{\"id\":\"ask-1\",\"type\":\"agentMessage\",\"delivery\":\"async\",\"questions\":[{\"id\":\"q1\"}]}}}";
    session.frame(Direction::Recv, &json(item), None, 0.0);
    assert_eq!(session.async_questions.len(), 1);
    assert!(session.seen_questions.contains("ask-1"));
    session.frame(Direction::Recv, &json(item), None, 0.0);
    assert_eq!(session.async_questions.len(), 1);
}

#[test]
fn a_spawned_child_is_discovered_and_recovered_before_it_acts() {
    let mut session = session();
    let effects = session.frame(
        Direction::Recv,
        &json("{\"method\":\"item/started\",\"params\":{\"threadId\":\"root-1\",\"item\":{\"id\":\"call-1\",\"type\":\"collabAgentToolCall\",\"tool\":\"spawnAgent\",\"receiverThreadIds\":[\"child-1\"]}}}"),
        None,
        0.0,
    );
    assert!(session.known.contains("child-1"));
    assert_eq!(
        session.parents.get("child-1").map(String::as_str),
        Some("root-1")
    );
    assert!(effects.contains(&Effect::ArmTimer {
        key: "child-1".to_owned(),
        ms: 2_000.0
    }));
}

#[test]
fn an_answer_for_a_command_is_not_answered_by_its_turn_ending() {
    let mut session = session();
    let answer = session.request(
        &RpcId::Number(4.0),
        "item/commandExecution/requestApproval",
        Some(&json("{\"threadId\":\"other\",\"turnId\":\"turn-9\"}")),
    );
    assert_eq!(answer, RequestAnswer::Deferred);
    let effects = session.frame(
        Direction::Recv,
        &json("{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"root-1\",\"turn\":{\"id\":\"turn-1\"}}}"),
        None,
        0.0,
    );
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, Effect::AnswerError { .. }))
    );
    assert_eq!(session.pending.len(), 1);
}

#[test]
fn a_notification_refreshes_the_queue_and_the_discovery_scan() {
    let mut session = session();
    let effects = session.notification(
        "thread/queue/changed",
        Some(&json("{\"threadId\":\"root-1\"}")),
    );
    let Effect::Request { method, .. } = &effects[0] else {
        panic!("the refresh asks for the queue");
    };
    assert_eq!(method, "thread/queue/list");
    let effects = session.notification(
        "turn/completed",
        Some(&json(
            "{\"threadId\":\"root-1\",\"turn\":{\"id\":\"turn-1\"}}",
        )),
    );
    let Effect::Request { method, .. } = &effects[0] else {
        panic!("the reconcile lists the loaded threads");
    };
    assert_eq!(method, "thread/loaded/list");
}

#[test]
fn an_unsupported_server_request_is_method_not_found() {
    let mut session = session();
    assert_eq!(
        session.request(&RpcId::Number(1.0), "account/login/start", None),
        RequestAnswer::MethodNotFound("Unsupported Codex request: account/login/start".to_owned())
    );
    assert!(session.pending.is_empty());
}

#[test]
fn an_oversized_server_request_is_refused_before_the_host_dispatches_it() {
    let session = session();
    let padding = "x".repeat(super::super::frames::MAX_PAYLOAD_BYTES);
    let request = json(&format!(
        "{{\"id\":7,\"method\":\"item/tool/requestUserInput\",\"params\":{{\"padding\":\"{padding}\"}}}}"
    ));
    assert_eq!(
        session.admit(Direction::Recv, &request),
        super::super::host::Admission::Failed("Provider payload exceeds byte limit".to_owned())
    );
    // A notification the bound refuses is admitted: the handler decides, as the
    // TypeScript's `emit` does.
    let notification = json(&format!(
        "{{\"method\":\"item/agentMessage/delta\",\"params\":{{\"padding\":\"{padding}\"}}}}"
    ));
    assert_eq!(
        session.admit(Direction::Recv, &notification),
        super::super::host::Admission::Taken
    );
    // An outgoing frame is the writer's; admission never refuses it.
    assert_eq!(
        session.admit(Direction::Send, &request),
        super::super::host::Admission::Taken
    );
}

#[test]
fn an_outgoing_frame_over_the_bound_is_left_out_without_retiring_the_session() {
    let mut session = session();
    let padding = "x".repeat(super::super::frames::MAX_PAYLOAD_BYTES);
    let data = json(&format!(
        "{{\"id\":8,\"method\":\"turn/steer\",\"params\":{{\"padding\":\"{padding}\"}}}}"
    ));
    let effects = session.frame(Direction::Send, &data, None, 0.0);
    assert!(effects.is_empty());
    assert!(!session.is_closed());
}

#[test]
fn a_frame_over_the_bound_retires_the_channel_instead_of_publishing_it() {
    let mut session = session();
    let padding = "x".repeat(super::super::frames::MAX_PAYLOAD_BYTES);
    let data = json(&format!(
        "{{\"method\":\"item/agentMessage/delta\",\"params\":{{\"padding\":\"{padding}\"}}}}"
    ));
    let effects = session.frame(Direction::Recv, &data, None, 0.0);
    assert!(
        !effects
            .iter()
            .any(|effect| matches!(effect, Effect::Frame { .. }))
    );
    assert!(effects.contains(&Effect::Cleanup));
    assert!(effects.iter().any(|effect| matches!(
        effect,
        Effect::Detach {
            reason: super::super::host::Retirement::RpcFailed,
            ..
        } | Effect::Retire {
            reason: super::super::host::Retirement::RpcFailed,
        }
    )));
}
