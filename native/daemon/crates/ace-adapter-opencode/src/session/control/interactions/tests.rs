// SPDX-License-Identifier: Apache-2.0
//! Answering a native interaction (`interactions.ts` `nativeResolution`): the
//! permission decisions, a question's answers per field, an elicitation's content,
//! and the fixed text every refusal exposes.

use super::{ControlError, REFUSAL, resolution};
use crate::session::tenant::PendingInteraction;
use ace_json::{Value, json};

fn permission(id: &str) -> PendingInteraction {
    PendingInteraction {
        session: String::from("ses_1"),
        kind: String::from("permission.asked"),
        data: json!({ "id": id, "sessionID": "ses_1", "action": "edit" }),
    }
}

fn form(id: &str) -> PendingInteraction {
    PendingInteraction {
        session: String::from("ses_1"),
        kind: String::from("form.created"),
        data: json!({
            "id": id,
            "sessionID": "ses_1",
            "fields": [
                { "key": "name", "type": "string" },
                { "key": "tags", "type": "multiselect" },
            ],
        }),
    }
}

#[test]
fn a_permission_answer_is_one_of_the_three_decisions() {
    for decision in ["once", "always", "reject"] {
        let call = resolution(
            &json!({ "kind": "approval", "optionId": decision }),
            &permission("per_1"),
        )
        .expect("a call");
        assert_eq!(call.target(), "/api/session/ses_1/permission/per_1/reply");
        assert_eq!(
            call.body,
            Some(json!({ "decision": decision })),
            "no message is no field"
        );
    }
    let call = resolution(
        &json!({ "kind": "approval", "optionId": "once", "message": "ok" }),
        &permission("per_1"),
    )
    .expect("a call");
    assert_eq!(
        call.body,
        Some(json!({ "decision": "once", "message": "ok" }))
    );
}

#[test]
fn a_permission_the_platform_cannot_answer_is_refused() {
    // The protocol's option is not one of OpenCode's decisions.
    assert_eq!(
        resolution(
            &json!({ "kind": "approval", "optionId": "allow" }),
            &permission("per_1")
        ),
        Err(ControlError::PermissionChoice)
    );
    // A permission is not answered as a question.
    assert_eq!(
        resolution(
            &json!({ "kind": "question", "answers": {} }),
            &permission("per_1")
        ),
        Err(ControlError::PermissionChoice)
    );
    // A plan review has no OpenCode route at all.
    assert_eq!(
        resolution(
            &json!({ "kind": "plan_review", "decision": "accept" }),
            &form("frm_1")
        ),
        Err(ControlError::PlanReview)
    );
    assert_eq!(ControlError::PermissionChoice.refusal(), REFUSAL);
}

#[test]
fn a_question_answers_only_the_fields_it_asks() {
    let call = resolution(
        &json!({
            "kind": "question",
            "answers": {
                "name": ["ada"],
                "tags": ["a", "b"],
                "not-a-field": ["x"],
            },
        }),
        &form("frm_1"),
    )
    .expect("a call");
    assert_eq!(call.target(), "/api/session/ses_1/form/frm_1/reply");
    // A single-select keeps its first value, a multiselect keeps the list, and a
    // key the form does not ask for is dropped.
    assert_eq!(
        call.body,
        Some(json!({ "answer": { "name": "ada", "tags": ["a", "b"] } }))
    );
    // An unanswered single-select is the empty string, an unanswered multiselect
    // the empty list.
    let call = resolution(
        &json!({ "kind": "question", "answers": { "tags": ["a"] } }),
        &form("frm_1"),
    )
    .expect("a call");
    assert_eq!(
        call.body,
        Some(json!({ "answer": { "name": "", "tags": ["a"] } }))
    );
}

#[test]
fn a_dismissed_question_cancels_the_form_with_its_feedback() {
    let call = resolution(
        &json!({ "kind": "question", "answers": { "name": ["ada"] }, "dismissed": true, "feedback": "later" }),
        &form("frm_1"),
    )
    .expect("a call");
    assert_eq!(call.target(), "/api/session/ses_1/form/frm_1?message=later");
    assert_eq!(call.body, None, "the feedback is the query, not a body");

    let call = resolution(
        &json!({ "kind": "question", "answers": {}, "dismissed": true }),
        &form("frm_1"),
    )
    .expect("a call");
    assert_eq!(call.target(), "/api/session/ses_1/form/frm_1");
    // `dismissed: false` answers, it does not cancel.
    let call = resolution(
        &json!({ "kind": "question", "answers": {}, "dismissed": false }),
        &form("frm_1"),
    )
    .expect("a call");
    assert_eq!(call.target(), "/api/session/ses_1/form/frm_1/reply");
}

#[test]
fn an_elicitation_sends_its_content_and_cancels_on_anything_but_accept() {
    let call = resolution(
        &json!({ "kind": "elicitation", "action": "accept", "content": { "name": "ada" } }),
        &form("frm_1"),
    )
    .expect("a call");
    assert_eq!(call.body, Some(json!({ "answer": { "name": "ada" } })));
    let call = resolution(
        &json!({ "kind": "elicitation", "action": "decline", "content": { "feedback": "no" } }),
        &form("frm_1"),
    )
    .expect("a call");
    assert_eq!(call.target(), "/api/session/ses_1/form/frm_1?message=no");
    assert_eq!(call.body, None);
    // No content is an empty answer, not a body-less request.
    let call = resolution(
        &json!({ "kind": "elicitation", "action": "accept" }),
        &form("frm_1"),
    )
    .expect("a call");
    assert_eq!(call.body, Some(json!({ "answer": {} })));
}

#[test]
fn an_answer_a_form_cannot_hold_is_refused() {
    for value in [json!({ "text": "a" }), json!(null), json!([{}])] {
        let choice: Value = json!({ "kind": "question", "answers": { "name": value } });
        assert_eq!(
            resolution(&choice, &form("frm_1")),
            Err(ControlError::Answer),
            "{value} is not a form answer"
        );
    }
    // A number is a form answer.
    let choice: Value = json!({ "kind": "elicitation", "action": "accept", "content": { "n": 2 } });
    assert!(resolution(&choice, &form("frm_1")).is_ok());
}
