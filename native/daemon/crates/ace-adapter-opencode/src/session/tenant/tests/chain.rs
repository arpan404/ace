// SPDX-License-Identifier: Apache-2.0
//! The ancestry chain over `http` replies (`ancestry.ts:94`-`:128`): proving a
//! child from an owned parent, a chain that ends at a root, and a refused hop.

use super::{drain, event, frames, located, notes, ports, ready};
use ace_adapter_api::FrameDirection;
use ace_json::json;

use crate::session::server::Tenant;

#[test]
fn an_ancestry_chain_proves_a_child_from_an_owned_parent_and_replays_its_receipt() {
    let (tenant, queue) = ready();
    let receipt = located(
        event(
            "future.receipt",
            json!({ "sessionID": "child", "delta": "x" }),
        ),
        "/work",
    );
    tenant.receive_value(&receipt, 5).expect("held, not owned");
    assert_eq!(
        ports(&drain(&queue)),
        vec![(
            "http",
            r#"{"id":0,"op":"session.get","params":{"sessionID":"child"}}"#.to_owned()
        )],
        "the chain's first hop"
    );

    // child -> parent -> the root this tree owns.
    tenant.reply(
        0,
        true,
        &ace_json::to_string(&json!({
            "id": "child",
            "parentID": "parent",
            "projectID": "p1",
            "location": { "directory": "/work" },
        })),
    );
    assert_eq!(
        ports(&drain(&queue)),
        vec![(
            "http",
            r#"{"id":1,"op":"session.get","params":{"sessionID":"parent"}}"#.to_owned()
        )]
    );
    tenant.reply(
        1,
        true,
        &ace_json::to_string(&json!({
            "id": "parent",
            "parentID": "root",
            "projectID": "p1",
            "location": { "directory": "/work" },
        })),
    );

    let events = drain(&queue);
    assert!(tenant.has_session("parent") && tenant.has_session("child"));
    let framed = frames(&events);
    let snapshots: Vec<&str> = framed
        .iter()
        .filter(|(_, channel, _)| channel == "snapshot.info")
        .map(|(_, _, text)| text.as_str())
        .collect();
    assert_eq!(snapshots.len(), 2, "the chain oldest first: {snapshots:?}");
    assert!(snapshots[0].contains("\"parent\""), "{snapshots:?}");
    assert!(snapshots[1].contains("\"child\""), "{snapshots:?}");
    assert!(
        framed
            .iter()
            .any(|(dir, channel, text)| *dir == FrameDirection::Recv
                && channel == "sse"
                && text.contains("future.receipt")),
        "the held receipt replays: {framed:?}"
    );
    assert!(
        notes(&events)
            .iter()
            .any(|text| text.contains("ancestry.settled")),
        "the probe settles: {:?}",
        notes(&events)
    );
}

#[test]
fn a_chain_that_ends_at_a_root_settles_the_probe_with_nothing_admitted() {
    let (tenant, queue) = ready();
    tenant
        .receive_value(
            &located(
                event(
                    "future.receipt",
                    json!({ "sessionID": "stray", "delta": "x" }),
                ),
                "/work",
            ),
            5,
        )
        .expect("held");
    drain(&queue);
    tenant.reply(
        0,
        true,
        &ace_json::to_string(&json!({
            "id": "stray",
            "projectID": "p2",
            "location": { "directory": "/elsewhere" },
        })),
    );
    let events = drain(&queue);
    assert!(
        !frames(&events)
            .iter()
            .any(|(_, channel, _)| channel == "snapshot.info"),
        "a root with no parent admits nothing"
    );
    // A root proves nothing above it, so the receipt is dropped and the
    // receipt settles, as the TypeScript's `finish` does.
    assert!(
        notes(&events)
            .iter()
            .any(|text| text.contains("ancestry.settled")),
        "{:?}",
        notes(&events)
    );
    assert!(tenant.lock_ancestry().guard("stray").is_none());
}

#[test]
fn a_chain_whose_hop_is_refused_asks_for_a_pass() {
    let (tenant, queue) = ready();
    tenant
        .receive_value(
            &located(
                event(
                    "future.receipt",
                    json!({ "sessionID": "child", "delta": "x" }),
                ),
                "/work",
            ),
            5,
        )
        .expect("held");
    drain(&queue);
    tenant.reply(0, false, r#"{"message":"gone","status":404}"#);
    let events = drain(&queue);
    assert!(
        frames(&events)
            .iter()
            .any(|(dir, channel, _)| *dir == FrameDirection::Note
                && channel == "ancestry.unverified"),
        "{:?}",
        frames(&events)
    );
    assert_eq!(
        ports(&events)
            .into_iter()
            .filter(|(name, _)| *name == "reconcile")
            .count(),
        1
    );
    assert!(tenant.take_reconcile());
}
