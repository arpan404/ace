// SPDX-License-Identifier: Apache-2.0
//! The ancestry chain (`ancestry.ts:94`-`:128`): the hops, the two ends, the
//! cycle and depth bounds, and the identity check.

use super::{Lookup, LookupError, Step};
use crate::session::http::Reply;
use ace_json::{Value, json};

fn reply(body: Value) -> Reply {
    Reply::parse(true, &ace_json::to_string(&body))
}

fn info(id: &str, parent: Option<&str>, fork: bool) -> Value {
    let mut value = json!({
        "id": id,
        "projectID": "p1",
        "location": { "directory": "/work" },
    });
    if let (Some(parent), Value::Object(map)) = (parent, &mut value) {
        map.insert("parentID", json!(parent));
    }
    if fork && let Value::Object(map) = &mut value {
        map.insert("fork", json!(true));
    }
    value
}

/// A tree that owns `root` and `owned`; every other id is a stranger.
fn owned(id: &str) -> bool {
    id == "root" || id == "owned"
}

#[test]
fn a_chain_walks_to_an_owned_parent_and_admits_it_oldest_first() {
    let (mut lookup, first) = Lookup::begin("child");
    assert_eq!(first, Step::Request(json!({ "sessionID": "child" })));
    let next = lookup.step(
        &reply(info("child", Some("parent"), false)),
        &owned,
        false,
        false,
    );
    assert_eq!(next, Step::Request(json!({ "sessionID": "parent" })));

    let admitted = lookup.step(
        &reply(info("parent", Some("root"), false)),
        &owned,
        false,
        false,
    );
    let Step::Admit(chain) = admitted else {
        panic!("the chain admits: {admitted:?}");
    };
    let ids: Vec<&str> = chain
        .iter()
        .map(|value| value.get("id").and_then(Value::as_str).unwrap_or_default())
        .collect();
    assert_eq!(ids, ["parent", "child"], "oldest first");
    // The admitted values are the snapshots as the schema orders them.
    assert_eq!(
        ace_json::to_string(&chain[0]),
        r#"{"id":"parent","projectID":"p1","location":{"directory":"/work"},"parentID":"root"}"#
    );
}

#[test]
fn a_fork_or_a_root_ends_the_chain_without_admitting() {
    for body in [
        info("child", Some("parent"), true),
        info("child", None, false),
    ] {
        let (mut lookup, _) = Lookup::begin("child");
        assert_eq!(
            lookup.step(&reply(body), &owned, false, false),
            Step::Finished
        );
    }
}

#[test]
fn a_cycle_a_mismatched_identity_or_a_17th_hop_fails_the_chain() {
    // A cycle back to the probed session.
    let (mut lookup, _) = Lookup::begin("child");
    lookup.step(
        &reply(info("child", Some("a"), false)),
        &owned,
        false,
        false,
    );
    assert_eq!(
        lookup.step(
            &reply(info("a", Some("child"), false)),
            &owned,
            false,
            false
        ),
        Step::Failed(LookupError::Unverified)
    );

    // The reply names another session than the request did.
    let (mut lookup, _) = Lookup::begin("child");
    assert_eq!(
        lookup.step(
            &reply(info("other", Some("root"), false)),
            &owned,
            false,
            false
        ),
        Step::Failed(LookupError::Mismatched)
    );

    // A snapshot that fails `SessionInfo.parse`.
    let (mut lookup, _) = Lookup::begin("child");
    assert_eq!(
        lookup.step(&reply(json!({ "id": "child" })), &owned, false, false),
        Step::Failed(LookupError::Envelope(
            "event failed its envelope check: info".to_owned()
        ))
    );

    // Sixteen snapshots fit; the request the sixteenth would need is refused.
    let (mut lookup, _) = Lookup::begin("child");
    let mut cursor = String::from("child");
    for hop in 0..15 {
        let parent = format!("n{hop}");
        assert_eq!(
            lookup.step(
                &reply(info(&cursor, Some(&parent), false)),
                &owned,
                false,
                false
            ),
            Step::Request(json!({ "sessionID": parent })),
            "hop {hop}"
        );
        cursor = parent;
    }
    assert_eq!(
        lookup.step(
            &reply(info(&cursor, Some("n15"), false)),
            &owned,
            false,
            false
        ),
        Step::Failed(LookupError::Unverified)
    );
}

#[test]
fn a_pass_that_reached_the_probe_waits_or_fails() {
    // Not recovering: the probe fails and asks for a pass.
    let (mut lookup, _) = Lookup::begin("owned");
    assert_eq!(
        lookup.step(
            &reply(info("owned", Some("root"), false)),
            &owned,
            true,
            false
        ),
        Step::NeedsRecovery
    );
    // Already recovering: the pass in flight covers it, so nothing is noted.
    let (mut lookup, _) = Lookup::begin("owned");
    assert_eq!(
        lookup.step(
            &reply(info("owned", Some("root"), false)),
            &owned,
            true,
            true
        ),
        Step::Waiting
    );
}

#[test]
fn a_cursor_is_the_session_the_outstanding_request_names() {
    let (mut lookup, _) = Lookup::begin("child");
    assert_eq!(lookup.cursor(), "child");
    lookup.step(
        &reply(info("child", Some("parent"), false)),
        &owned,
        false,
        false,
    );
    assert_eq!(lookup.cursor(), "parent");
}
