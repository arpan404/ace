// SPDX-License-Identifier: Apache-2.0
//! Cases moved from the six TypeScript host process files (`host-ack`, `host-frame-storage`,
//! `host-stderr`, `host-stop`, `host-stray-output`, `sdk-admission`, owner decision of
//! 2026-11-25): each keeps its TypeScript name and asserts the daemon side the core owns. The
//! cases whose behaviour is the host child's (`host-wire.ts`, which stays TypeScript), the
//! session's redaction (`@ace/redaction`) or SDK discovery (the facade) stay in their files.
//!
//! Moved one for one from:
//! - `host-ack`: the late acknowledgement, and the open deadline a stuck frame is fenced by.
//! - `host-frame-storage`: the storage reason on a request, and the stop cause on a notification.
//! - `host-stderr`: the host surviving an oversized stderr line.
//! - `host-stray-output`: raw output and the turn going on, a JSON line that is not JSON-RPC, and
//!   stray text joined to a JSON-RPC message.

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
    let effects = host
        .request("open", Some(&Value::Null), 7, None)
        .expect("an open request");
    let key = effects
        .iter()
        .find_map(|effect| match effect {
            HostEffect::ArmTimer { key, .. } => Some(key.clone()),
            _ => None,
        })
        .expect("the open deadline");
    // The deadline fires while the host's frame is still uncommitted: the open settles, not the
    // host, and the session can fence the turn (`host.ts:196`).
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
    // The host is still running and answering.
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
