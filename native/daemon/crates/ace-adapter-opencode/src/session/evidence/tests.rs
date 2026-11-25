// SPDX-License-Identifier: Apache-2.0
//! `RecoveryEvidence` against `recovery-evidence.ts`: delta coverage from
//! snapshots, the absence clocks, the bounds and the shell clock.

use ace_json::{Value, json};

use super::{EvidenceError, RecoveryEvidence};
use crate::translate::boundaries::{NativeEvent, parse_native_event};

fn envelope(id: &str, kind: &str, data: Value) -> Value {
    json!({ "id": id, "type": kind, "data": data })
}

fn parsed(value: &Value) -> NativeEvent<'_> {
    parse_native_event(value).expect("a valid envelope")
}

fn delta(ordinal: u64, text: &str) -> Value {
    envelope(
        "e",
        "session.text.delta",
        json!({ "sessionID": "s", "assistantMessageID": "m", "ordinal": ordinal, "delta": text }),
    )
}

fn snapshot(text: &str) -> Value {
    json!({
        "sessionID": "s",
        "message": { "id": "m", "type": "assistant", "content": [{ "type": "text", "text": text }] },
    })
}

#[test]
fn a_snapshot_covers_only_the_deltas_its_tail_ends_with() {
    let mut evidence = RecoveryEvidence::new();
    let first = delta(0, "ab");
    let second = delta(0, "cd");
    evidence.observe(&parsed(&first), 1).expect("in budget");
    evidence.observe(&parsed(&second), 2).expect("in budget");
    evidence.message(&snapshot("xxabcd")).expect("a full match");
    assert!(evidence.covered(&parsed(&first), "s", 1));
    assert!(evidence.covered(&parsed(&second), "s", 2));

    // A later delta is not in the snapshot's text.
    let third = delta(0, "ef");
    evidence.observe(&parsed(&third), 3).expect("in budget");
    assert!(!evidence.covered(&parsed(&third), "s", 3));

    // A different message or ordinal has its own entry.
    let other = envelope(
        "e",
        "session.reasoning.delta",
        json!({ "sessionID": "s", "assistantMessageID": "m", "ordinal": 1, "delta": "ab" }),
    );
    evidence.observe(&parsed(&other), 4).expect("in budget");
    assert!(!evidence.covered(&parsed(&other), "s", 4));
}

#[test]
fn a_snapshot_that_stops_inside_a_delta_is_uncertain() {
    let mut evidence = RecoveryEvidence::new();
    evidence
        .observe(&parsed(&delta(0, "ab")), 1)
        .expect("in budget");
    evidence
        .observe(&parsed(&delta(0, "cd")), 2)
        .expect("in budget");
    assert_eq!(
        evidence.message(&snapshot("abc")),
        Err(EvidenceError::PartialCoverage)
    );
}

#[test]
fn a_snapshot_of_another_session_or_type_covers_nothing() {
    let mut evidence = RecoveryEvidence::new();
    evidence
        .observe(&parsed(&delta(0, "ab")), 1)
        .expect("in budget");
    let mut other = snapshot("ab");
    if let Value::Object(map) = &mut other {
        map.insert("sessionID", json!("elsewhere"));
    }
    evidence
        .message(&other)
        .expect("a snapshot for another session");
    assert!(!evidence.covered(&parsed(&delta(0, "ab")), "s", 1));

    let mut user = snapshot("ab");
    if let Value::Object(map) = &mut user
        && let Value::Object(message) = map.get_mut("message").expect("message")
    {
        message.insert("type", json!("user"));
    }
    evidence.message(&user).expect("a user message");
    assert!(!evidence.covered(&parsed(&delta(0, "ab")), "s", 1));
}

#[test]
fn the_delta_bounds_refuse_a_new_entry_or_chunk() {
    let mut evidence = RecoveryEvidence::new();
    for index in 0..4096 {
        evidence
            .observe(&parsed(&delta(index, "x")), 1)
            .expect("under the entry bound");
    }
    assert_eq!(
        evidence.observe(&parsed(&delta(5000, "x")), 1),
        Err(EvidenceError::TextBudget)
    );
    // An existing entry takes one more, up to its chunk bound.
    assert_eq!(evidence.observe(&parsed(&delta(0, "y")), 2), Ok(()));
    for index in 0..4094 {
        evidence
            .observe(&parsed(&delta(0, "z")), index as u64 + 3)
            .expect("under the chunk bound");
    }
    assert_eq!(
        evidence.observe(&parsed(&delta(0, "z")), 5000),
        Err(EvidenceError::TextBudget)
    );
}

#[test]
fn an_interaction_snapshot_covers_only_a_key_it_no_longer_lists() {
    let mut evidence = RecoveryEvidence::new();
    let asked = envelope(
        "e",
        "permission.asked",
        json!({ "sessionID": "s", "id": "p1" }),
    );
    // The snapshot still lists the interaction: replaying the event is right.
    evidence
        .stage(
            "snapshot.interactions",
            &json!({ "keys": ["permission:s:p1"] }),
            "s",
            5,
        )
        .expect("in budget");
    assert!(!evidence.covered(&parsed(&asked), "s", 4));

    // The snapshot no longer lists it, so the event is already gone.
    let mut evidence = RecoveryEvidence::new();
    evidence
        .stage("snapshot.interactions", &json!({ "keys": [] }), "s", 5)
        .expect("in budget");
    assert!(evidence.covered(&parsed(&asked), "s", 4));
    assert!(
        !evidence.covered(&parsed(&asked), "s", 6),
        "staged after it"
    );
    // A key that is not a string fails its check rather than covering.
    assert_eq!(
        evidence.interaction_keys(&json!({ "keys": [1] })),
        Err(EvidenceError::Keys)
    );
    assert_eq!(
        evidence.interaction_keys(&json!({})),
        Err(EvidenceError::Keys)
    );
}

#[test]
fn an_idle_active_snapshot_covers_an_execution_started_before_it() {
    let started = |created: Option<u64>| {
        let mut data = json!({ "sessionID": "s" });
        if let (Some(created), Value::Object(map)) = (created, &mut data) {
            map.insert("created", json!(created));
        }
        let mut value = envelope("e", "session.execution.started", data);
        if let (Some(created), Value::Object(map)) = (created, &mut value) {
            map.insert("created", json!(created));
        }
        value
    };
    let mut evidence = RecoveryEvidence::new();
    evidence
        .stage(
            "snapshot.active",
            &json!({ "running": false, "idleAt": 10 }),
            "s",
            5,
        )
        .expect("in budget");
    assert!(evidence.covered(&parsed(&started(Some(9))), "s", 4));
    assert!(!evidence.covered(&parsed(&started(Some(11))), "s", 4));

    let mut running = RecoveryEvidence::new();
    running
        .stage(
            "snapshot.active",
            &json!({ "running": true, "idleAt": 10 }),
            "s",
            5,
        )
        .expect("in budget");
    assert!(!running.covered(&parsed(&started(None)), "s", 4));
}

#[test]
fn a_shell_snapshot_covers_the_shell_it_was_read_for() {
    let mut evidence = RecoveryEvidence::new();
    evidence.shell("sh1", "s", 5).expect("in budget");
    let created = envelope(
        "e",
        "shell.created",
        json!({ "sessionID": "s", "info": { "id": "sh1" } }),
    );
    assert!(evidence.covered(&parsed(&created), "s", 4));
    assert!(!evidence.covered(&parsed(&created), "s", 6));
    assert!(!evidence.complete_shell("sh1", "other"));
    assert!(evidence.complete_shell("sh1", "s"));
}

#[test]
fn the_absence_clocks_drop_a_snapshot_a_later_event_overtook() {
    let mut evidence = RecoveryEvidence::new();
    evidence
        .stage("snapshot.active", &json!({ "running": true }), "s", 5)
        .expect("in budget");
    evidence
        .stage("snapshot.active", &json!({ "running": true }), "t", 5)
        .expect("in budget");
    evidence
        .stage("snapshot.interactions", &json!({ "keys": [] }), "t", 5)
        .expect("in budget");
    // A tool event for `s` after the snapshot started overtakes it.
    evidence
        .observe(
            &parsed(&envelope(
                "e",
                "session.tool.progress",
                json!({ "sessionID": "s" }),
            )),
            6,
        )
        .expect("in budget");
    // Only `t` has both of its session's snapshots staged.
    assert!(!evidence.complete("s"));
    assert!(evidence.complete("t"));
    assert!(!evidence.complete("u"));
    let finished = evidence.finish();
    assert_eq!(finished.len(), 2);
    assert!(finished.iter().all(|snapshot| snapshot.session == "t"));
}

#[test]
fn reset_clears_every_epoch_map() {
    let mut evidence = RecoveryEvidence::new();
    evidence
        .observe(&parsed(&delta(0, "ab")), 1)
        .expect("in budget");
    evidence
        .stage("snapshot.active", &json!({}), "s", 2)
        .expect("in budget");
    evidence.shell("sh1", "s", 2).expect("in budget");
    evidence.reset();
    assert!(!evidence.covered(&parsed(&delta(0, "ab")), "s", 1));
    assert!(!evidence.complete("s"));
    assert!(!evidence.complete_shell("sh1", "s"));
}
