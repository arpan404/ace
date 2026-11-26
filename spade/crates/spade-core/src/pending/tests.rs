use serde_json::{Value, json};

use super::*;

fn events(values: Vec<Value>) -> Vec<Event> {
    values.into_iter().map(Event::from_json).collect()
}

fn approval(call_id: &str, name: &str, arguments: Value) -> Value {
    json!({
        "type": "approval_requested", "reply": "r1", "call_id": call_id,
        "name": name, "arguments": arguments,
    })
}

fn question(call_id: &str, prompt: &str) -> Value {
    json!({
        "type": "question_asked", "reply": "r1", "call_id": call_id,
        "question": prompt,
        "questions": [{ "prompt": prompt, "kind": "text" }],
    })
}

#[test]
fn only_the_approvals_the_reply_still_waits_on_are_listed_in_the_order_asked() {
    let stored = events(vec![
        approval("c1", "pay", json!({ "amount": "412 EUR" })),
        approval("c2", "send_email", json!({ "to": "marta@example.com" })),
        approval("c3", "web_fetch", json!({})),
    ]);
    let open = open(&stored, &["c2".into(), "c1".into()], false);
    assert_eq!(open.len(), 2);
    assert_eq!(open[0]["kind"], "approval");
    assert_eq!(open[0]["name"], "pay");
    assert_eq!(open[0]["arguments"], json!({ "amount": "412 EUR" }));
    assert_eq!(open[1]["name"], "send_email");
}

#[test]
fn an_approval_with_huge_arguments_is_listed_without_them() {
    let big = "x".repeat(ARGUMENTS_BYTES + 1);
    let stored = events(vec![approval("c1", "pay", json!({ "note": big }))]);
    let open = open(&stored, &["c1".into()], false);
    assert_eq!(open[0]["name"], "pay");
    assert!(open[0].get("arguments").is_none());
}

#[test]
fn a_reviewers_reason_is_sent_with_its_approval() {
    let mut asked = approval("c1", "shell", json!({ "command": "rm -r build" }));
    asked["reviewer_reason"] = json!("Deletes files outside the bot's folder");
    let open = open(&events(vec![asked]), &["c1".into()], false);
    assert_eq!(
        open[0]["reviewer_reason"],
        "Deletes files outside the bot's folder"
    );
}

#[test]
fn an_unanswered_question_is_listed_with_its_prompt_and_an_answered_one_is_not() {
    let stored = events(vec![
        question("q1", "Which hotel?"),
        json!({
            "type": "question_answered", "call_id": "q1", "answers": [{ "answer": "Bairro Alto" }],
        }),
        question("q2", "Window or aisle?"),
    ]);
    let open = open(&stored, &[], true);
    assert_eq!(
        open,
        vec![json!({ "kind": "question", "prompt": "Window or aisle?" })]
    );
}

#[test]
fn nothing_waits_when_neither_an_approval_nor_a_question_is_open() {
    let stored = events(vec![
        approval("c1", "pay", json!({})),
        question("q1", "Which?"),
    ]);
    assert!(open(&stored, &[], false).is_empty());
}

#[test]
fn no_more_than_the_most_are_sent() {
    let many = (0..MOST + 4)
        .map(|n| approval(&format!("c{n}"), "pay", json!({})))
        .collect::<Vec<_>>();
    let ids = (0..MOST + 4).map(|n| format!("c{n}")).collect::<Vec<_>>();
    assert_eq!(open(&events(many), &ids, false).len(), MOST);
}
