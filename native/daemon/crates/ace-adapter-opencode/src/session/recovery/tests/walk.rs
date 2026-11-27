// SPDX-License-Identifier: Apache-2.0
//! The pass's walk (`recovery.ts`): the order of its reads and frames, the
//! pagination and visit bounds, the interaction staging and the settlement
//! check. The host is real ownership and real history; only the `http` replies
//! are scripted.

use super::{Host, answer, children, drive, info, ops, reply};
use ace_json::{Value, json};
use std::cell::RefCell;

use crate::session::http::Reply;
use crate::session::recovery::{Recovery, RecoveryError};

#[test]
fn one_visit_reads_its_snapshot_children_messages_history_then_its_pending_lists() {
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let requests = drive(machine, &host, first, &mut |op, params| match op {
        "session.list" if params.get("parentID").and_then(Value::as_str) == Some("root") => {
            children(&["child"], None)
        }
        _ => answer(op, params),
    })
    .expect("the pass");

    assert_eq!(
        ops(&requests),
        [
            "session.get root",
            "session.list",
            "session.get child",
            "session.list",
            "message.list child",
            "permission.list child",
            "session.form.list child",
            "session.inbox.list child",
            "message.list root",
            "permission.list root",
            "session.form.list root",
            "session.inbox.list root",
            "session.active",
            "session.get root",
            "session.get child",
            "shell.list",
        ]
    );
    // The listing names the root's own directory and project, oldest page first.
    assert_eq!(
        ace_json::to_string(&requests[1].1),
        r#"{"parentID":"root","directory":"/work","project":"p1","limit":128,"order":"asc"}"#
    );
    assert_eq!(
        host.framed("snapshot.info").len(),
        2,
        "each visit's snapshot"
    );
    assert_eq!(
        host.framed("snapshot.info")[0],
        r#"{"info":{"id":"root","projectID":"p1","location":{"directory":"/work"}},"recovering":true}"#
    );
    let staged: Vec<(String, String)> = host
        .stages
        .borrow()
        .iter()
        .map(|(channel, session, _)| (channel.clone(), session.clone()))
        .collect();
    assert_eq!(
        staged,
        [
            ("snapshot.interactions".to_owned(), "child".to_owned()),
            ("snapshot.inbox".to_owned(), "child".to_owned()),
            ("snapshot.interactions".to_owned(), "root".to_owned()),
            ("snapshot.inbox".to_owned(), "root".to_owned()),
            ("snapshot.active".to_owned(), "root".to_owned()),
            ("snapshot.active".to_owned(), "child".to_owned()),
        ],
        "the child's visit stages before its parent's, then the active read"
    );
    assert!(
        host.stages
            .borrow()
            .iter()
            .all(|(_, _, started)| *started == 9),
        "each stage is fenced by the watermark the pass read"
    );
}

#[test]
fn a_child_page_is_read_until_its_cursor_ends_and_a_repeated_one_fails() {
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let requests = drive(machine, &host, first, &mut |op, params| {
        if op != "session.list" {
            return answer(op, params);
        }
        match params.get("parentID").and_then(Value::as_str) {
            Some("root") if params.get("cursor").is_none() => children(&[], Some("c1")),
            Some("root") => children(&[], None),
            _ => children(&[], None),
        }
    })
    .expect("the pass");
    let lists: Vec<&Value> = requests
        .iter()
        .filter(|(op, _)| op == "session.list")
        .map(|(_, params)| params)
        .collect();
    assert_eq!(
        ace_json::to_string(lists[1]),
        r#"{"parentID":"root","directory":"/work","project":"p1","limit":128,"cursor":"c1"}"#
    );

    // The same cursor twice is the TypeScript's `cursors.has(next)` throw.
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "session.list" {
            return children(&[], Some("c1"));
        }
        answer(op, params)
    });
    assert_eq!(failed, Err(RecoveryError::Pagination));

    // The 64th page cannot hand on a 65th.
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let pages = RefCell::new(0usize);
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "session.list" {
            let mut count = pages.borrow_mut();
            *count += 1;
            return children(&[], Some(&format!("c{count}")));
        }
        answer(op, params)
    });
    assert_eq!(failed, Err(RecoveryError::Pagination));
    assert_eq!(*pages.borrow(), 64);
}

#[test]
fn a_live_message_is_read_and_framed_before_the_history() {
    let mut host = Host::new("root");
    host.live.insert("root".to_owned(), vec!["m1".to_owned()]);
    let (machine, first) = Recovery::begin("root");
    let requests = drive(machine, &host, first, &mut |op, params| {
        if op == "session.message.get" {
            assert_eq!(
                ace_json::to_string(params),
                r#"{"sessionID":"root","messageID":"m1"}"#
            );
        }
        answer(op, params)
    })
    .expect("the pass");
    let index = requests
        .iter()
        .position(|(op, _)| op == "session.message.get")
        .expect("the live read");
    assert!(
        requests[index + 1..]
            .iter()
            .any(|(op, _)| op == "message.list"),
        "the history follows the live messages"
    );
    let messages = host.framed("snapshot.message");
    assert_eq!(messages.len(), 1);
    assert!(
        messages[0].contains(r#""sessionID":"root""#),
        "{messages:?}"
    );
}

#[test]
fn interactions_are_received_and_their_keys_staged_with_ownership_checks() {
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    drive(machine, &host, first, &mut |op, params| match op {
        "permission.list" => reply(json!([{ "sessionID": "root", "id": "p1" }])),
        "session.form.list" => reply(json!([{ "sessionID": "root", "id": "f1" }])),
        "session.inbox.list" => reply(json!([{ "sessionID": "root", "id": "i1" }])),
        _ => answer(op, params),
    })
    .expect("the pass");
    let receives = host.receives.borrow();
    let ids: Vec<&str> = receives
        .iter()
        .filter(|text| text.contains("snapshot:"))
        .map(String::as_str)
        .collect();
    assert_eq!(
        ids,
        [
            r#"{"id":"snapshot:permission:root:p1","type":"permission.asked","data":{"sessionID":"root","id":"p1"}}"#,
            r#"{"id":"snapshot:form:root:f1","type":"form.created","data":{"form":{"sessionID":"root","id":"f1"}}}"#,
        ]
    );

    // An inbox entry for another session fails the pass.
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "session.inbox.list" {
            return reply(json!([{ "sessionID": "other" }]));
        }
        answer(op, params)
    });
    assert_eq!(failed, Err(RecoveryError::InboxOwnership));

    // So does an interaction for another session.
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "permission.list" {
            return reply(json!([{ "sessionID": "other", "id": "p1" }]));
        }
        answer(op, params)
    });
    assert_eq!(failed, Err(RecoveryError::InteractionOwnership));
}

#[test]
fn an_observed_session_without_settlement_evidence_fails_the_pass() {
    for (active, time, outcome, expected) in [
        (
            json!({}),
            json!({ "updated": 3 }),
            Value::Null,
            Err(RecoveryError::Settlement),
        ),
        (
            json!({}),
            json!({ "updated": 3, "idle": 4 }),
            Value::Null,
            Ok(()),
        ),
        (
            json!({ "root": { "type": "running" } }),
            json!({ "updated": 3 }),
            Value::Null,
            Ok(()),
        ),
        (
            json!({}),
            json!({ "updated": 3 }),
            json!({ "type": "succeeded" }),
            Ok(()),
        ),
    ] {
        let host = Host::new("root");
        let mut observed = host.observed.clone();
        observed.insert("root".to_owned());
        let host = Host { observed, ..host };
        let mut root = info("root", None, "/work", "p1");
        if let Value::Object(map) = &mut root {
            map.insert("time".to_owned(), time);
            if outcome != Value::Null {
                map.insert("outcome".to_owned(), outcome);
            }
        }
        let (machine, first) = Recovery::begin("root");
        let result = drive(machine, &host, first, &mut |op, params| {
            if op == "session.active" {
                return reply(active.clone());
            }
            if op == "session.get" {
                return reply(root.clone());
            }
            answer(op, params)
        })
        .map(|_| ());
        assert_eq!(result, expected);
    }
}

#[test]
fn a_repeated_session_in_the_tree_and_an_over_deep_chain_fail_the_pass() {
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "session.list" && params.get("parentID").and_then(Value::as_str) == Some("root") {
            return children(&["child", "child"], None);
        }
        answer(op, params)
    });
    assert_eq!(failed, Err(RecoveryError::Cycle));
}

#[test]
fn a_refused_read_carries_its_message_and_ends_the_pass() {
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "session.list" {
            return Reply::parse(
                false,
                r#"{"message":"OpenCode session not found","status":404}"#,
            );
        }
        answer(op, params)
    });
    assert_eq!(
        failed,
        Err(RecoveryError::Refused(String::from(
            "OpenCode session not found"
        )))
    );
}

#[test]
fn a_session_info_that_fails_its_check_ends_the_pass() {
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "session.get" {
            return reply(json!({ "id": "root" }));
        }
        answer(op, params)
    });
    assert_eq!(
        failed,
        Err(RecoveryError::Envelope(String::from(
            "event failed its envelope check: info"
        )))
    );
}

#[test]
fn the_snapshot_ownership_is_checked_against_the_tree() {
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    // A get for a session the tree does not hold fails `verify`.
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "session.list" && params.get("parentID").and_then(Value::as_str) == Some("root") {
            return children(&["child"], None);
        }
        answer(op, params)
    });
    assert_eq!(
        failed.map(|_| ()),
        Ok(()),
        "the walk admits the child before verifying it"
    );

    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "session.get" {
            return reply(info("root", Some("elsewhere"), "/work", "p1"));
        }
        answer(op, params)
    });
    assert!(matches!(failed, Err(RecoveryError::Ownership(_))));
}

#[test]
fn a_visit_parses_the_child_with_its_own_snapshot_before_admitting_it() {
    let host = Host::new("root");
    let (machine, first) = Recovery::begin("root");
    let failed = drive(machine, &host, first, &mut |op, params| {
        if op == "session.list" {
            return reply(json!({
                "data": [{ "id": "child", "projectID": "p1", "location": { "directory": "/elsewhere" } }],
                "cursor": { "next": null },
            }));
        }
        answer(op, params)
    });
    assert!(matches!(failed, Err(RecoveryError::Ownership(_))));
}
