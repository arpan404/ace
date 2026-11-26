// SPDX-License-Identifier: Apache-2.0
//! The tenant's per-event state: the opening buffer, interactions, locations,
//! moves, the closed filter, ports and the payload bound.

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionEvent};
use ace_json::{Value, json};

use super::{OpenCodeTenant, TenantConfig, TenantError};
use crate::session::server::Tenant;
use crate::translate::boundaries::parse_native_event;

/// `owns`, with the envelope check the server does first.
fn owns(tenant: &OpenCodeTenant, data: &Value, watermark: u64) -> bool {
    let event = parse_native_event(data).expect("a valid envelope");
    tenant.owns(&event, data, watermark).expect("in bounds")
}

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

fn delta(session: &str, text: &str) -> Value {
    event(
        "session.text.delta",
        json!({ "sessionID": session, "assistantMessageID": "m", "ordinal": 0, "delta": text }),
    )
}

/// A tenant with its root established and the opening phase over.
fn ready() -> (OpenCodeTenant, EventQueue) {
    let queue = EventQueue::new(ReadGate::new());
    let tenant = OpenCodeTenant::new(
        queue.clone(),
        TenantConfig {
            cwd: String::from("/work"),
            root_key: String::from("root"),
            resume: String::new(),
            bearer: Some(String::from("bearer-1")),
            secrets: vec![String::from("sk-1")],
        },
    );
    tenant.finish_opening(1).expect("no held events");
    tenant
        .lock_ownership()
        .establish(&snapshot("root", "", "/work", "p1"))
        .expect("the root establishes");
    (tenant, queue)
}

fn drain(queue: &EventQueue) -> Vec<SessionEvent> {
    queue.take_batch(usize::MAX, usize::MAX)
}

fn frames(events: &[SessionEvent]) -> Vec<(FrameDirection, String, String)> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Frame {
                dir, channel, text, ..
            } => Some((*dir, channel.clone(), text.clone())),
            _ => None,
        })
        .collect()
}

fn ports(events: &[SessionEvent]) -> Vec<(&'static str, String)> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Port { name, json } => Some((*name, json.clone())),
            _ => None,
        })
        .collect()
}

#[test]
fn the_opening_buffer_holds_events_and_replays_them_in_order() {
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
    tenant
        .lock_ownership()
        .establish(&snapshot("root", "", "/work", "p1"))
        .expect("the root establishes");
    tenant
        .receive_value(&delta("root", "one"), 1)
        .expect("buffered");
    tenant
        .receive_value(&delta("root", "two"), 2)
        .expect("buffered");
    assert!(drain(&queue).is_empty(), "nothing is emitted while opening");

    tenant.finish_opening(3).expect("replay");
    let frames = frames(&drain(&queue));
    assert_eq!(frames.len(), 2);
    assert!(frames[0].2.contains("\"one\""));
    assert!(frames[1].2.contains("\"two\""));

    // The 128th event is the last one the buffer takes.
    let queue = EventQueue::new(ReadGate::new());
    let tenant = OpenCodeTenant::new(
        queue,
        TenantConfig {
            cwd: String::from("/work"),
            root_key: String::from("root"),
            resume: String::new(),
            bearer: None,
            secrets: Vec::new(),
        },
    );
    for index in 0..128 {
        tenant
            .receive_value(&delta("root", &index.to_string()), index as u64)
            .expect("under the bound");
    }
    assert_eq!(
        tenant.receive_value(&delta("root", "over"), 200),
        Err(TenantError(String::from("OpenCode startup event limit")))
    );
}

#[test]
fn interactions_are_recorded_and_cleared_by_their_replies() {
    let (tenant, queue) = ready();
    tenant
        .receive_value(
            &event(
                "permission.asked",
                json!({ "sessionID": "root", "id": "p1" }),
            ),
            1,
        )
        .expect("asked");
    let pending = tenant.pending("permission:root:p1").expect("pending");
    assert_eq!(pending.session, "root");
    assert_eq!(pending.kind, "permission.asked");
    assert!(
        frames(&drain(&queue)).iter().any(|frame| frame.1 == "sse"),
        "the event is framed"
    );

    tenant
        .receive_value(
            &event(
                "permission.replied",
                json!({ "sessionID": "root", "requestID": "p1" }),
            ),
            2,
        )
        .expect("replied");
    assert!(tenant.pending("permission:root:p1").is_none());

    // A form answer without requestID falls back to `id`.
    tenant
        .receive_value(
            &event(
                "form.created",
                json!({ "sessionID": "root", "form": { "id": "f1", "sessionID": "root" } }),
            ),
            3,
        )
        .expect("created");
    assert!(tenant.pending("form:root:f1").is_some());
    tenant
        .receive_value(
            &event("form.cancelled", json!({ "sessionID": "root", "id": "f1" })),
            4,
        )
        .expect("cancelled");
    assert!(tenant.pending("form:root:f1").is_none());
}

#[test]
fn a_rebuilt_location_forgets_the_mcp_location_and_asks_for_recovery() {
    let (tenant, queue) = ready();
    tenant
        .receive_value(
            &event(
                "permission.asked",
                json!({ "sessionID": "root", "id": "p1" }),
            ),
            1,
        )
        .expect("asked");
    drain(&queue);
    let mut shutdown = event("location.shutdown", json!({}));
    if let Value::Object(map) = &mut shutdown {
        map.insert("location", json!({ "directory": "/work" }));
    }
    tenant.receive_value(&shutdown, 2).expect("shutdown");

    let events = drain(&queue);
    let port_names: Vec<&str> = ports(&events).iter().map(|(name, _)| *name).collect();
    assert_eq!(port_names, vec!["mcp.forget", "reconcile"]);
    assert_eq!(ports(&events)[0].1, r#"{"directory":"/work"}"#);
    assert!(tenant.recovering());
    assert!(tenant.pending("permission:root:p1").is_none());
    let lifecycle: Vec<String> = frames(&events)
        .into_iter()
        .filter(|frame| frame.1 == "lifecycle")
        .map(|frame| frame.2)
        .collect();
    assert_eq!(
        lifecycle,
        vec![r#"{"type":"disconnected","reason":"location rebuilt"}"#.to_owned()]
    );
}

#[test]
fn a_session_moved_refetch_is_asked_once_until_it_is_answered() {
    let (tenant, queue) = ready();
    let moved = event("session.moved", json!({ "sessionID": "root" }));
    tenant.receive_value(&moved, 1).expect("moved");
    tenant.receive_value(&moved, 2).expect("moved again");
    let asked: Vec<String> = ports(&drain(&queue))
        .into_iter()
        .filter(|(name, _)| *name == "session.moved")
        .map(|(_, json)| json)
        .collect();
    assert_eq!(asked, vec![r#"{"sessionID":"root"}"#.to_owned()]);

    tenant.moved_done("root");
    tenant.receive_value(&moved, 3).expect("moved once more");
    assert_eq!(
        ports(&drain(&queue))
            .into_iter()
            .filter(|(name, _)| *name == "session.moved")
            .count(),
        1
    );
}

#[test]
fn a_moved_reply_whose_snapshot_cannot_be_framed_asks_for_a_pass() {
    let (tenant, queue) = ready();
    tenant
        .receive_value(&event("session.moved", json!({ "sessionID": "root" })), 1)
        .expect("moved");
    drain(&queue);

    // The snapshot verifies, but its frame is past the payload bound, so the
    // location it named was never recorded.
    let mut body = snapshot("root", "", "/work", "p1");
    if let Value::Object(map) = &mut body {
        map.insert("title".to_owned(), json!("a".repeat(1024 * 1024)));
    }
    tenant.moved_reply("root", true, &body);
    let events = drain(&queue);
    assert_eq!(
        ports(&events)
            .into_iter()
            .filter(|(name, _)| *name == "reconcile")
            .count(),
        1,
        "the refusal is the TypeScript's catch"
    );
    assert!(
        !frames(&events)
            .iter()
            .any(|frame| frame.1 == "snapshot.info"),
        "nothing was framed"
    );

    // The move id was released: a later move asks again.
    tenant
        .receive_value(&event("session.moved", json!({ "sessionID": "root" })), 2)
        .expect("moved again");
    assert_eq!(
        ports(&drain(&queue))
            .into_iter()
            .filter(|(name, _)| *name == "session.moved")
            .count(),
        1
    );
}

#[test]
fn catalog_changed_is_a_port_for_its_six_types_only() {
    let (tenant, queue) = ready();
    tenant
        .receive_value(&event("config.updated", json!({ "sessionID": "root" })), 1)
        .expect("config");
    tenant
        .receive_value(&delta("root", "x"), 2)
        .expect("a delta");
    let asked: Vec<String> = ports(&drain(&queue))
        .into_iter()
        .filter(|(name, _)| *name == "catalog.changed")
        .map(|(_, json)| json)
        .collect();
    assert_eq!(asked, vec![r#"{"type":"config.updated"}"#.to_owned()]);
}

#[test]
fn a_frame_past_the_payload_bound_fails_and_publishes_nothing() {
    let (tenant, queue) = ready();
    let huge = delta("root", &"a".repeat(1024 * 1024));
    assert_eq!(
        tenant.receive_value(&huge, 1),
        Err(TenantError(String::from(
            "Provider payload exceeds byte limit"
        )))
    );
    assert!(drain(&queue).is_empty());
}

#[test]
fn the_bearer_is_replaced_in_the_frame_text_only() {
    let (tenant, queue) = ready();
    tenant
        .receive_value(&delta("root", "has bearer-1 and sk-1"), 1)
        .expect("a delta");
    let frames = frames(&drain(&queue));
    assert_eq!(frames.len(), 1);
    assert!(frames[0].2.contains("[REDACTED]"), "{}", frames[0].2);
    assert!(!frames[0].2.contains("bearer-1"), "{}", frames[0].2);
    assert!(!frames[0].2.contains("sk-1"), "{}", frames[0].2);
}

#[test]
fn a_closed_session_keeps_only_its_ending_notes() {
    let (tenant, queue) = ready();
    tenant.close();
    assert!(!owns(&tenant, &delta("root", "x"), 1));
    assert!(
        tenant
            .emit(
                FrameDirection::Note,
                "lifecycle",
                &json!({ "type": "resynced" })
            )
            .is_ok()
    );
    assert!(drain(&queue).is_empty(), "only ending notes survive");

    tenant
        .emit(
            FrameDirection::Note,
            "lifecycle",
            &json!({ "type": "exited", "deliberate": true }),
        )
        .expect("the exit is recorded");
    let frames = frames(&drain(&queue));
    assert_eq!(frames.len(), 1);
    assert!(frames[0].2.contains("\"exited\""));
}

#[test]
fn a_shell_exit_drops_the_shell_it_names() {
    let (tenant, queue) = ready();
    tenant
        .receive_value(
            &event(
                "shell.created",
                json!({ "sessionID": "root", "info": { "id": "sh1", "status": "running" } }),
            ),
            1,
        )
        .expect("created");
    assert!(tenant.shells().contains_key("sh1"));
    tenant
        .receive_value(
            &event("shell.exited", json!({ "sessionID": "root", "id": "sh1" })),
            2,
        )
        .expect("exited");
    assert!(!tenant.shells().contains_key("sh1"));
    let _ = drain(&queue);
}

mod scenarios;

/// An envelope with its own id, so the translator's dedupe keeps every event.
fn numbered(id: &str, kind: &str, data: Value) -> Value {
    json!({ "id": id, "type": kind, "data": data })
}

#[test]
fn a_recovery_pass_never_settles_a_session_whose_child_interaction_or_shell_still_works() {
    let (tenant, queue) = ready();
    let root = json!({
        "sessionID": "root",
        "projectID": "p1",
        "location": { "directory": "/work" },
    });
    let child = json!({
        "sessionID": "child",
        "parentID": "root",
        "projectID": "p1",
        "location": { "directory": "/work" },
    });
    for (id, kind, data) in [
        ("e1", "session.created", root),
        ("e2", "session.created", child),
        (
            "e3",
            "session.execution.started",
            json!({ "sessionID": "child" }),
        ),
        (
            "e4",
            "permission.asked",
            json!({ "sessionID": "root", "id": "p1" }),
        ),
        (
            "e5",
            "shell.created",
            json!({
                "sessionID": "root",
                "info": { "id": "sh1", "status": "running", "metadata": { "sessionID": "root" } },
            }),
        ),
    ] {
        tenant
            .receive_value(&numbered(id, kind, data), 1)
            .unwrap_or_else(|error| panic!("{kind}: {error}"));
    }
    drain(&queue);
    assert!(!tenant.is_settled(), "a child turn is live");

    // A pass begins and finishes; none of that work was the pass's to settle.
    tenant.disconnected(0);
    tenant.finalize_snapshots().expect("the pass finalizes");
    assert!(!tenant.is_settled(), "a recovering session is not settled");
    assert!(tenant.pending("permission:root:p1").is_some());
    assert!(tenant.live_shell("sh1"));
    tenant.recovered();
    assert!(!tenant.is_settled(), "the pass keeps the guards");

    // Each guard settles on its own event, and only then is the session done.
    tenant
        .receive_value(
            &numbered(
                "e6",
                "session.execution.succeeded",
                json!({ "sessionID": "child" }),
            ),
            2,
        )
        .expect("the turn ends");
    assert!(
        !tenant.is_settled(),
        "the interaction and shell still hold it"
    );
    tenant
        .receive_value(
            &numbered(
                "e7",
                "permission.replied",
                json!({ "sessionID": "root", "requestID": "p1" }),
            ),
            3,
        )
        .expect("the interaction answers");
    assert!(!tenant.is_settled(), "the shell still holds it");
    tenant
        .receive_value(
            &numbered(
                "e8",
                "shell.exited",
                json!({ "sessionID": "root", "id": "sh1" }),
            ),
            4,
        )
        .expect("the shell exits");
    assert!(tenant.is_settled(), "nothing is left to wait on");
    let _ = drain(&queue);
}
