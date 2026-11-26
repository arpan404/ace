// SPDX-License-Identifier: Apache-2.0
//! The tenant-driven statements a chunk runs: a recovery begun inside the loop
//! (`server.ts:413`-`:454`), a tenant's refusal, and a pass that cannot finish.

use super::{core, delta, event};
use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{EventQueue, ReadGate, SessionEvent};
use ace_json::{Value, json};
use std::sync::Arc;

use crate::session::error::StreamError;
use crate::session::server::{ServerCore, Tenant, TenantError};
use crate::session::testing::{Call, Fake};

#[test]
fn a_tenant_that_asks_for_recovery_is_disconnected_before_another_fails_the_scan() {
    let mut server = core(&[]);
    let asking = Arc::new(Fake::all());
    let refusing = Arc::new(Fake::refusing("OpenCode shell limit"));
    server.subscribe(asking.clone()).expect("asking");
    server.subscribe(refusing.clone()).expect("refusing");
    // The first tenant's accept overflowed its ancestry buffer and asked for a
    // pass (`session.ts:122`); the second refuses the same event. The
    // TypeScript has already disconnected both before the refusal returns.
    asking.ask_reconcile();
    let outcome = server.chunk(
        event(
            "e",
            "session.text.delta",
            json!({ "sessionID": "asking", "delta": "x" }),
        )
        .as_bytes(),
    );
    assert_eq!(
        outcome.failed,
        Some(StreamError::Tenant(String::from("OpenCode shell limit")))
    );
    assert!(
        outcome.recover,
        "the pass the accept asked for is requested"
    );
    assert!(server.recovering(), "the server began the pass");
    assert_eq!(asking.calls(), vec![Call::Disconnected(1)]);
    assert_eq!(refusing.calls(), vec![Call::Disconnected(1)]);
}

/// One envelope with an event-level location, as `location.shutdown` carries.
fn located(id: &str, kind: &str, data: Value, directory: &str) -> String {
    format!(
        "data: {}\n\n",
        crate::session::server::tests::serialized(json!({
            "id": id,
            "type": kind,
            "data": data,
            "location": { "directory": directory },
        }))
    )
}

/// A real tenant whose root is established at `/work`, subscribed to `server`.
fn subscribe_real(
    server: &mut ServerCore,
    queue: &EventQueue,
) -> Arc<crate::session::tenant::OpenCodeTenant> {
    let tenant = Arc::new(crate::session::tenant::OpenCodeTenant::new(
        queue.clone(),
        crate::session::tenant::TenantConfig {
            cwd: String::from("/work"),
            root_key: String::from("root"),
            resume: String::new(),
            bearer: None,
            secrets: Vec::new(),
        },
    ));
    tenant.finish_opening(0).expect("no held events");
    tenant
        .lock_ownership()
        .establish(&json!({
            "id": "root",
            "projectID": "p1",
            "location": { "directory": "/work" },
        }))
        .expect("the root establishes");
    server
        .subscribe(Arc::clone(&tenant) as Arc<dyn Tenant>)
        .expect("tenant");
    tenant
}

/// The tenant's frames and settles, as the core published them.
fn drained(queue: &EventQueue) -> Vec<SessionEvent> {
    queue.take_batch(usize::MAX, usize::MAX)
}

fn channels(events: &[SessionEvent]) -> Vec<(FrameDirection, String)> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Frame {
                dir, channel, text, ..
            } => Some((*dir, format!("{channel}:{text}"))),
            _ => None,
        })
        .collect()
}

#[test]
fn a_location_shutdown_begins_recovery_inside_the_chunk() {
    let mut server = core(&[]);
    let queue = EventQueue::new(ReadGate::new());
    subscribe_real(&mut server, &queue);

    let chunk = format!(
        "{}{}",
        located("s1", "location.shutdown", json!({}), "/work"),
        event(
            "s2",
            "session.execution.succeeded",
            json!({ "sessionID": "root" })
        ),
    );
    let outcome = server.chunk(chunk.as_bytes());

    assert_eq!(outcome.failed, None);
    assert!(outcome.recover, "the shutdown asks for the pass");
    assert!(
        server.recovering(),
        "beginRecovery ran before the chunk ended"
    );
    let published = channels(&drained(&queue));
    assert_eq!(
        published
            .iter()
            .filter(|(dir, channel)| *dir == FrameDirection::Recv && channel.starts_with("sse:"))
            .count(),
        1,
        "only the shutdown was delivered: {published:?}"
    );
    let notes: Vec<&str> = published
        .iter()
        .filter(|(dir, _)| *dir == FrameDirection::Note)
        .map(|(_, channel)| channel.as_str())
        .collect();
    assert!(
        notes.contains(&"lifecycle:{\"type\":\"disconnected\",\"reason\":\"location rebuilt\"}"),
        "{notes:?}"
    );
    assert!(
        notes.contains(&"lifecycle:{\"type\":\"disconnected\"}"),
        "the server's own disconnect: {notes:?}"
    );
    assert!(
        notes
            .iter()
            .any(|note| note.starts_with("recovery.buffered:")),
        "the event after the shutdown is buffered: {notes:?}"
    );
}

#[test]
fn a_receipt_past_the_probe_bound_begins_recovery_before_the_next_event() {
    let mut server = core(&[]);
    let queue = EventQueue::new(ReadGate::new());
    subscribe_real(&mut server, &queue);

    // Nine unowned children in the directory: the ninth exceeds the eight
    // probes and asks for a pass from inside `routes.select`.
    let mut chunk = String::new();
    for index in 0..=8 {
        chunk.push_str(&located(
            &format!("e{index}"),
            "session.text.delta",
            json!({ "sessionID": format!("c{index}"), "delta": "x" }),
            "/work",
        ));
    }
    chunk.push_str(&delta("root", "after"));
    let outcome = server.chunk(chunk.as_bytes());

    assert_eq!(outcome.failed, None);
    assert!(outcome.recover);
    assert!(server.recovering());
    let published = channels(&drained(&queue));
    let notes: Vec<&str> = published
        .iter()
        .filter(|(dir, _)| *dir == FrameDirection::Note)
        .map(|(_, channel)| channel.as_str())
        .collect();
    assert!(
        notes.contains(
            &"lifecycle:{\"type\":\"disconnected\",\"reason\":\"ancestry verification incomplete\"}"
        ),
        "{notes:?}"
    );
    assert!(
        notes
            .iter()
            .any(|note| note.starts_with("recovery.buffered:")),
        "the root's later event is buffered: {notes:?}"
    );
    assert!(
        !published.iter().any(|(dir, channel)| {
            *dir == FrameDirection::Recv && channel.contains("\"text\":\"after\"")
        }),
        "the later event was not delivered: {published:?}"
    );
}

#[test]
fn an_open_codes_shell_limit_fails_the_stream_at_the_2049th_shell() {
    let mut server = core(&[]);
    let queue = EventQueue::new(ReadGate::new());
    subscribe_real(&mut server, &queue);

    let mut chunk = String::new();
    for index in 0..=2048 {
        chunk.push_str(&located(
            &format!("e{index}"),
            "shell.created",
            json!({
                "sessionID": "root",
                "info": { "id": format!("sh{index}"), "status": "running" },
            }),
            "/work",
        ));
    }
    let outcome = server.chunk(chunk.as_bytes());

    assert_eq!(
        outcome.failed,
        Some(StreamError::Tenant(String::from("OpenCode shell limit")))
    );
    let delivered = channels(&drained(&queue))
        .iter()
        .filter(|(dir, channel)| *dir == FrameDirection::Recv && channel.starts_with("sse:"))
        .count();
    assert_eq!(delivered, 2048, "the 2,049th shell is never delivered");
}

#[test]
fn a_tenant_that_refuses_an_event_fails_the_stream() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::refusing("OpenCode shell limit"));
    server.subscribe(a).expect("tenant");
    let outcome = server.chunk(delta("a", "one").as_bytes());
    assert_eq!(
        outcome.failed,
        Some(StreamError::Tenant(String::from("OpenCode shell limit")))
    );
}

#[test]
fn a_pass_that_cannot_finalize_keeps_recovery_and_replays_again() {
    let mut server = core(&[]);
    let a = Arc::new(Fake::session("a"));
    server.subscribe(a.clone()).expect("tenant");
    server.begin_recovery(0);
    server.chunk(delta("a", "one").as_bytes());

    a.fail_finalize(Some("Provider payload exceeds byte limit"));
    assert_eq!(
        server.replay(),
        Err(TenantError(String::from(
            "Provider payload exceeds byte limit"
        )))
    );
    assert!(server.recovering(), "a rejected pass never settles");
    assert!(
        !a.calls().contains(&Call::Recovered),
        "no resynced and no barrier release: {:?}",
        a.calls()
    );

    // The retry replays the same buffer, and only then settles.
    a.fail_finalize(None);
    assert!(server.replay().expect("replay"));
    assert!(!server.recovering());
    assert_eq!(
        a.calls()
            .iter()
            .filter(|call| matches!(call, Call::Reconcile(..)))
            .count(),
        2,
        "the buffer was kept: {:?}",
        a.calls()
    );
    assert_eq!(a.calls().last(), Some(&Call::Recovered));
}
