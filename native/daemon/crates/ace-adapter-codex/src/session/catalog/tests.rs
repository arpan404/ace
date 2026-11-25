// SPDX-License-Identifier: Apache-2.0
//! The optional surfaces (`extension-catalog.ts`): which frames are optional,
//! the coalesced reads, the publication, and the re-read an invalidation asks
//! for while one is in flight.

use ace_json::Value;

use super::*;
use crate::session::frames::FrameDir;
use crate::session::state::{Session, SessionConfig};

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

fn request(effect: &Effect) -> (u64, String, Value, Option<f64>) {
    match effect {
        Effect::Request {
            call,
            method,
            params,
            timeout_ms,
        } => (*call, method.clone(), params.clone(), *timeout_ms),
        other => panic!("expected a request, got {other:?}"),
    }
}

fn notes(effects: &[Effect]) -> Vec<Value> {
    effects
        .iter()
        .filter_map(|effect| match effect {
            Effect::Frame {
                dir: FrameDir::Note,
                channel,
                text,
            } if *channel == "catalog.runtime" => {
                Some(ace_json::parse(text).expect("a note parses"))
            }
            _ => None,
        })
        .collect()
}

#[test]
fn only_a_catalog_request_and_its_reply_are_optional() {
    let mut session = session();
    let sent = json(r#"{"id":5,"method":"skills/list","params":{}}"#);
    assert_eq!(session.optional_frame(FrameDir::Send, &sent), None);
    let reply = json(r#"{"id":5,"result":{"data":[]}}"#);
    assert_eq!(
        session.optional_frame(FrameDir::Recv, &reply),
        Some("skills/list".to_owned())
    );
    // The method is given back once.
    assert_eq!(session.optional_frame(FrameDir::Recv, &reply), None);
    // An execution request's reply never is.
    let sent = json(r#"{"id":6,"method":"turn/start","params":{}}"#);
    assert_eq!(session.optional_frame(FrameDir::Send, &sent), None);
    assert_eq!(
        session.optional_frame(FrameDir::Recv, &json(r#"{"id":6,"result":{}}"#)),
        None
    );
}

#[test]
fn a_catalog_notification_is_optional_but_a_server_request_never_is() {
    let mut session = session();
    assert_eq!(
        session.optional_frame(
            FrameDir::Recv,
            &json(r#"{"method":"skills/changed","params":{}}"#)
        ),
        Some("skills/changed".to_owned())
    );
    assert_eq!(
        session.optional_frame(
            FrameDir::Recv,
            &json(r#"{"id":9,"method":"skills/changed","params":{}}"#)
        ),
        None
    );
    assert_eq!(
        session.optional_frame(
            FrameDir::Recv,
            &json(r#"{"method":"turn/started","params":{}}"#)
        ),
        None
    );
}

#[test]
fn the_catalog_starts_the_three_surfaces_with_the_params_each_takes() {
    let mut session = session();
    let effects = session.catalog_start();
    assert_eq!(effects.len(), 3);
    let (_, method, params, timeout) = request(&effects[0]);
    assert_eq!(method, "skills/list");
    assert_eq!(params.get("cwds"), Some(&json(r#"["/repo"]"#)));
    assert_eq!(params.get("forceReload"), Some(&Value::Bool(true)));
    assert_eq!(timeout, Some(5_000.0));
    let (_, method, params, _) = request(&effects[1]);
    assert_eq!(method, "app/list");
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("root-1")
    );
    assert_eq!(params.get("limit").and_then(Value::as_f64), Some(100.0));
    let (_, method, _, _) = request(&effects[2]);
    assert_eq!(method, "mcpServerStatus/list");
}

#[test]
fn a_read_publishes_one_note_per_changed_snapshot_and_none_for_a_repeat() {
    let mut session = session();
    let effects = session.catalog_start();
    let (call, ..) = request(&effects[0]);
    let effects = session
        .catalog_settled(
            call,
            Ok(&json(r#"{"data":[{"name":"skill"}],"nextCursor":null}"#)),
        )
        .expect("a catalog page");
    let published = notes(&effects);
    assert_eq!(
        published[0],
        json(r#"{"method":"skills/list","result":{"data":[{"name":"skill"}]},"cwd":"/repo"}"#,)
    );
    // The same snapshot again costs no frame.
    let effects = session.catalog_start();
    let (again, ..) = request(&effects[0]);
    let effects = session
        .catalog_settled(
            again,
            Ok(&json(r#"{"data":[{"name":"skill"}],"nextCursor":null}"#)),
        )
        .expect("a catalog page");
    assert!(notes(&effects).is_empty());
}

#[test]
fn a_page_with_a_cursor_asks_for_the_next_one_and_keeps_the_order_it_read() {
    let mut session = session();
    let effects = session.catalog_start();
    let (call, ..) = request(&effects[1]);
    let effects = session
        .catalog_settled(
            call,
            Ok(&json(r#"{"data":[{"id":"a"}],"nextCursor":"c2"}"#)),
        )
        .expect("a catalog page");
    let (next, _, params, _) = request(&effects[0]);
    assert_eq!(params.get("cursor").and_then(Value::as_str), Some("c2"));
    assert_eq!(
        params.get("threadId").and_then(Value::as_str),
        Some("root-1")
    );
    let effects = session
        .catalog_settled(
            next,
            Ok(&json(r#"{"data":[{"id":"b"}],"nextCursor":null}"#)),
        )
        .expect("a catalog page");
    assert_eq!(
        notes(&effects)[0].get("result"),
        Some(&json(r#"{"data":[{"id":"a"},{"id":"b"}]}"#))
    );
}

#[test]
fn a_list_pushed_while_a_read_was_in_flight_is_newer_than_the_read() {
    let mut session = session();
    let effects = session.catalog_start();
    let (call, ..) = request(&effects[1]);
    let pushed = session.catalog_changed(
        "app/list/updated",
        Some(&json(r#"{"data":[{"id":"pushed"}]}"#)),
    );
    assert_eq!(
        notes(&pushed)[0].get("result"),
        Some(&json(r#"{"data":[{"id":"pushed"}]}"#))
    );
    // The read's snapshot is older than the push: it is not published.
    let effects = session
        .catalog_settled(
            call,
            Ok(&json(r#"{"data":[{"id":"read"}],"nextCursor":null}"#)),
        )
        .expect("a catalog page");
    assert!(notes(&effects).is_empty());
}

#[test]
fn an_invalidation_during_a_read_is_answered_by_one_more_read() {
    let mut session = session();
    let effects = session.catalog_start();
    let (call, ..) = request(&effects[0]);
    // While the skills read is in flight, Codex says they changed.
    assert!(session.catalog_changed("skills/changed", None).is_empty());
    let effects = session
        .catalog_settled(call, Ok(&json(r#"{"data":[],"nextCursor":null}"#)))
        .expect("a catalog page");
    // The snapshot it read is published, then the re-read it owes is asked for.
    assert_eq!(notes(&effects).len(), 1);
    let (again, method, ..) = request(&effects[1]);
    assert_eq!(method, "skills/list");
    assert_ne!(again, call);
}

#[test]
fn a_failed_read_keeps_the_last_snapshot() {
    let mut session = session();
    let effects = session.catalog_start();
    let (call, ..) = request(&effects[0]);
    let effects = session
        .catalog_settled(
            call,
            Ok(&json(r#"{"data":[{"name":"skill"}],"nextCursor":null}"#)),
        )
        .expect("a catalog page");
    assert_eq!(notes(&effects).len(), 1);
    let effects = session.catalog_start();
    let (again, ..) = request(&effects[0]);
    let effects = session
        .catalog_settled(again, Err("Method not found"))
        .expect("a catalog page");
    assert!(notes(&effects).is_empty());
}
