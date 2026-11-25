// SPDX-License-Identifier: Apache-2.0
//! Cases moved from the six TypeScript host process files (owner decision, 2026-11-25). Each
//! Rust test keeps the TypeScript case's name and asserts the daemon side the core owns; the
//! TypeScript cases themselves are deleted from those files, so nothing exists twice.
//!
//! Moved one for one:
//! - `host-ack`: "a storage acknowledgement that arrives after the host stopped waiting leaves the
//!   host running"; "a frame stuck in storage while opening is fenced within the open request's
//!   deadline".
//! - `host-frame-storage`: "a frame ace fails to store is reported to the host as ace's storage
//!   failure"; "a host stopped because ace failed to store its frame names ace's storage as the
//!   cause".
//! - `host-stderr`: "a Cursor host survives an oversized stderr line from a process it inherits
//!   stderr to".
//! - `host-stray-output`: "a non-JSON line on the host's stdout is kept as redacted raw output and
//!   the turn goes on"; "a JSON line from the host that is not a JSON-RPC message still stops the
//!   host"; "stray text joined to a JSON-RPC message on one line still stops the host".
//!
//! Also moved with them, because the same rule owns them: a stderr line split across reads (the
//! E3.0c hold's line order, found in review), and the two batch cases below, whose failure is
//! ace's storage failing (`session.ts:93`-`:98`).
//!
//! Kept in TypeScript: `host-stop` (the stop plan is the facade's) and `sdk-admission` (SDK
//! discovery, Windows-only), and the cases whose behaviour is the host child's (`host-wire.ts`),
//! the session's redaction or discovery, which stay in their files.

use super::*;
use crate::session::error::ACE_CURSOR_RPC;

#[test]
fn a_storage_acknowledgement_that_arrives_after_the_host_stopped_waiting_leaves_the_host_running() {
    let mut host = core();
    let effects = feed(&mut host, &[&request_line("host:1", DELTA)]);
    assert_eq!(frames(&effects).len(), 1);
    // The daemon answers once, and its late second answer changes nothing.
    let answered = host.committed(1);
    assert_eq!(writes(&answered).len(), 1);
    assert!(host.committed(1).is_empty());
    // The host goes on answering.
    let effects = feed(&mut host, &[&request_line("host:2", DELTA)]);
    assert_eq!(frames(&effects).len(), 1);
    assert!(!host.holding());
}

#[test]
fn a_frame_stuck_in_storage_while_opening_is_fenced_within_the_open_request_deadline() {
    let mut host = core();
    // The open is out, and the host's first frame arrived but is still uncommitted: the turn's
    // record is stuck in storage when the open's deadline fires.
    let opened = host
        .request("open", Some(&Value::Null), 7, None)
        .expect("an open request");
    // The pipe took the open's line, so the next write can go out.
    let opened = ack(&mut host, opened);
    let key = opened
        .iter()
        .find_map(|effect| match effect {
            HostEffect::ArmTimer { key, .. } => Some(key.clone()),
            _ => None,
        })
        .expect("the open deadline");
    let frame = host.stdout_bytes(format!("{}\n", request_line("host:1", DELTA)).as_bytes());
    assert_eq!(frames(&frame).len(), 1);
    let settled = host.timer(&key);
    let outcome = settled
        .iter()
        .find_map(|effect| match effect {
            HostEffect::Settle { id, result } if *id == 7 => Some(result.clone()),
            _ => None,
        })
        .expect("the open's settlement");
    let error = outcome.expect_err("the open timed out");
    assert_eq!(error.code, ACE_CURSOR_RPC);
    assert_eq!(error.message, "JSON-RPC request timed out: open");
    // The stuck frame is answered once when its store lands, and reading goes on.
    let answered = host.committed(1);
    assert_eq!(
        writes(&answered),
        vec![r#"{"jsonrpc":"2.0","id":"host:1","result":{"committed":true}}"#.to_owned()]
    );
    assert!(writes(&host.committed(1)).is_empty());
    let effects = feed(&mut host, &[&request_line("host:9", DELTA)]);
    assert_eq!(frames(&effects).len(), 1);
}

#[test]
fn a_frame_ace_fails_to_store_is_reported_to_the_host_as_aces_storage_failure() {
    let mut host = core();
    let effects = feed(&mut host, &[&request_line("host:1", DELTA)]);
    assert_eq!(frames(&effects).len(), 1);
    let answered = host.refused(
        1,
        "ace could not store a Cursor SDK frame: database is locked",
    );
    assert_eq!(
        writes(&answered),
        vec![
            r#"{"jsonrpc":"2.0","id":"host:1","error":{"code":-32603,"message":"ace could not store a Cursor SDK frame: database is locked"}}"#
                .to_owned()
        ]
    );
}

#[test]
fn a_host_stopped_because_ace_failed_to_store_its_frame_names_aces_storage_as_the_cause() {
    let mut host = core();
    let effects = feed(&mut host, &[&notification_line(DELTA)]);
    assert_eq!(frames(&effects).len(), 1);
    let effects = host.refused(
        1,
        "ace could not store a Cursor SDK frame: database is locked",
    );
    assert_eq!(
        port(&effects, PORT_STOP),
        Some(
            r#"{"reason":"ace could not store a Cursor SDK frame: database is locked"}"#.to_owned()
        )
    );
    assert!(writes(&effects).is_empty());
}

#[test]
fn a_stderr_line_split_across_two_reads_keeps_its_head() {
    let mut host = core();
    // The SDK's own writes land mid-line: `"Err"`, then `"or: auth expired\n"`.
    assert!(host.stderr_bytes(b"Err").is_empty());
    let effects = host.stderr_bytes(b"or: auth expired\n");
    assert_eq!(
        port(&effects, PORT_STDERR),
        Some(r#"{"line":"Error: auth expired"}"#.to_owned())
    );
}

#[test]
fn a_stderr_line_split_across_three_reads_keeps_its_head() {
    let mut host = core();
    assert!(host.stderr_bytes(b"Er").is_empty());
    assert!(host.stderr_bytes(b"ror: auth").is_empty());
    let effects = host.stderr_bytes(b" expired\n");
    assert_eq!(
        port(&effects, PORT_STDERR),
        Some(r#"{"line":"Error: auth expired"}"#.to_owned())
    );
}

#[test]
fn a_cursor_host_survives_an_oversized_stderr_line_from_a_process_it_inherits_stderr_to() {
    let mut host = CursorHostCore::new(CursorHostConfig {
        generation: "g".into(),
        limits: CursorLimits {
            max_frame_bytes: 4_096,
            ..CursorLimits::default()
        },
    });
    let mut chunk = vec![b'x'; 65_536];
    chunk.push(b'\n');
    chunk.extend_from_slice(b"MCP server ready\n");
    let effects = host.stderr_bytes(&chunk);
    assert_eq!(
        port(&effects, PORT_STDERR),
        Some(r#"{"line":"MCP server ready"}"#.to_owned())
    );
    // The stdout side is untouched: the host keeps answering.
    let effects = feed(&mut host, &[&request_line("host:1", DELTA)]);
    assert_eq!(frames(&effects).len(), 1);
}

#[test]
fn a_non_json_line_on_the_hosts_stdout_is_kept_as_raw_output_and_the_turn_goes_on() {
    let mut host = core();
    let line = request_line("host:1", DELTA);
    let effects = feed(&mut host, &["console write", &line]);
    assert_eq!(
        port(&effects, PORT_STRAY),
        Some(r#"{"line":"console write"}"#.to_owned())
    );
    // The note frame takes its place first; once the facade notes it, the turn's frame crosses.
    let released = host.note("host-output");
    assert_eq!(frames(&released).len(), 1);
    assert_eq!(writes(&host.committed(1)).len(), 1);
}

#[test]
fn a_json_line_from_the_host_that_is_not_a_json_rpc_message_still_stops_the_host() {
    let mut host = core();
    let effects = feed(&mut host, &[r#"{"hello":1}"#]);
    assert_eq!(
        port(&effects, PORT_STOP),
        Some(format!(r#"{{"reason":"{MALFORMED}"}}"#))
    );
    // Stopped: the next line is not acted on.
    assert!(feed(&mut host, &[&request_line("host:2", DELTA)]).is_empty());
}

#[test]
fn stray_text_joined_to_a_json_rpc_message_on_one_line_still_stops_the_host() {
    let mut host = core();
    let effects = feed(&mut host, &[r#"half a write "jsonrpc" : {"#]);
    assert_eq!(
        port(&effects, PORT_STOP),
        Some(format!(r#"{{"reason":"{MALFORMED}"}}"#))
    );
}

#[test]
fn a_batch_whose_inner_frame_is_not_an_envelope_is_aces_storage_failure() {
    let mut host = core();
    let inner = DELTA.replace(r#""schemaVersion":1"#, r#""schemaVersion":8"#);
    let batch = format!(
        r#"{{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"batch","body":{{"frames":[{inner}]}}}}"#
    );
    let lines = feed(&mut host, &[&request_line("host:1", &batch)]);
    assert!(frames(&lines).is_empty());
    assert_eq!(
        writes(&lines),
        vec![
            r#"{"jsonrpc":"2.0","id":"host:1","error":{"code":-32603,"message":"ace could not store a Cursor SDK frame: Malformed SDK frame batch"}}"#
                .to_owned()
        ]
    );
}

#[test]
fn a_notification_batch_whose_inner_frame_is_not_an_envelope_stops_the_host_as_a_store_failure() {
    let mut host = core();
    let inner = DELTA.replace(r#""schemaVersion":1"#, r#""schemaVersion":8"#);
    let batch = format!(
        r#"{{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"batch","body":{{"frames":[{inner}]}}}}"#
    );
    let effects = feed(&mut host, &[&notification_line(&batch)]);
    assert_eq!(
        port(&effects, PORT_STOP),
        Some(
            r#"{"reason":"ace could not store a Cursor SDK frame: Malformed SDK frame batch"}"#
                .to_owned()
        )
    );
}
