use std::collections::BTreeMap;

use serde_json::{Value, json};

use super::render::{headline, text};
use super::*;

/// Events with their times, oldest first.
struct Log(Vec<(i64, Event)>);

impl Log {
    fn new() -> Self {
        Self(Vec::new())
    }

    fn at(mut self, ms: i64, raw: Value) -> Self {
        self.0.push((ms, Event::from_json(raw)));
        self
    }

    fn digest(&self, from_ms: i64, to_ms: i64, spend: &[(&str, u64)]) -> Digest {
        let events: Vec<Event> = self.0.iter().map(|(_, e)| e.clone()).collect();
        let at_ms: Vec<i64> = self.0.iter().map(|(t, _)| *t).collect();
        task(&Input {
            agent: "a1",
            name: "Builder",
            events: &events,
            at_ms: &at_ms,
            from_ms,
            to_ms,
            spend: spend
                .iter()
                .map(|(r, m)| ((*r).to_owned(), *m))
                .collect::<BTreeMap<_, _>>(),
        })
    }
}

fn plan(change: Value) -> Value {
    json!({ "type": "plan_changed", "goal": "g1", "change": change })
}

fn goal_with_plan() -> Log {
    Log::new()
        .at(
            10,
            json!({ "type": "user_message", "text": "Keep the build green" }),
        )
        .at(
            11,
            json!({ "type": "goal_set", "goal": "g1", "title": "Green build",
                        "text": "Keep the build green", "by": "bot",
                        "criteria": [{ "id": "1", "text": "tests pass" }] }),
        )
        .at(
            12,
            plan(json!({ "op": "add", "item": "1", "text": "fix the test" })),
        )
        .at(
            13,
            plan(json!({ "op": "add", "item": "2", "text": "run the lint" })),
        )
        .at(
            14,
            plan(json!({ "op": "add", "item": "3", "text": "ship it" })),
        )
}

fn texts(lines: &[Line]) -> Vec<&str> {
    lines.iter().map(|l| l.text.as_str()).collect()
}

#[test]
fn progress_counts_what_the_bot_closed_apart_from_what_the_check_verified() {
    let log = goal_with_plan()
        .at(
            100,
            plan(json!({ "op": "done", "item": "1",
                              "evidence": [{ "kind": "output", "call": "c4" }] })),
        )
        .at(
            101,
            plan(json!({ "op": "done", "item": "2",
                              "evidence": [{ "kind": "output", "call": "c5" }] })),
        )
        .at(
            102,
            json!({ "type": "task_verified", "goal": "g1", "claim": "c6",
                         "verdict": "not_yet", "missing": ["Show the lint passing."],
                         "rejected": [{ "item": "2", "why": "no lint output" }] }),
        );
    let digest = log.digest(50, 200, &[]);
    let Some(progress) = digest.progress else {
        panic!("no goal in {digest:?}")
    };
    assert_eq!(
        (
            progress.items_total,
            progress.items_closed,
            progress.items_verified
        ),
        (3, 1, 1),
        "the rejected item reopened"
    );
    assert_eq!(
        (progress.closed_in_window, progress.verified_in_window),
        (2, 1)
    );
    assert_eq!(
        texts(&digest.changed),
        vec![
            "Closed 1: fix the test (verified)",
            "Closed 2: run the lint (claimed, not verified)",
            "The check says not yet: Show the lint passing.",
        ]
    );
}

#[test]
fn only_the_window_changes_but_where_things_stand_comes_from_the_whole_history() {
    let log = goal_with_plan()
        .at(100, plan(json!({ "op": "start", "item": "2" })))
        .at(
            300,
            plan(json!({ "op": "blocked", "item": "3", "reason": "needs the deploy key" })),
        );
    let digest = log.digest(50, 200, &[]);
    assert!(texts(&digest.changed).is_empty(), "{:?}", digest.changed);
    assert!(!digest.quiet, "a plan change is something happening");
    assert_eq!(
        digest.next,
        vec!["2: run the lint", "1: fix the test", "3: ship it"]
    );
    assert!(digest.blocked.is_empty(), "the block came after the window");
    let later = log.digest(200, 400, &[]);
    assert_eq!(
        texts(&later.changed),
        vec!["Blocked 3: needs the deploy key"]
    );
    assert_eq!(later.blocked.len(), 1);
    assert_eq!(later.blocked[0].reason, "needs the deploy key");
    assert_eq!(later.next, vec!["2: run the lint", "1: fix the test"]);
}

#[test]
fn decisions_and_spend_by_role_are_the_windows() {
    let log = Log::new()
        .at(
            10,
            json!({ "type": "decision_made", "decision": "d1", "call_id": "c1",
                        "choice": "Postgres", "reason": "already running" }),
        )
        .at(
            100,
            json!({ "type": "decision_made", "decision": "d2", "call_id": "c2",
                         "choice": "Retry nightly", "reason": "the API is flaky",
                         "options": ["Retry hourly"] }),
        );
    let digest = log.digest(50, 200, &[("main", 300_000), ("review", 20_000)]);
    let decided: Vec<&str> = digest
        .decisions
        .iter()
        .map(|d| d.decision.choice.as_str())
        .collect();
    assert_eq!(decided, vec!["Retry nightly"]);
    assert_eq!(digest.spend.total_micros, 320_000);
    assert_eq!(digest.subtree_spend_micros, 320_000);
    let said = text(&digest, &|ms| format!("t{ms}"));
    assert!(
        said.contains(
            "Decided for you:\n- Retry nightly. Why: the API is flaky Set aside: Retry hourly."
        ),
        "{said}"
    );
    assert!(
        said.contains("Spent $0.32 (main $0.30, review $0.02)."),
        "{said}"
    );
}

#[test]
fn what_waits_on_the_person_is_listed_loudest_first_with_its_level() {
    let log = Log::new()
        .at(10, json!({ "type": "user_message", "text": "Book it" }))
        .at(
            11,
            json!({ "type": "reply_started", "reply": "r1", "model": "m" }),
        )
        .at(
            12,
            json!({ "type": "step_finished", "reply": "r1", "text": "",
                        "calls": [{ "id": "q1", "name": "ask_user", "arguments": {} },
                                  { "id": "q2", "name": "ask_user", "arguments": {} }] }),
        )
        .at(
            13,
            json!({ "type": "question_asked", "reply": "r1", "call_id": "q1",
                        "question": "Which date?", "later": true }),
        )
        .at(
            13,
            json!({ "type": "question_deferred", "call_id": "q1", "by_bot": true }),
        )
        .at(
            14,
            json!({ "type": "question_asked", "reply": "r1", "call_id": "q2",
                        "question": "Window or aisle?" }),
        )
        .at(
            20,
            json!({ "type": "wake_set", "wake": "w1",
                        "purpose": { "kind": "park", "reason": "cap" }, "due_ms": 99,
                        "reason": "Waiting for the daily cap to reset at 00:00" }),
        );
    let digest = log.digest(0, 100, &[]);
    let waiting: Vec<(Level, &str)> = digest
        .waiting
        .iter()
        .map(|w| (w.level, w.what.as_str()))
        .collect();
    // A cap park an earlier build stored waits on no one (ADR 0166).
    assert_eq!(
        waiting,
        vec![
            (Level::Block, "A question for you: Window or aisle?"),
            (Level::Ask, "A question for you: Which date?"),
        ]
    );
    assert_eq!(loudest(&digest), Some(Level::Block));
}

#[test]
fn a_pause_and_a_failed_last_reply_wait_until_a_reply_starts_again() {
    let paused = Log::new()
        .at(
            10,
            json!({ "type": "reply_started", "reply": "r1", "model": "m" }),
        )
        .at(
            11,
            json!({ "type": "reply_failed", "reply": "r1", "text": "", "error": "401",
                        "kind": "key" }),
        )
        .at(
            12,
            json!({ "type": "task_paused", "reason": "no_progress", "steps": 3 }),
        );
    let levels: Vec<Level> = paused
        .digest(0, 50, &[])
        .waiting
        .iter()
        .map(|w| w.level)
        .collect();
    assert_eq!(levels, vec![Level::Stop, Level::Stop]);
    let resumed = paused
        .at(20, json!({ "type": "user_message", "text": "go on" }))
        .at(
            21,
            json!({ "type": "reply_started", "reply": "r2", "model": "m" }),
        );
    assert!(resumed.digest(0, 50, &[]).waiting.is_empty());
}

#[test]
fn a_window_with_only_upkeep_is_quiet_and_reads_as_one_line() {
    let log = Log::new()
        .at(10, json!({ "type": "user_message", "text": "hi" }))
        .at(100, json!({ "type": "renamed", "title": "Hi" }))
        .at(101, json!({ "type": "skills_indexed", "skills": [] }));
    let digest = log.digest(50, 200, &[]);
    assert!(digest.quiet);
    assert_eq!(
        text(&digest, &|ms| format!("t{ms}")),
        "Builder: nothing new since t50."
    );
    assert!(
        !log.digest(0, 200, &[]).quiet,
        "the message is in this window"
    );
}

#[test]
fn a_tree_digest_adds_its_workers_spend_and_is_quiet_only_when_every_part_is() {
    let busy = Log::new().at(100, json!({ "type": "user_message", "text": "go" }));
    let idle = Log::new();
    let mut worker = busy.digest(50, 200, &[("main", 50_000)]);
    worker.name = "Scout".into();
    let root = idle.digest(50, 200, &[("main", 10_000)]);
    assert!(root.quiet);
    let tree = tree(root, vec![worker]);
    assert!(!tree.quiet);
    assert_eq!(tree.subtree_spend_micros, 60_000);
    let said = text(&tree, &|ms| format!("t{ms}"));
    assert!(said.starts_with("Builder: from t50 to t200"), "{said}");
    assert!(
        said.contains("Spent $0.01 (main $0.01), $0.06 with its workers."),
        "{said}"
    );
    assert!(
        said.contains("Workers:\n  Scout: from t50 to t200\n  Spent $0.05 (main $0.05)."),
        "{said}"
    );
    assert_eq!(
        headline(&tree, &|ms| format!("t{ms}")),
        "Builder: from t50 to t200"
    );
}

#[test]
fn what_changed_is_capped_and_counts_the_rest() {
    let mut log = Log::new();
    for i in 0..45 {
        log = log.at(
            100 + i,
            plan(json!({ "op": "add", "item": format!("{}", i + 1),
                                           "text": "step" })),
        );
    }
    let digest = log.digest(50, 500, &[]);
    assert_eq!(digest.changed.len(), MOST_CHANGED);
    assert_eq!(digest.more_changed, 5);
    assert!(text(&digest, &|_| String::new()).contains("- and 5 more"));
}
