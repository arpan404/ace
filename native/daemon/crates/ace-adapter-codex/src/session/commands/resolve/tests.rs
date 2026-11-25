// SPDX-License-Identifier: Apache-2.0
//! `resolve` (`session-commands.ts:251`-`:356`): the approval answer, the
//! question's text, the plan review, and the notes each one leaves.

use ace_json::Value;
use ace_supervisor::jsonrpc::RpcId;

use super::*;
use crate::session::commands::Launch;
use crate::session::frames::{Effect, FrameDir};
use crate::session::state::{Pending, Plan, SessionConfig};

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

fn json(text: &str) -> Value {
    ace_json::parse(text).expect("fixture parses")
}

fn message_id() -> String {
    "offline-message".to_owned()
}

fn answer<'a>(operation: u64, key: &'a str, resolution: &'a Value) -> Answer<'a> {
    Answer {
        operation,
        key: key.to_owned(),
        resolution,
        user_message_id: &message_id,
        interaction_id: None,
        model: "gpt-5",
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
fn a_pending_approval_is_answered_with_the_decision_codex_offered() {
    let mut session = session();
    session.pending.insert(
        "request:1".to_owned(),
        Pending {
            id: RpcId::Number(1.0),
            method: ace_json::JsString::from("item/commandExecution/requestApproval"),
            params: Some(json(r#"{"availableDecisions":["accept","decline"]}"#)),
        },
    );
    let resolution = json(r#"{"kind":"approval","optionId":"decline"}"#);
    let effects = session.resolve(answer(20, "request:1", &resolution));
    assert_eq!(
        effects[0],
        Effect::Answer {
            id: RpcId::Number(1.0),
            result: json(r#"{"decision":"decline"}"#),
        }
    );
    assert!(matches!(effects[1], Effect::Settle { id: 20, .. }));
    assert!(session.pending.is_empty());
}

#[test]
fn an_interaction_the_session_no_longer_holds_says_so() {
    let mut session = session();
    let resolution = json(r#"{"kind":"approval","optionId":"accept"}"#);
    let effects = session.resolve(answer(21, "request:gone", &resolution));
    assert_eq!(
        settled(&effects[0]),
        "This question or approval is no longer active"
    );
}

fn settled(effect: &Effect) -> &str {
    match effect {
        Effect::Settle {
            result: Err(failure),
            ..
        } => &failure.message,
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[test]
fn a_question_is_delivered_as_the_labels_the_person_chose_and_then_resolves() {
    let mut session = session();
    session.async_questions.insert(
        "async:q1".to_owned(),
        crate::session::state::AsyncQuestion {
            thread: "root-1".to_owned(),
            questions: json(
                r#"[{"id":"q1","options":[{"id":"a","label":"First"},{"id":"b","label":"Second"}]}]"#,
            ),
        },
    );
    session
        .active
        .insert("root-1".to_owned(), "turn-1".to_owned());
    let resolution = json(r#"{"kind":"question","answers":{"q1":["a","b"]}}"#);
    let effects = session.resolve(answer(22, "async:q1", &resolution));
    let written = notes(&effects);
    assert_eq!(
        written[0].get("event").and_then(Value::as_str),
        Some("interaction-answer")
    );
    assert_eq!(
        written[0].get("text").and_then(Value::as_str),
        Some("First, Second")
    );
    let Effect::Request {
        call,
        method,
        params,
        ..
    } = &effects[1]
    else {
        panic!("the answer is a steer");
    };
    assert_eq!(method, "turn/steer");
    assert_eq!(
        params.get("input"),
        Some(&json(
            r#"[{"type":"text","text":"First, Second","text_elements":[]}]"#
        ))
    );
    let call = *call;
    let effects = session.settled(call, Ok(&json("{}")));
    let written = notes(&effects);
    assert_eq!(
        written[0].get("event").and_then(Value::as_str),
        Some("interaction-resolved")
    );
    assert!(matches!(effects[1], Effect::Settle { id: 22, .. }));
}

#[test]
fn a_dismissed_question_says_it_continues_without_answers_and_keeps_the_note() {
    let mut session = session();
    session.async_questions.insert(
        "async:q2".to_owned(),
        crate::session::state::AsyncQuestion {
            thread: "root-1".to_owned(),
            questions: json(r#"[{"id":"q1","options":[]}]"#),
        },
    );
    let resolution =
        json(r#"{"kind":"question","dismissed":true,"answers":{},"feedback":"  later  "}"#);
    let effects = session.resolve(answer(23, "async:q2", &resolution));
    assert_eq!(
        notes(&effects)[0].get("text").and_then(Value::as_str),
        Some("Continue without answers. later")
    );
    // No turn is running, so the answer starts one and asks for launch options.
    assert!(matches!(effects[1], Effect::LaunchOptions { id: 23, .. }));
}

#[test]
fn a_question_the_failed_steer_could_not_deliver_says_the_answer_failed() {
    let mut session = session();
    session.async_questions.insert(
        "async:q3".to_owned(),
        crate::session::state::AsyncQuestion {
            thread: "root-1".to_owned(),
            questions: json(r#"[{"id":"q1","options":[]}]"#),
        },
    );
    session
        .active
        .insert("root-1".to_owned(), "turn-1".to_owned());
    let resolution = json(r#"{"kind":"question","answers":{"q1":["x"]}}"#);
    let effects = session.resolve(answer(24, "async:q3", &resolution));
    let Effect::Request { call, .. } = &effects[1] else {
        panic!("the answer is a steer");
    };
    let call = *call;
    let effects = session.settled(call, Err("provider refused input"));
    assert_eq!(
        notes(&effects)[0].get("event").and_then(Value::as_str),
        Some("interaction-answer-failed")
    );
    assert_eq!(settled(&effects[1]), "provider refused input");
}

#[test]
fn an_approved_plan_starts_the_turn_that_implements_it() {
    let mut session = session();
    session.plans.insert(
        "plan:t1".to_owned(),
        Plan {
            thread: "root-1".to_owned(),
            markdown: "# Plan".to_owned(),
        },
    );
    let resolution = json(r#"{"kind":"plan_review","decision":"approve"}"#);
    let effects = session.resolve(answer(25, "plan:t1", &resolution));
    let written = notes(&effects);
    assert_eq!(
        written[0].get("event").and_then(Value::as_str),
        Some("interaction-answer")
    );
    assert_eq!(
        written[0].get("text").and_then(Value::as_str),
        Some("Implement the plan.")
    );
    assert!(matches!(effects[1], Effect::LaunchOptions { id: 25, .. }));
    let effects = session.launch_ready(
        25,
        Ok(Launch {
            mode: Some(":workspace".to_owned()),
            options: Map::new(),
        }),
    );
    let Effect::Request {
        call,
        method,
        params,
        ..
    } = effects
        .iter()
        .find(|effect| matches!(effect, Effect::Request { .. }))
        .expect("the turn is a request")
    else {
        unreachable!("matched a request");
    };
    assert_eq!(method, "turn/start");
    assert_eq!(
        params.get("collaborationMode"),
        Some(&json(
            r#"{"mode":"default","settings":{"model":"gpt-5","reasoning_effort":null,"developer_instructions":null}}"#,
        ))
    );
    let call = *call;
    let effects = session.settled(call, Ok(&json("{}")));
    assert_eq!(
        notes(&effects)[0].get("event").and_then(Value::as_str),
        Some("interaction-resolved")
    );
    assert!(matches!(effects[1], Effect::Settle { id: 25, .. }));
}

#[test]
fn a_cancelled_plan_review_is_resolved_without_starting_a_turn() {
    let mut session = session();
    session.plans.insert(
        "plan:t2".to_owned(),
        Plan {
            thread: "root-1".to_owned(),
            markdown: "# Plan".to_owned(),
        },
    );
    let resolution = json(r#"{"kind":"plan_review","decision":"cancel"}"#);
    let effects = session.resolve(answer(26, "plan:t2", &resolution));
    assert_eq!(
        notes(&effects)[0].get("event").and_then(Value::as_str),
        Some("interaction-resolved")
    );
    assert!(matches!(effects[1], Effect::Settle { id: 26, .. }));
    assert!(session.plans.is_empty());
}

#[test]
fn a_plan_approval_whose_launch_options_are_refused_marks_the_interaction_failed() {
    let mut session = session();
    session.plans.insert(
        "plan:t3".to_owned(),
        Plan {
            thread: "root-1".to_owned(),
            markdown: "# Plan".to_owned(),
        },
    );
    let resolution = json(r#"{"kind":"plan_review","decision":"approve"}"#);
    let effects = session.resolve(answer(27, "plan:t3", &resolution));
    assert!(matches!(effects[1], Effect::LaunchOptions { id: 27, .. }));
    // Codex reports no default, so the launch-options port refuses the turn.
    let effects = session.launch_ready(
        27,
        Err(crate::session::permissions::CONFIGURED_DEFAULT_MISSING.to_owned()),
    );
    let written = notes(&effects);
    assert_eq!(
        written[0].get("event").and_then(Value::as_str),
        Some("interaction-answer-failed")
    );
    assert_eq!(
        written[0].get("threadId").and_then(Value::as_str),
        Some("root-1")
    );
    assert_eq!(
        written[0].get("interaction").and_then(Value::as_str),
        Some("plan:t3")
    );
    assert_eq!(
        settled(&effects[1]),
        crate::session::permissions::CONFIGURED_DEFAULT_MISSING
    );
}
