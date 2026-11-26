// SPDX-License-Identifier: Apache-2.0
//! The pass's two tail handlers on the tenant (`session.ts:514`-`:572`):
//! `finalizeSnapshots`'s replay and interaction pruning, and `recovered`'s
//! settlement.

use super::{drain, event, frames, ready};
use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::SessionEvent;
use ace_json::json;

use crate::session::server::Tenant;
use crate::session::tenant::TenantError;

#[test]
fn finalize_snapshots_replays_the_pass_and_drops_interactions_it_no_longer_lists() {
    let (tenant, queue) = ready();
    tenant.disconnected(0);
    tenant
        .receive_value(
            &event(
                "permission.asked",
                json!({ "sessionID": "root", "id": "p1" }),
            ),
            1,
        )
        .expect("recorded while recovering");
    tenant
        .lock_evidence()
        .stage(
            "snapshot.interactions",
            &json!({ "sessionID": "root", "keys": [] }),
            "root",
            2,
        )
        .expect("in budget");
    tenant
        .lock_evidence()
        .stage(
            "snapshot.active",
            &json!({ "sessionID": "root", "running": true }),
            "root",
            2,
        )
        .expect("in budget");
    assert!(tenant.pending("permission:root:p1").is_some(), "recorded");
    drain(&queue);

    tenant.finalize_snapshots().expect("the pass finalizes");
    let events = drain(&queue);
    let channels: Vec<String> = frames(&events)
        .into_iter()
        .filter(|(dir, _, _)| *dir == FrameDirection::Recv)
        .map(|(_, channel, _)| channel)
        .collect();
    // The running snapshot is positive, so it replays before the rest.
    assert_eq!(channels, ["snapshot.active", "snapshot.interactions"]);
    assert!(
        tenant.pending("permission:root:p1").is_none(),
        "the snapshot no longer lists p1"
    );

    // A malformed key list fails the pass instead of clearing anything.
    let (tenant, queue) = ready();
    tenant.disconnected(0);
    tenant
        .lock_evidence()
        .stage("snapshot.interactions", &json!({ "keys": [1] }), "root", 2)
        .expect("in budget");
    drain(&queue);
    assert_eq!(
        tenant.finalize_snapshots(),
        Err(TenantError(String::from(
            "OpenCode interaction keys failed their check"
        )))
    );
}

#[test]
fn recovered_ends_the_pass_for_its_waiters_and_only_then() {
    let (tenant, queue) = ready();
    tenant.disconnected(0);
    tenant.barrier(7).expect("waits for the pass");
    tenant
        .lock_evidence()
        .stage("snapshot.active", &json!({ "running": true }), "root", 1)
        .expect("in budget");
    drain(&queue);

    tenant.recovered();
    let events = drain(&queue);
    let framed = frames(&events);
    assert!(
        framed
            .iter()
            .any(|(dir, channel, text)| *dir == FrameDirection::Note
                && channel == "lifecycle"
                && text.contains("resynced")),
        "{framed:?}"
    );
    assert!(
        !framed
            .iter()
            .any(|(_, channel, _)| channel == "snapshot.active"),
        "a settled pass emits no snapshot here"
    );
    let settled: Vec<(u64, Option<String>)> = events
        .into_iter()
        .filter_map(|event| match event {
            SessionEvent::Settle { id, result } => {
                Some((id, result.err().map(|error| error.message)))
            }
            _ => None,
        })
        .collect();
    assert_eq!(settled, vec![(7, None)], "the barrier is released");
    assert!(!tenant.recovering());
    assert!(
        tenant.lock_evidence().positive().is_empty(),
        "the epoch's evidence is reset"
    );
}
