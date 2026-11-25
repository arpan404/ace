// SPDX-License-Identifier: Apache-2.0
//! `SessionOwnership` against `ownership.ts`: establish, verify, admit, accept,
//! the two bounds and the tree walk. Bounds are code points (rule 17).

use ace_json::{Value, json};

use super::{OwnershipError, SessionOwnership, parse_info};
use crate::translate::boundaries::parse_native_event;

fn snapshot(id: &str, parent: &str, directory: &str, project: &str) -> Value {
    json!({
        "id": id,
        "projectID": project,
        "location": { "directory": directory },
        "parentID": parent,
    })
}

fn event(kind: &str, data: Value) -> Value {
    json!({ "id": "e", "type": kind, "data": data })
}

/// The value with an envelope-level `location`, for the events that carry one.
fn located(mut value: Value, directory: &str) -> Value {
    if let Value::Object(map) = &mut value {
        map.insert("location", json!({ "directory": directory }));
    }
    value
}

fn owned() -> SessionOwnership {
    let mut ownership = SessionOwnership::new("/work", "", None);
    ownership
        .establish(&snapshot("root", "", "/work", "p1"))
        .expect("the root establishes");
    ownership
}

fn admit_child(ownership: &mut SessionOwnership, id: &str, parent: &str) {
    let value = event(
        "session.created",
        json!({
            "sessionID": id,
            "parentID": parent,
            "projectID": "p1",
            "location": { "directory": "/work" },
        }),
    );
    assert!(ownership.accept(&value).expect("in bounds"), "{id}");
}

#[test]
fn the_root_establishes_only_in_its_own_directory() {
    let mut ownership = SessionOwnership::new("/work", "", None);
    assert_eq!(
        ownership.establish(&snapshot("root", "", "/elsewhere", "p1")),
        Err(OwnershipError::RootMismatch)
    );
    assert_eq!(
        ownership.establish(&snapshot("root", "", "/work", "p1")),
        Ok(())
    );
    assert_eq!(ownership.root(), "root");
    assert!(ownership.at_location("/work").contains("root"));
    assert_eq!(
        ownership.establish(&snapshot("other", "", "/work", "p1")),
        Err(OwnershipError::RootMismatch)
    );
    // A resumed root keeps its id.
    let mut resumed = SessionOwnership::new("/work", "root", None);
    assert_eq!(
        resumed.establish(&snapshot("other", "", "/work", "p1")),
        Err(OwnershipError::RootMismatch)
    );
}

#[test]
fn a_child_joins_once_its_parent_owns_it() {
    let admitted = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let seen = admitted.clone();
    let mut ownership = {
        let mut with = SessionOwnership::new(
            "/work",
            "",
            Some(Box::new(move |id| {
                seen.lock().expect("log").push(id.to_owned())
            })),
        );
        with.establish(&snapshot("root", "", "/work", "p1"))
            .expect("root");
        with
    };
    admit_child(&mut ownership, "child", "root");
    assert_eq!(
        ownership.sessions().get("child").map(|o| o.parent.as_str()),
        Some("root")
    );
    assert!(ownership.direct_children("root").contains("child"));
    assert_eq!(*admitted.lock().expect("log"), vec!["child".to_owned()]);
    // Admitting again is accepted and does not report the child twice.
    admit_child(&mut ownership, "child", "root");
    assert_eq!(admitted.lock().expect("log").len(), 1);

    // A different directory, project or parent is not this tree.
    for wrong in [
        json!({ "sessionID": "x", "parentID": "root", "projectID": "p1", "location": { "directory": "/other" } }),
        json!({ "sessionID": "x", "parentID": "root", "projectID": "p2", "location": { "directory": "/work" } }),
        json!({ "sessionID": "child", "parentID": "child", "projectID": "p1", "location": { "directory": "/work" } }),
        json!({ "sessionID": "x", "parentID": "root", "fork": true, "projectID": "p1", "location": { "directory": "/work" } }),
    ] {
        assert!(
            !ownership
                .accept(&event("session.created", wrong.clone()))
                .expect("in bounds"),
            "{wrong}"
        );
    }
}

#[test]
fn a_child_of_an_unknown_parent_is_refused() {
    let mut ownership = owned();
    let value = event(
        "session.created",
        json!({ "sessionID": "x", "parentID": "ghost", "projectID": "p1", "location": { "directory": "/work" } }),
    );
    assert!(!ownership.accept(&value).expect("in bounds"));
    assert!(!ownership.sessions().contains_key("x"));
}

#[test]
fn an_event_is_accepted_only_for_an_owned_session_in_its_directory() {
    let mut ownership = owned();
    admit_child(&mut ownership, "child", "root");

    let delta = |session: &str, directory: &str| {
        located(
            event(
                "session.text.delta",
                json!({ "sessionID": session, "delta": "x" }),
            ),
            directory,
        )
    };
    assert!(
        ownership
            .accept(&delta("child", "/work"))
            .expect("in bounds")
    );
    assert!(
        !ownership
            .accept(&delta("unknown", "/work"))
            .expect("in bounds")
    );
    assert!(
        !ownership
            .accept(&delta("child", "/other"))
            .expect("in bounds")
    );

    // A project the event names must be the owner's.
    let other_project = event(
        "session.text.delta",
        json!({ "sessionID": "child", "delta": "x", "projectID": "p2" }),
    );
    assert!(!ownership.accept(&other_project).expect("in bounds"));

    // session.moved is accepted regardless of the event's own location.
    let moved = event(
        "session.moved",
        json!({ "sessionID": "child", "location": { "directory": "/elsewhere" } }),
    );
    assert!(ownership.accept(&moved).expect("in bounds"));

    // location.shutdown needs a session in that directory.
    let shutdown = |directory: &str| located(event("location.shutdown", json!({})), directory);
    assert!(ownership.accept(&shutdown("/work")).expect("in bounds"));
    assert!(
        !ownership
            .accept(&shutdown("/elsewhere"))
            .expect("in bounds")
    );
}

#[test]
fn shells_are_owned_through_creation_and_tool_progress() {
    let mut ownership = owned();
    admit_child(&mut ownership, "child", "root");

    let created = event(
        "shell.created",
        json!({ "sessionID": "child", "info": { "id": "sh1", "status": "running" } }),
    );
    assert!(ownership.accept(&created).expect("in bounds"));
    assert_eq!(
        ownership.shells().get("sh1").map(String::as_str),
        Some("child")
    );

    let progress = event(
        "session.tool.progress",
        json!({ "sessionID": "child", "metadata": { "shellID": "sh2" } }),
    );
    assert!(ownership.accept(&progress).expect("in bounds"));
    assert_eq!(
        ownership.shells().get("sh2").map(String::as_str),
        Some("child")
    );

    // A shell with no id is not an event ace can own.
    let nameless = event("shell.created", json!({ "sessionID": "child", "info": {} }));
    assert!(!ownership.accept(&nameless).expect("in bounds"));

    // An exit is accepted only for a known shell, in its session's directory.
    let exited = |shell: &str, directory: &str| {
        located(
            event("shell.exited", json!({ "sessionID": "child", "id": shell })),
            directory,
        )
    };
    assert!(
        ownership
            .accept(&exited("sh1", "/work"))
            .expect("in bounds")
    );
    assert!(
        !ownership
            .accept(&exited("sh1", "/other"))
            .expect("in bounds")
    );
    assert!(
        !ownership
            .accept(&exited("ghost", "/work"))
            .expect("in bounds")
    );
}

#[test]
fn the_two_bounds_refuse_a_new_session_or_shell() {
    let mut ownership = owned();
    for index in 1..1024 {
        admit_child(&mut ownership, &format!("c{index}"), "root");
    }
    assert_eq!(ownership.sessions().len(), 1024);
    let over = event(
        "session.created",
        json!({ "sessionID": "over", "parentID": "root", "projectID": "p1", "location": { "directory": "/work" } }),
    );
    assert!(!ownership.accept(&over).expect("in bounds"));

    let mut ownership = owned();
    admit_child(&mut ownership, "child", "root");
    for index in 0..2048 {
        let created = event(
            "shell.created",
            json!({ "sessionID": "child", "info": { "id": format!("sh{index}") } }),
        );
        assert!(ownership.accept(&created).expect("in bounds"));
    }
    let over = event(
        "shell.created",
        json!({ "sessionID": "child", "info": { "id": "over" } }),
    );
    assert_eq!(ownership.accept(&over), Err(OwnershipError::ShellLimit));
}

#[test]
fn a_refetch_confirms_the_ancestry_it_names() {
    let mut ownership = owned();
    admit_child(&mut ownership, "child", "root");
    let child = snapshot("child", "root", "/work", "p1");
    let info = parse_info(&child).expect("valid");
    assert_eq!(ownership.verify(&info), Ok(()));
    let ghost = snapshot("ghost", "root", "/work", "p1");
    assert_eq!(
        ownership.verify(&parse_info(&ghost).expect("valid")),
        Err(OwnershipError::Inconsistent)
    );
    assert_eq!(ownership.verify(&info), Ok(()));
    let root = snapshot("root", "", "/work", "p1");
    assert_eq!(ownership.verify(&parse_info(&root).expect("valid")), Ok(()));
}

#[test]
fn descendants_are_deepest_first() {
    let mut ownership = owned();
    admit_child(&mut ownership, "a", "root");
    admit_child(&mut ownership, "b", "a");
    admit_child(&mut ownership, "c", "root");
    assert_eq!(
        ownership.descendants("root").expect("acyclic"),
        vec!["b".to_owned(), "a".to_owned(), "c".to_owned()]
    );
}

#[test]
fn session_info_bounds_count_code_points() {
    // Rule 17: 512 emoji are 512 code points (and 1,024 UTF-16 units).
    let inside = snapshot(&"😀".repeat(512), "", "/work", "p1");
    assert!(parse_info(&inside).is_some());
    let outside = snapshot(&"😀".repeat(513), "", "/work", "p1");
    assert!(parse_info(&outside).is_none());
    // A directory is 1..=4096 code points.
    let long = snapshot("root", "", &"a".repeat(4096), "p1");
    assert!(parse_info(&long).is_some());
    let longer = snapshot("root", "", &"a".repeat(4097), "p1");
    assert!(parse_info(&longer).is_none());
    // A missing project or location fails the snapshot.
    assert!(parse_info(&json!({ "id": "root", "location": { "directory": "/work" } })).is_none());
    assert!(parse_info(&json!({ "id": "root", "projectID": "p1" })).is_none());
}

#[test]
fn an_envelope_the_check_refuses_is_not_owned() {
    let mut ownership = owned();

    let mut malformed = event("session.text.delta", json!({ "sessionID": "root" }));
    if let Value::Object(map) = &mut malformed {
        map.insert("type", Value::Null);
    }
    assert!(!ownership.accept(&malformed).expect("in bounds"));
    assert!(
        parse_native_event(&malformed).is_err(),
        "the same envelope the server refused"
    );
}
