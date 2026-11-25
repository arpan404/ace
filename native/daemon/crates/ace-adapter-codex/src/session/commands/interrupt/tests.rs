// SPDX-License-Identifier: Apache-2.0
//! `interrupt`, `stopTask` and a cascade's shells (`session-commands.ts:171`).

use ace_json::Value;

use super::*;
use crate::session::state::SessionConfig;

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

fn request(effect: &Effect) -> (u64, String, Value) {
    match effect {
        Effect::Request {
            call,
            method,
            params,
            ..
        } => (*call, method.clone(), params.clone()),
        other => panic!("expected a request, got {other:?}"),
    }
}

fn failure(effect: &Effect) -> &str {
    match effect {
        Effect::Settle {
            result: Err(failure),
            ..
        } => &failure.message,
        other => panic!("expected a failure, got {other:?}"),
    }
}

#[test]
fn interrupting_the_root_turn_asks_codex_to_interrupt_that_turn() {
    let mut session = session();
    session
        .active
        .insert("root-1".to_owned(), "turn-1".to_owned());
    let effects = session.interrupt(30, None, false);
    let (call, method, params) = request(&effects[0]);
    assert_eq!(method, "turn/interrupt");
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("root-1")
    );
    assert_eq!(params.get("turnId").and_then(Value::as_str), Some("turn-1"));
    let effects = session.settled(call, Ok(&json("{}")));
    assert!(matches!(
        effects[0],
        Effect::Settle {
            id: 30,
            result: Ok(_)
        }
    ));
}

#[test]
fn a_cascade_stops_the_threads_shells_after_its_turn() {
    let mut session = session();
    session
        .active
        .insert("root-1".to_owned(), "turn-1".to_owned());
    let effects = session.interrupt(31, None, true);
    let (call, ..) = request(&effects[0]);
    let effects = session.settled(call, Ok(&json("{}")));
    let (read, method, params) = request(&effects[0]);
    assert_eq!(method, "thread/backgroundTerminals/list");
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("root-1")
    );
    let effects = session.settled(
        read,
        Ok(&json(
            r#"{"data":[{"processId":"p1","itemId":"i1"},{"processId":"p2","itemId":"i2"}],"nextCursor":null}"#,
        )),
    );
    let (first, method, params) = request(&effects[0]);
    assert_eq!(method, "thread/backgroundTerminals/terminate");
    assert_eq!(params.get("processId").and_then(Value::as_str), Some("p1"));
    let effects = session.settled(first, Ok(&json("{}")));
    let (second, _, params) = request(&effects[0]);
    assert_eq!(params.get("processId").and_then(Value::as_str), Some("p2"));
    let effects = session.settled(second, Ok(&json("{}")));
    assert!(matches!(
        effects[0],
        Effect::Settle {
            id: 31,
            result: Ok(_)
        }
    ));
}

#[test]
fn a_thread_whose_turn_and_shells_both_failed_reports_the_tree_once() {
    let mut session = session();
    session
        .active
        .insert("root-1".to_owned(), "turn-1".to_owned());
    let effects = session.interrupt(32, None, true);
    let (call, ..) = request(&effects[0]);
    let effects = session.settled(call, Err("stale turn"));
    let (read, ..) = request(&effects[0]);
    let effects = session.settled(
        read,
        Ok(&json(r#"{"data":[{"processId":"p1"}],"nextCursor":null}"#)),
    );
    let (terminate, ..) = request(&effects[0]);
    let effects = session.settled(terminate, Err("no such process"));
    assert_eq!(
        failure(&effects[0]),
        "Could not completely interrupt Codex agent tree"
    );
}

#[test]
fn a_cascade_reaches_every_thread_whose_parents_chain_to_the_root() {
    let mut session = session();
    session
        .parents
        .insert("child-1".to_owned(), "root-1".to_owned());
    session
        .parents
        .insert("child-2".to_owned(), "child-1".to_owned());
    session
        .parents
        .insert("stranger".to_owned(), "someone-else".to_owned());
    let mut targets = tree_targets(&session.parents, "root-1", true);
    targets.make_contiguous().sort();
    assert_eq!(
        targets.into_iter().collect::<Vec<String>>(),
        ["child-1", "child-2", "root-1"]
    );
}

#[test]
fn stopping_an_unknown_background_task_names_it() {
    let mut session = session();
    let effects = session.stop_task(33, "shell:item-1");
    assert_eq!(failure(&effects[0]), UNKNOWN_TASK);
}

#[test]
fn stopping_a_terminal_that_is_no_longer_listed_says_so() {
    let mut session = session();
    session
        .shells
        .insert("item-1".to_owned(), "root-1".to_owned());
    let effects = session.stop_task(34, "shell:item-1");
    let (read, method, _) = request(&effects[0]);
    assert_eq!(method, "thread/backgroundTerminals/list");
    let effects = session.settled(
        read,
        Ok(&json(
            r#"{"data":[{"processId":"p1","itemId":"item-2"}],"nextCursor":null}"#,
        )),
    );
    assert_eq!(failure(&effects[0]), NO_TERMINAL);
}

#[test]
fn stopping_a_subagent_stops_its_own_tree() {
    let mut session = session();
    session
        .parents
        .insert("child-1".to_owned(), "agent-1".to_owned());
    session
        .active
        .insert("agent-1".to_owned(), "turn-9".to_owned());
    session
        .active
        .insert("child-1".to_owned(), "turn-8".to_owned());
    let effects = session.stop_task(35, "subagent:agent-1");
    let (call, method, params) = request(&effects[0]);
    assert_eq!(method, "turn/interrupt");
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("agent-1")
    );
    // The agent's own shells stop before the tree moves to its child.
    let effects = session.settled(call, Ok(&json("{}")));
    let (read, method, params) = request(&effects[0]);
    assert_eq!(method, "thread/backgroundTerminals/list");
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("agent-1")
    );
    let effects = session.settled(read, Ok(&json(r#"{"data":[],"nextCursor":null}"#)));
    let (child, method, params) = request(&effects[0]);
    assert_eq!(method, "turn/interrupt");
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("child-1")
    );
    let effects = session.settled(child, Ok(&json("{}")));
    assert_eq!(request(&effects[0]).1, "thread/backgroundTerminals/list");
    let (read, ..) = request(&effects[0]);
    let effects = session.settled(read, Ok(&json(r#"{"data":[],"nextCursor":null}"#)));
    assert!(matches!(
        effects[0],
        Effect::Settle {
            id: 35,
            result: Ok(_)
        }
    ));
}
