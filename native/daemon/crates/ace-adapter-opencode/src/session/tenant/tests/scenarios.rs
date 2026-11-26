// SPDX-License-Identifier: Apache-2.0
//! The tenant's per-event scenarios: an ancestry receipt into this session's
//! frames (`session.ts:129`-`:137`), the reply inputs the facade feeds back
//! (`:98`, `:277`, `:345`-`:362`), and the barrier's two closed messages.

use super::{drain, event, frames, ports, ready, snapshot};
use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionEvent};
use ace_json::{Value, json};

use super::OpenCodeTenant;
use crate::session::ancestry::ProbeHost;
use crate::session::server::Tenant;
use crate::session::tenant::{TenantConfig, TenantError};

/// The value with an envelope-level `location`, for the events that carry one.
fn located(mut value: Value, directory: &str) -> Value {
    if let Value::Object(map) = &mut value {
        map.insert("location", json!({ "directory": directory }));
    }
    value
}

fn notes(events: &[SessionEvent]) -> Vec<String> {
    frames(events)
        .into_iter()
        .filter(|(dir, _, _)| *dir == FrameDirection::Note)
        .map(|(_, _, text)| text)
        .collect()
}

#[test]
fn an_unknown_childs_receipt_is_noted_before_its_lookup() {
    let (tenant, queue) = ready();
    // The provider elides a heavy value before the tenant sees it; what is left
    // can still be nearly a whole payload, and the receipt keeps its identity
    // (`ancestry-receipts.process.test.ts:52`).
    let receipt = located(
        json!({
            "id": "receipt-1",
            "type": "future.opaque-receipt",
            "data": {
                "sessionID": "child",
                "vendor": { "opaque": "x".repeat(1024 * 1024 - 512) },
            },
        }),
        "/work",
    );
    tenant.receive_value(&receipt, 7).expect("not this tree's");

    let events = drain(&queue);
    let noted = notes(&events);
    let buffered = noted
        .iter()
        .find(|text| text.contains("future.opaque-receipt"))
        .expect("the receipt is noted before its lookup");
    let parsed: Value = ace_json::parse(buffered).expect("the note is JSON");
    assert_eq!(parsed["id"], json!("receipt-1"));
    assert_eq!(parsed["type"], json!("future.opaque-receipt"));
    assert_eq!(parsed["data"]["sessionID"], json!("child"));
    assert_eq!(parsed["created"], Value::Null, "only what arrived");
    assert!(
        buffered.len() > 1024 * 1024 - 1024,
        "the whole elided receipt, {} bytes",
        buffered.len()
    );
    assert!(
        noted.iter().any(|text| text.contains("ancestry.pending")),
        "{noted:?}"
    );
    assert_eq!(
        ports(&events),
        vec![(
            "ancestry",
            r#"{"id":"child","guard":"ancestry:1"}"#.to_owned()
        )]
    );
    assert!(
        !frames(&events)
            .iter()
            .any(|(dir, _, _)| *dir == FrameDirection::Recv),
        "an unowned receipt is not delivered"
    );
}

#[test]
fn a_covered_receipt_is_not_replayed_while_recovering() {
    let (tenant, queue) = ready();
    tenant.disconnected(0);
    let asked = event(
        "permission.asked",
        json!({ "sessionID": "root", "id": "p1" }),
    );
    <OpenCodeTenant as ProbeHost>::buffered(&tenant, &asked, 3);
    tenant
        .lock_evidence()
        .stage("snapshot.interactions", &json!({ "keys": [] }), "root", 3)
        .expect("in budget");
    assert!(
        frames(&drain(&queue))
            .iter()
            .any(|(dir, channel, _)| *dir == FrameDirection::Note
                && channel == "ancestry.buffered"),
        "the receipt is noted while no pass runs too"
    );

    // A snapshot that no longer lists the interaction already covers it.
    <OpenCodeTenant as ProbeHost>::receive(&tenant, &asked, 3).expect("covered");
    assert!(drain(&queue).is_empty(), "covered evidence is not replayed");

    // Past the snapshot's start it is not covered, so it is delivered.
    <OpenCodeTenant as ProbeHost>::receive(&tenant, &asked, 4).expect("uncovered");
    let after = frames(&drain(&queue));
    assert_eq!(after.len(), 1, "{after:?}");

    // Not recovering, the receipt is delivered even where a snapshot covers it.
    tenant.recovered();
    drain(&queue);
    <OpenCodeTenant as ProbeHost>::receive(&tenant, &asked, 3).expect("not recovering");
    assert_eq!(frames(&drain(&queue)).len(), 1);
}

#[test]
fn a_moved_reply_verifies_the_session_and_releases_its_id() {
    let (tenant, queue) = ready();
    let moved = event("session.moved", json!({ "sessionID": "root" }));
    tenant.receive_value(&moved, 1).expect("moved");
    drain(&queue);

    tenant.moved_reply("root", true, &snapshot("root", "", "/work", "p1"));
    let events = drain(&queue);
    let framed: Vec<_> = frames(&events)
        .into_iter()
        .filter(|(dir, _, _)| *dir == FrameDirection::Recv)
        .collect();
    assert_eq!(framed.len(), 1);
    assert_eq!(framed[0].1, "snapshot.info");
    let info: Value = ace_json::parse(&framed[0].2).expect("JSON");
    assert_eq!(info["info"]["id"], json!("root"));
    assert_eq!(
        info["root"],
        Value::Null,
        "only the opening snapshot is root"
    );
    assert!(ports(&events).is_empty(), "no reconcile: it verified");

    // The id was released, so the next move asks again.
    tenant.receive_value(&moved, 2).expect("moved again");
    assert_eq!(
        ports(&drain(&queue))
            .into_iter()
            .filter(|(name, _)| *name == "session.moved")
            .count(),
        1
    );
}

#[test]
fn a_refused_moved_reply_asks_for_recovery_instead() {
    for (ok, body) in [
        (false, json!({})),
        (
            true,
            json!({ "id": "ghost", "projectID": "p1", "location": { "directory": "/work" } }),
        ),
        (true, json!({ "id": "root" })),
    ] {
        let (tenant, queue) = ready();
        tenant.moved_reply("root", ok, &body);
        let events = drain(&queue);
        assert!(
            !frames(&events)
                .iter()
                .any(|(_, channel, _)| channel == "snapshot.info"),
            "{body}"
        );
        assert_eq!(
            ports(&events)
                .into_iter()
                .filter(|(name, _)| *name == "reconcile")
                .count(),
            1,
            "{body}"
        );
        assert!(tenant.take_reconcile(), "the core begins the pass: {body}");
        assert!(
            !tenant.recovering(),
            "beginRecovery is the server's: {body}"
        );
    }
}

#[test]
fn the_root_snapshot_is_established_and_framed_with_its_root_mark() {
    let queue = EventQueue::new(ReadGate::new());
    let tenant = OpenCodeTenant::new(
        queue.clone(),
        TenantConfig {
            cwd: String::from("/work"),
            root_key: String::from("root"),
            resume: String::new(),
            bearer: None,
            secrets: Vec::new(),
        },
    );
    let info = snapshot("root", "", "/work", "p1");
    tenant.establish_root(&info).expect("the root establishes");
    assert_eq!(tenant.root(), "root");
    assert!(tenant.has_session("root"));

    tenant.root_snapshot(&info).expect("framed");
    let framed = frames(&drain(&queue));
    assert_eq!(framed.len(), 1);
    assert_eq!(framed[0].1, "snapshot.info");
    let value: Value = ace_json::parse(&framed[0].2).expect("JSON");
    assert_eq!(value["root"], json!(true));
    assert_eq!(value["info"]["id"], json!("root"));

    assert!(
        tenant
            .establish_root(&snapshot("other", "", "/elsewhere", "p1"))
            .is_err(),
        "a snapshot for another directory never establishes"
    );
}

#[test]
fn a_child_that_cannot_be_admitted_is_noted_as_stopped() {
    let (tenant, queue) = ready();
    tenant
        .admit_stopped("child", "environment refused")
        .expect("noted");
    let framed = frames(&drain(&queue));
    assert_eq!(framed.len(), 1);
    assert_eq!(framed[0].0, FrameDirection::Note);
    assert_eq!(framed[0].1, "agent.environment");
    assert_eq!(
        ace_json::parse(&framed[0].2).expect("JSON"),
        json!({ "type": "stopped", "sessionID": "child", "message": "environment refused" })
    );
}

#[test]
fn a_closed_session_says_is_closed_but_a_waiting_barrier_says_closed() {
    let (tenant, _queue) = ready();
    tenant.close();
    assert_eq!(
        tenant.barrier(1),
        Err(TenantError(String::from("OpenCode session is closed")))
    );

    // A pass in flight holds the barrier; closing rejects it as `shutdown` does.
    let (tenant, queue) = ready();
    tenant.reconcile_location();
    assert!(tenant.recovering());
    tenant.barrier(2).expect("waits for the pass");
    drain(&queue);
    tenant.close();
    let settled: Vec<(u64, Option<String>)> = drain(&queue)
        .into_iter()
        .filter_map(|event| match event {
            SessionEvent::Settle { id, result } => {
                Some((id, result.err().map(|error| error.message)))
            }
            _ => None,
        })
        .collect();
    assert_eq!(settled.len(), 1);
    assert_eq!(settled[0].0, 2);
    assert_eq!(settled[0].1.as_deref(), Some("OpenCode session closed"));
}
