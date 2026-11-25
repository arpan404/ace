// SPDX-License-Identifier: Apache-2.0
//! The admission's race orders (`steer-race.process.test.ts`), the queue and
//! start deliveries, and the answers `resolve` gives.

use super::*;
use crate::session::frames::FrameDir;
use crate::session::state::SessionConfig;
use ace_adapter_api::session::{Delivery, SteerFence, assert_steer_target};
use ace_json::Value;

/// The engine's fence, as the engine reads it.
struct Fence {
    turn: Option<String>,
    current: bool,
}

impl SteerFence for Fence {
    fn turn(&self) -> Option<&str> {
        self.turn.as_deref()
    }

    fn current(&self) -> bool {
        self.current
    }
}

fn session() -> Session {
    let mut session = Session::new(SessionConfig {
        scope: "scope-1".to_owned(),
        started: 0.0,
        cwd: "/repo".to_owned(),
        bearer: None,
        redact: Box::new(|line: &str| line.to_owned()),
        foreign: Box::new(|_| false),
    });
    session.attached("root-1", false, false);
    session
}

/// The session with a turn running, the way a `turn/started` frame leaves it.
fn running() -> Session {
    let mut session = session();
    session
        .active
        .insert("root-1".to_owned(), "turn-1".to_owned());
    session
}

fn json(text: &str) -> Value {
    ace_json::parse(text).expect("fixture parses")
}

fn parts(text: &str) -> Vec<Value> {
    vec![json(&format!(r#"{{"type":"text","text":{text:?}}}"#))]
}

fn message_id() -> String {
    "offline-message".to_owned()
}

fn send<'a>(
    operation: u64,
    parts: &'a [Value],
    delivery: Delivery,
    fence: Option<&'a dyn SteerFence>,
    user_message_id: &'a dyn Fn() -> String,
) -> Send<'a> {
    Send {
        operation,
        parts,
        delivery,
        command_id: None,
        origin: None,
        fence,
        user_message_id,
        answering: None,
    }
}

fn request(effect: &Effect) -> (u64, &str, Value) {
    match effect {
        Effect::Request {
            call,
            method,
            params,
            ..
        } => (*call, method.as_str(), params.clone()),
        other => panic!("expected a request, got {other:?}"),
    }
}

fn settled(effect: &Effect) -> Failure {
    match effect {
        Effect::Settle {
            result: Err(failure),
            ..
        } => failure.clone(),
        other => panic!("expected a failed settlement, got {other:?}"),
    }
}

fn notes(effects: &[Effect]) -> Vec<Value> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Frame {
                dir: FrameDir::Note,
                text,
                ..
            } => Some(ace_json::parse(text).expect("a note parses")),
            _ => None,
        })
        .collect()
}

#[test]
fn a_fenced_steer_the_engine_already_lost_writes_nothing() {
    let mut session = running();
    let text = parts("correction");
    let fence = Fence {
        turn: Some("turn-1".to_owned()),
        current: false,
    };
    // The facade's check runs in the same synchronous step as the send.
    assert!(assert_steer_target(Delivery::Steer, Some(&fence)).is_err());
    let effects = session.send(send(7, &text, Delivery::Steer, Some(&fence), &message_id));
    assert_eq!(effects.len(), 1);
    let failure = settled(&effects[0]);
    assert_eq!(
        failure.code,
        ace_adapter_api::bridge::queue::STEER_TARGET_LOST
    );
    assert!(session.commands.flights.is_empty());
}

#[test]
fn a_fenced_steer_whose_turn_ended_before_the_lock_is_refused_unread_and_never_retried() {
    let mut session = session();
    session
        .active
        .insert("root-1".to_owned(), "turn-1".to_owned());
    // The turn ends after the engine's check and before the session reads it.
    session.active.clear();
    let text = parts("correction");
    let fence = Fence {
        turn: Some("turn-1".to_owned()),
        current: true,
    };
    assert!(assert_steer_target(Delivery::Steer, Some(&fence)).is_ok());
    let effects = session.send(send(8, &text, Delivery::Steer, Some(&fence), &message_id));
    assert_eq!(effects.len(), 1);
    assert_eq!(settled(&effects[0]).message, STEER_TARGET_LOST);
    assert!(session.commands.flights.is_empty());
    assert_eq!(session.commands.starts.len(), 0);
}

#[test]
fn a_fenced_steer_whose_turn_is_running_is_pushed_at_that_turn_in_one_step() {
    let mut session = running();
    let text = parts("correction");
    let fence = Fence {
        turn: Some("turn-1".to_owned()),
        current: true,
    };
    let effects = session.send(send(9, &text, Delivery::Steer, Some(&fence), &message_id));
    assert!(
        effects
            .iter()
            .all(|effect| !matches!(effect, Effect::Settle { .. }))
    );
    let (call, method, params) = request(&effects[0]);
    assert_eq!(method, "turn/steer");
    assert_eq!(
        params.get("expectedTurnId").and_then(Value::as_str),
        Some("turn-1")
    );
    assert_eq!(
        params.get("clientUserMessageId").and_then(Value::as_str),
        Some("offline-message")
    );
    assert!(session.commands.flights.contains_key(&call));
}

#[test]
fn a_codex_refusal_for_a_gone_turn_reaches_the_turn_that_replaced_it_once() {
    let mut session = running();
    let text = parts("correction");
    let effects = session.send(send(10, &text, Delivery::Steer, None, &message_id));
    let (call, method, params) = request(&effects[0]);
    assert_eq!(method, "turn/steer");
    assert_eq!(
        params.get("expectedTurnId").and_then(Value::as_str),
        Some("turn-1")
    );
    // Codex replaced the turn before it read the steer.
    session
        .active
        .insert("root-1".to_owned(), "replacement".to_owned());
    let effects = session.settled(
        call,
        Err("expected active turn id turn-1 but found replacement"),
    );
    let (next, method, params) = request(&effects[0]);
    assert_eq!(method, "turn/steer");
    assert_eq!(
        params.get("expectedTurnId").and_then(Value::as_str),
        Some("replacement")
    );
    assert_ne!(next, call);
    // Its answer settles the send, with no second guess.
    let effects = session.settled(next, Ok(&json("{}")));
    assert!(matches!(effects[0], Effect::Settle { id: 10, .. }));
    assert!(session.commands.flights.is_empty());
}

#[test]
fn a_steer_codex_refuses_for_a_turn_the_session_still_has_is_reported_as_unread() {
    let mut session = running();
    let text = parts("correction");
    let effects = session.send(send(11, &text, Delivery::Steer, None, &message_id));
    let (call, ..) = request(&effects[0]);
    let effects = session.settled(call, Err("expected active turn id turn-1 but found unseen"));
    let failure = settled(&effects[0]);
    assert_eq!(failure.code, ace_adapter_api::bridge::queue::INPUT_REJECTED);
    assert!(session.commands.flights.is_empty());
    assert_eq!(session.commands.starts.len(), 0);
}

#[test]
fn a_steer_refused_when_no_turn_took_its_place_starts_one_with_the_same_input() {
    let mut session = running();
    let text = parts("correction");
    let effects = session.send(send(12, &text, Delivery::Steer, None, &message_id));
    let (call, ..) = request(&effects[0]);
    session.active.clear();
    let effects = session.settled(call, Err("no active turn to steer"));
    // The start's own await comes first: the launch-options port.
    let Effect::LaunchOptions { id, thread } = &effects[0] else {
        panic!("the start asks for its launch options");
    };
    assert_eq!((*id, thread.as_str()), (12, "root-1"));
    let effects = session.launch_ready(
        12,
        Ok(Launch {
            mode: None,
            options: ace_json::parse(r#"{"permissions":":workspace"}"#)
                .expect("fixture parses")
                .as_object()
                .cloned()
                .expect("an object"),
        }),
    );
    let note = notes(&effects);
    assert_eq!(
        note[0].get("event").and_then(Value::as_str),
        Some("permission-turn-submitting")
    );
    let (_, method, params) = request(&effects[1]);
    assert_eq!(method, "turn/start");
    assert_eq!(
        params.get("input"),
        Some(&json(
            r#"[{"type":"text","text":"correction","text_elements":[]}]"#
        ))
    );
    assert_eq!(
        params.get("permissions").and_then(Value::as_str),
        Some(":workspace")
    );
}

#[test]
fn an_unrelated_refusal_is_never_retried_as_a_new_turn() {
    let mut session = running();
    let text = parts("correction");
    let effects = session.send(send(13, &text, Delivery::Steer, None, &message_id));
    let (call, ..) = request(&effects[0]);
    let effects = session.settled(call, Err("provider refused input"));
    assert_eq!(settled(&effects[0]).message, "provider refused input");
    assert!(session.commands.starts.is_empty());
}

#[test]
fn a_queued_message_is_added_before_its_queue_is_refreshed_and_settles_after_both() {
    let mut session = running();
    let text = parts("queued");
    let effects = session.send(send(14, &text, Delivery::Queue, None, &message_id));
    let (call, method, params) = request(&effects[0]);
    assert_eq!(method, "thread/queue/add");
    assert_eq!(
        params.get("clientUserMessageId").and_then(Value::as_str),
        Some("offline-message")
    );
    let effects = session.settled(call, Ok(&json("{}")));
    let (read, method, params) = request(&effects[0]);
    assert_eq!(method, "thread/queue/list");
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("root-1")
    );
    assert!(
        effects
            .iter()
            .all(|effect| !matches!(effect, Effect::Settle { .. }))
    );
    // The queue's answer is the note, then the send's settlement.
    let effects = session.settled(read, Ok(&json(r#"{"data":[],"nextCursor":null}"#)));
    assert_eq!(
        notes(&effects)[0].get("event").and_then(Value::as_str),
        Some("queue-state")
    );
    assert!(matches!(effects[1], Effect::Settle { id: 14, .. }));
    assert_ne!(read, call);
}

#[test]
fn the_input_identity_is_queued_before_the_write_it_names() {
    let mut session = running();
    let text = parts("correction");
    let effects = session.send(Send {
        operation: 15,
        parts: &text,
        delivery: Delivery::Steer,
        command_id: Some("command-1"),
        origin: None,
        fence: None,
        user_message_id: &message_id,
        answering: None,
    });
    let Effect::Callback { name, json } = &effects[0] else {
        panic!("the identity is a callback, first");
    };
    assert_eq!(*name, "onInputMessage");
    assert_eq!(
        ace_json::parse(json).expect("a callback parses"),
        json_response()
    );
    assert_eq!(request(&effects[1]).1, "turn/steer");
}

fn json_response() -> Value {
    json(r#"[{"commandId":"command-1","nativeId":"offline-message"}]"#)
}

#[test]
fn a_second_id_is_taken_when_the_queue_needs_one_of_its_own() {
    let mut session = running();
    let issued = std::cell::Cell::new(0);
    let counted = || {
        issued.set(issued.get() + 1);
        format!("id-{}", issued.get())
    };
    let text = parts("queued");
    let effects = session.send(Send {
        operation: 16,
        parts: &text,
        delivery: Delivery::Queue,
        command_id: None,
        origin: Some(InputSource::Ace),
        fence: None,
        user_message_id: &counted,
        answering: None,
    });
    let (_, _, params) = request(&effects[0]);
    assert_eq!(
        params.get("clientUserMessageId").and_then(Value::as_str),
        Some("id-1")
    );
}

/// A part too large for one frame: the request that carries it is over the
/// bound before Codex is ever asked.
fn oversized() -> Vec<Value> {
    parts(&"x".repeat(crate::session::frames::MAX_PAYLOAD_BYTES))
}

/// The refusal the session's own veto gives the frame a command's request would
/// be: the real admission of the exact value the peer would send, so the message
/// under test is the one Codex's writer path gives, never a copy of it.
fn refused(session: &Session, effect: &Effect) -> String {
    let (_, method, params) = request(effect);
    let mut frame = Map::new();
    frame.insert("jsonrpc", Value::from("2.0"));
    frame.insert("id", Value::from(1.0));
    frame.insert("method", Value::from(method.to_owned()));
    frame.insert("params", params);
    match session.admit(ace_supervisor::peer::Direction::Send, &Value::Object(frame)) {
        crate::session::host::Admission::Failed(message) => message,
        other => panic!("the frame is over the bound: {other:?}"),
    }
}

#[test]
fn a_steer_over_the_frame_bound_is_a_plain_failure_never_steer_lost_and_never_retried() {
    let mut session = running();
    let text = oversized();
    let effects = session.send(send(40, &text, Delivery::Steer, None, &message_id));
    let (call, method, _) = request(&effects[0]);
    assert_eq!(method, "turn/steer");
    let message = refused(&session, &effects[0]);
    let effects = session.settled(call, Err(&message));
    let failure = settled(&effects[0]);
    assert_eq!(failure.message, message);
    assert_ne!(
        failure.code,
        ace_adapter_api::bridge::queue::STEER_TARGET_LOST
    );
    // Nothing retried it into another turn, and no turn was started in its place.
    assert!(session.commands.flights.is_empty());
    assert!(session.commands.starts.is_empty());
}

#[test]
fn a_queued_message_over_the_frame_bound_settles_without_a_queue_refresh() {
    let mut session = running();
    let text = oversized();
    let effects = session.send(send(41, &text, Delivery::Queue, None, &message_id));
    let (call, method, _) = request(&effects[0]);
    assert_eq!(method, "thread/queue/add");
    let message = refused(&session, &effects[0]);
    let effects = session.settled(call, Err(&message));
    // The refusal is the whole answer: no queue read follows it.
    assert_eq!(effects.len(), 1);
    assert_eq!(settled(&effects[0]).message, message);
    assert!(session.commands.flights.is_empty());
}

#[test]
fn a_turn_start_over_the_frame_bound_settles_after_its_launch_options() {
    let mut session = session();
    let text = oversized();
    let effects = session.send(send(42, &text, Delivery::Steer, None, &message_id));
    assert!(matches!(effects[0], Effect::LaunchOptions { id: 42, .. }));
    let effects = session.launch_ready(
        42,
        Ok(Launch {
            mode: None,
            options: Map::new(),
        }),
    );
    let (call, method, _) = request(&effects[1]);
    assert_eq!(method, "turn/start");
    let message = refused(&session, &effects[1]);
    let effects = session.settled(call, Err(&message));
    assert_eq!(effects.len(), 1);
    assert_eq!(settled(&effects[0]).message, message);
    assert!(session.commands.starts.is_empty());
}
