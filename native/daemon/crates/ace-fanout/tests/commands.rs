#![allow(clippy::expect_used, clippy::unwrap_used, clippy::panic)]
// SPDX-License-Identifier: Apache-2.0
//! Ports `apps/daemon/src/command-lanes.ts` and `apps/daemon/src/command-status.ts`.
//!
//! `vectors/commands.json` is produced by `vectors/make-command-vectors.ts` from the TypeScript
//! `commandLane` and `commandState`: the lane keys that order commands, and every state and
//! result a client reads. The lane cases are `socket-commands-recheck.test.ts`'s ordering rules
//! ("a command whose access ended while it waited in its lane is refused when its turn comes")
//! and `command.status`'s answers.

use ace_fanout::{CommandLanes, command_lane, command_state};
use ace_json::{JsString, Value};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/vectors/commands.json");
    let text = std::fs::read_to_string(path).expect("read commands.json");
    ace_json::parse(&text).expect("parse commands.json")
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    match value.get(key) {
        Some(Value::Array(items)) => items,
        _ => panic!("{key} is not an array"),
    }
}

fn text(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(seen)) => seen.as_str().to_owned(),
        _ => panic!("{key} is not a string"),
    }
}

fn optional_text(value: &Value, key: &str) -> Option<String> {
    match value.get(key) {
        Some(Value::String(seen)) => Some(seen.as_str().to_owned()),
        _ => None,
    }
}

/// Each command's order key is the TypeScript's.
#[test]
fn every_commands_lane_is_the_typescripts() {
    let vectors = vectors();
    for case in array(&vectors, "lanes") {
        let command = ace_json::parse(&text(case, "command")).expect("parse command");
        assert_eq!(
            command_lane(&command, &text(case, "device")),
            text(case, "key"),
            "{}",
            text(case, "command")
        );
    }
}

/// Every command status a client reads is the TypeScript's, state and bytes.
#[test]
fn every_command_status_is_the_typescripts() {
    let vectors = vectors();
    for case in array(&vectors, "statuses") {
        let receipt = optional_text(case, "receipt")
            .map(|receipt| ace_json::parse(&receipt).expect("parse receipt"));
        let state = command_state(
            &JsString::from(text(case, "commandId")),
            receipt.as_ref(),
            matches!(case.get("inFlight"), Some(Value::Bool(true))),
        );
        assert_eq!(
            state.state.as_str(),
            text(case, "state"),
            "{}",
            text(case, "name")
        );
        assert_eq!(
            state.result.map(|result| ace_json::to_string(&result)),
            optional_text(case, "result"),
            "{}",
            text(case, "name")
        );
    }
}

/// A command's own lane orders it behind earlier work on the same thread, whichever socket
/// carried it, and unrelated work does not wait.
#[test]
fn commands_on_one_thread_run_in_arrival_order_and_others_do_not_wait() {
    let mut lanes = CommandLanes::new();
    let first = lanes.run("phone\0thread\0t", "phone", "c1");
    assert!(first.start);
    let second = lanes.run("phone\0thread\0t", "phone", "c2");
    assert!(!second.start, "it queued behind the first");
    let other = lanes.run("phone\0thread\0u", "phone", "c3");
    assert!(other.start, "another thread's lane is free");
    assert_eq!(lanes.size(), 3);
    assert!(lanes.running("phone", "c1"));
    assert!(lanes.running("phone", "c2"));
    assert!(!lanes.running("phone", "c4"));

    let next = lanes.finished(&first).expect("the queued run starts");
    assert_eq!(next.id, second.id);
    assert!(next.start);
    assert!(!lanes.running("phone", "c1"));
    assert!(lanes.running("phone", "c2"));
    assert_eq!(lanes.finished(&next), None);
    assert_eq!(lanes.finished(&other), None);
    assert!(lanes.settled(), "nothing is queued or executing");
    assert_eq!(lanes.size(), 0);
}

/// "A replay after a reconnect lands behind the attempt it repeats": the same command id twice
/// stays running until both its runs settle.
#[test]
fn a_replay_lands_behind_the_attempt_it_repeats() {
    let mut lanes = CommandLanes::new();
    let first = lanes.run("phone\0thread\0t", "phone", "c1");
    let replay = lanes.run("phone\0thread\0t", "phone", "c1");
    assert!(!replay.start);
    lanes.finished(&first);
    assert!(lanes.running("phone", "c1"), "the replay still holds it");
    lanes.finished(&replay);
    assert!(!lanes.running("phone", "c1"));
}

/// The lane key includes the device: another device's command on the same thread is its own lane.
#[test]
fn another_devices_command_is_a_different_lane() {
    let mut lanes = CommandLanes::new();
    let phone = lanes.run("phone\0thread\0t", "phone", "c1");
    let laptop = lanes.run("laptop\0thread\0t", "laptop", "c2");
    assert!(phone.start && laptop.start);
}

/// An empty thread id names no thread, as the TypeScript's `if (thread)` says: the command
/// takes the device lane, whatever carried the empty id.
#[test]
fn an_empty_thread_id_names_no_thread() {
    let payload = ace_json::parse(r#"{"payload":{"type":"thread.moved","threadId":""}}"#)
        .expect("parse command");
    assert_eq!(command_lane(&payload, "phone"), "phone\0device");
    let link = ace_json::parse(r#"{"payload":{"type":"thread.fork","link":{"threadId":""}}}"#)
        .expect("parse command");
    assert_eq!(command_lane(&link, "phone"), "phone\0device");
}
