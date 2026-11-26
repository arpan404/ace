// SPDX-License-Identifier: Apache-2.0
//! `resync` and `prepareReplay` on the tenant (`session.ts:508`-`:572`): the one
//! read in flight, its `http` ports, the settle that ends it, and the positive
//! snapshots the replay emits before the probes reconcile.

use ace_adapter_api::FrameDirection;
use ace_adapter_api::bridge::{EventQueue, SessionEvent};
use ace_json::{Value, json};

use super::super::recovery::RECOVERY_FAILED;
use super::{drain, frames, ready};
use crate::session::tenant::OpenCodeTenant;

/// One `http` port, as the facade sees it.
fn http(event: &SessionEvent) -> Option<(u64, String, Value)> {
    let SessionEvent::Port { name, json: text } = event else {
        return None;
    };
    if *name != "http" {
        return None;
    }
    let value = ace_json::parse(text).expect("a port's json");
    let id = value.get("id").and_then(Value::as_u64).expect("an id");
    let op = value
        .get("op")
        .and_then(Value::as_str)
        .expect("an op")
        .to_owned();
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    Some((id, op, params))
}

/// The reply the tenant's default answers give one request.
fn answer(op: &str, params: &Value) -> (bool, Value) {
    match op {
        "session.get" => (
            true,
            json!({
                "id": "root",
                "projectID": "p1",
                "location": { "directory": "/work" },
            }),
        ),
        "session.list" | "message.list" => {
            (true, json!({ "data": [], "cursor": { "next": null } }))
        }
        "session.active" => (true, json!({})),
        "shell.list" => {
            let directory = params
                .get("location")
                .and_then(|location| location.get("directory"))
                .cloned()
                .unwrap_or(Value::Null);
            (
                true,
                json!({ "location": { "directory": directory }, "data": [] }),
            )
        }
        _ => (true, json!([])),
    }
}

/// Answers every `http` port until the tenant stops asking, as the facade does.
fn walk(
    tenant: &OpenCodeTenant,
    queue: &EventQueue,
    mut respond: impl FnMut(&str, &Value) -> (bool, Value),
) -> Vec<SessionEvent> {
    let mut all = Vec::new();
    for _ in 0..128 {
        let events = drain(queue);
        let ports: Vec<(u64, String, Value)> = events.iter().filter_map(http).collect();
        all.extend(events);
        if ports.is_empty() {
            return all;
        }
        for (id, op, params) in ports {
            let (ok, body) = respond(&op, &params);
            tenant.reply(id, ok, &ace_json::to_string(&body));
        }
    }
    panic!("the pass never settled");
}

fn settled(events: &[SessionEvent]) -> Vec<(u64, Result<String, String>)> {
    events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Settle { id, result } => Some((
                *id,
                match result {
                    Ok(text) => Ok(text.clone()),
                    Err(error) => Err(format!("{}:{}", error.code, error.message)),
                },
            )),
            _ => None,
        })
        .collect()
}

#[test]
fn resync_asks_for_the_root_snapshot_and_settles_after_the_whole_walk() {
    let (tenant, queue) = ready();
    tenant.set_watermark(3);
    tenant.resync(11);
    let first = drain(&queue);
    let (id, op, params) = first.iter().find_map(http).expect("the root's get");
    assert_eq!(
        (op.clone(), params.clone()),
        (String::from("session.get"), json!({ "sessionID": "root" }))
    );

    // The second `resync` joins the read in flight instead of starting another.
    tenant.resync(12);
    assert!(drain(&queue).is_empty(), "no second read");
    let (ok, body) = answer(&op, &params);
    tenant.reply(id, ok, &ace_json::to_string(&body));

    let events = walk(&tenant, &queue, answer);
    assert_eq!(
        settled(&events),
        vec![
            (11, Ok(String::from("null"))),
            (12, Ok(String::from("null")))
        ],
        "both callers settle with the one read"
    );
    let framed = frames(&events);
    assert!(
        framed
            .iter()
            .any(|(dir, channel, text)| *dir == FrameDirection::Recv
                && channel == "snapshot.info"
                && text.contains(r#""recovering":true"#)),
        "the root's own snapshot is framed: {framed:?}"
    );
    assert!(
        tenant.lock_evidence().complete("root"),
        "the pass staged the session's active and interaction snapshots"
    );
}

#[test]
fn a_refused_read_settles_its_callers_with_the_refusal() {
    let (tenant, queue) = ready();
    tenant.set_watermark(3);
    tenant.resync(4);
    let events = walk(&tenant, &queue, |op, params| {
        if op == "session.get" {
            return (
                false,
                json!({ "message": "OpenCode session not found", "status": 404 }),
            );
        }
        answer(op, params)
    });
    assert_eq!(
        settled(&events),
        vec![(
            4,
            Err(format!("{RECOVERY_FAILED}:OpenCode session not found")),
        )]
    );
}

#[test]
fn prepare_replay_emits_the_running_snapshot_then_settles() {
    let (tenant, queue) = ready();
    tenant
        .lock_evidence()
        .stage(
            "snapshot.active",
            &json!({ "sessionID": "root", "running": true }),
            "root",
            1,
        )
        .expect("in budget");
    drain(&queue);
    tenant.prepare_replay(9);
    let events = drain(&queue);
    let channels: Vec<String> = frames(&events)
        .into_iter()
        .filter(|(dir, _, _)| *dir == FrameDirection::Recv)
        .map(|(_, channel, _)| channel)
        .collect();
    assert_eq!(channels, ["snapshot.active"]);
    assert_eq!(settled(&events), vec![(9, Ok(String::from("null")))]);
    assert!(
        tenant.lock_evidence().positive().is_empty(),
        "the positive snapshots were emitted once"
    );
}

#[test]
fn a_reply_after_close_is_dropped() {
    let (tenant, queue) = ready();
    tenant.set_watermark(3);
    tenant.resync(1);
    let id = drain(&queue)
        .iter()
        .find_map(http)
        .map(|(id, _, _)| id)
        .expect("the root's get");
    tenant.close();
    drain(&queue);
    tenant.reply(id, true, "{}");
    assert!(
        drain(&queue).is_empty(),
        "a closed tenant publishes nothing for a reply"
    );
}
