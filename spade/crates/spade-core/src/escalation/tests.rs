use serde_json::{Value, json};

use super::*;
use crate::event::Event;

fn known(raw: Value) -> Known {
    match Event::from_json(raw.clone()) {
        Event::Known(known) => known,
        Event::Unknown(_) => panic!("not a known event: {raw}"),
    }
}

fn report(state: &str) -> Value {
    json!({ "type": "worker_reported", "worker": "a2", "kind": "bot", "name": "Scout",
            "state": state, "epoch": "r1", "summary": "" })
}

#[test]
fn each_wait_that_reaches_the_person_has_the_level_of_what_it_holds() {
    let cases = [
        (
            json!({ "type": "decision_made", "decision": "d1", "call_id": "c1",
                 "choice": "SQLite", "reason": "one file" }),
            Some(Level::Inform),
        ),
        (
            json!({ "type": "goal_set", "goal": "g1", "title": "Ship", "text": "Ship it",
                 "criteria": [], "by": "bot" }),
            Some(Level::Inform),
        ),
        (
            json!({ "type": "goal_set", "goal": "g1", "title": "Ship", "text": "Ship it",
                 "criteria": [], "by": "person" }),
            None,
        ),
        (
            json!({ "type": "task_verified", "goal": "g1", "claim": "c9", "verdict": "not_yet" }),
            Some(Level::Inform),
        ),
        (report("done"), Some(Level::Inform)),
        (report("finished"), Some(Level::Inform)),
        (report("needs_you"), None),
        (report("parked"), None),
        (report("failed"), None),
        (report("stopped"), None),
        (
            json!({ "type": "question_asked", "reply": "r1", "call_id": "q1",
                 "question": "Which?", "later": true }),
            Some(Level::Ask),
        ),
        (
            json!({ "type": "question_asked", "reply": "r1", "call_id": "q1",
                 "question": "Which?" }),
            Some(Level::Block),
        ),
        (
            json!({ "type": "approval_requested", "reply": "r1", "call_id": "c1",
                 "name": "shell", "arguments": {} }),
            Some(Level::Block),
        ),
        (
            json!({ "type": "task_paused", "reason": "no_progress", "steps": 3 }),
            Some(Level::Stop),
        ),
        (
            json!({ "type": "cap_reached", "scope": "daily", "cap_micros": 1,
                 "period_start": 0, "resets_at": 1 }),
            Some(Level::Stop),
        ),
        (
            json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "401",
                 "kind": "key" }),
            Some(Level::Stop),
        ),
        (
            json!({ "type": "wake_set", "wake": "w1", "purpose": { "kind": "park", "reason": "cap" },
                 "due_ms": 5 }),
            Some(Level::Stop),
        ),
        (
            json!({ "type": "wake_set", "wake": "w1", "purpose": { "kind": "wait" },
                 "condition": { "kind": "budget" } }),
            Some(Level::Stop),
        ),
        // Waits Spade sits out quietly, and the bot's own sleeps.
        (
            json!({ "type": "wake_set", "wake": "w1", "purpose": { "kind": "park", "reason": "check" },
                 "due_ms": 5 }),
            None,
        ),
        (
            json!({ "type": "wake_set", "wake": "w1",
                 "purpose": { "kind": "outage", "attempt": 1 }, "due_ms": 5 }),
            None,
        ),
        (
            json!({ "type": "wake_set", "wake": "w1", "purpose": { "kind": "sleep" },
                 "due_ms": 5 }),
            None,
        ),
        // The person's own actions, and ordinary work.
        (
            json!({ "type": "question_deferred", "call_id": "q1" }),
            None,
        ),
        (
            json!({ "type": "approval_answered", "reply": "r1", "call_id": "c1",
                 "allowed": true }),
            None,
        ),
        (
            json!({ "type": "reply_finished", "reply": "r1", "text": "Done." }),
            None,
        ),
    ];
    for (raw, expected) in cases {
        assert_eq!(level(&known(raw.clone())), expected, "{raw}");
    }
}

#[test]
fn levels_order_from_quiet_to_loud() {
    assert!(Level::Inform < Level::Ask && Level::Ask < Level::Block && Level::Block < Level::Stop);
    assert_eq!(
        serde_json::to_value(Level::Block).ok(),
        Some(json!("block"))
    );
}

#[test]
fn a_notification_sentence_is_one_plain_line_and_never_shows_arguments() {
    let approval = known(
        json!({ "type": "approval_requested", "reply": "r1", "call_id": "c1",
        "name": "shell", "arguments": { "command": "rm -rf secret-dir" },
        "reviewer_reason": "Refused again:\n deletes outside the folder" }),
    );
    let said = sentence(&approval).unwrap_or_default();
    assert_eq!(
        said,
        "Wants your yes to use shell: Refused again: deletes outside the folder"
    );
    assert!(!said.contains("secret-dir"));
    let asked = known(
        json!({ "type": "question_asked", "reply": "r1", "call_id": "q1",
        "question": "x ".repeat(200), "later": true }),
    );
    let said = sentence(&asked).unwrap_or_default();
    assert!(said.starts_with("Asks, for later: x x"));
    assert!(said.chars().count() <= 180 && said.ends_with('…'), "{said}");
    let budget = known(
        json!({ "type": "wake_set", "wake": "w1", "purpose": { "kind": "wait" },
        "condition": { "kind": "budget" }, "reason": "subtree at budget" }),
    );
    assert_eq!(
        sentence(&budget).as_deref(),
        Some("Waiting for more budget.")
    );
    let finished = known(json!({ "type": "reply_finished", "reply": "r1", "text": "Done." }));
    assert_eq!(sentence(&finished), None);
}
