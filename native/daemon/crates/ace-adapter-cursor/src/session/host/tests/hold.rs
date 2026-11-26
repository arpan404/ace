// SPDX-License-Identifier: Apache-2.0
//! The stray-line hold, the diagnostics ports and the host's stops.

use super::*;

#[test]
fn a_notification_that_cannot_be_stored_stops_the_host_with_the_store_reason() {
    let mut host = core();
    let effects = feed(&mut host, &[&notification_line(DELTA)]);
    assert_eq!(frames(&effects).len(), 1);
    let effects = host.refused(1, "ace could not store a Cursor SDK frame: disk full");
    assert_eq!(
        port(&effects, PORT_STOP),
        Some(r#"{"reason":"ace could not store a Cursor SDK frame: disk full"}"#.to_owned())
    );
    assert!(writes(&effects).is_empty());
    // The host is stopped: later lines are ignored.
    let effects = feed(&mut host, &[&request_line("host:1", DELTA)]);
    assert!(effects.is_empty());
}

#[test]
fn a_notification_that_is_not_a_frame_stops_the_host_through_its_connection() {
    let mut host = core();
    let effects = feed(&mut host, &[r#"{"jsonrpc":"2.0","method":"shutdown"}"#]);
    assert_eq!(
        port(&effects, PORT_CONNECTION),
        Some(r#"{"message":"Unknown host notification"}"#.to_owned())
    );
}

#[test]
fn two_stray_lines_in_one_chunk_each_take_their_place_before_the_frames_after_them() {
    let mut host = core();
    let line = request_line("host:1", DELTA);
    let effects = feed(&mut host, &["one", "two", &line]);
    // Only the first stray port goes out; the rest waits behind it.
    assert_eq!(
        port(&effects, PORT_STRAY),
        Some(r#"{"line":"one"}"#.to_owned())
    );
    assert_eq!(
        effects
            .iter()
            .filter(|effect| matches!(effect, HostEffect::Port { .. }))
            .count(),
        1
    );
    // The first answer releases the second port, and only then the frame.
    let released = host.note("host-output");
    assert_eq!(
        port(&released, PORT_STRAY),
        Some(r#"{"line":"two"}"#.to_owned())
    );
    assert!(frames(&released).is_empty());
    let released = host.note("host-output");
    assert_eq!(frames(&released).len(), 1);
    assert!(!host.holding());
}

#[test]
fn a_stray_line_holds_the_events_after_it_until_the_facade_notes_the_output() {
    let mut host = core();
    let line = request_line("host:1", DELTA);
    let effects = feed(&mut host, &["a console write", &line]);
    // The note frame's place comes first; the frame waits for it.
    assert_eq!(
        port(&effects, PORT_STRAY),
        Some(r#"{"line":"a console write"}"#.to_owned())
    );
    assert!(frames(&effects).is_empty());
    assert!(host.holding());
    let released = host.note("host-output");
    assert_eq!(frames(&released).len(), 1);
    assert!(!host.holding());
    assert_eq!(
        writes(&host.committed(1)),
        vec![r#"{"jsonrpc":"2.0","id":"host:1","result":{"committed":true}}"#.to_owned()]
    );
}

#[test]
fn at_most_sixty_four_stray_lines_are_kept_and_each_one_holds() {
    let mut host = core();
    let mut noted = 0;
    for index in 0..70 {
        let effects = feed(&mut host, &[&format!("stray {index}")]);
        if port(&effects, PORT_STRAY).is_some() {
            noted += 1;
            host.note("host-output");
        }
    }
    assert_eq!(noted, 64);
}

#[test]
fn an_error_frame_message_crosses_once_its_frame_is_stored() {
    let mut host = core();
    let error = r#"{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"error","body":{"message":"rate limited"}}"#;
    let effects = feed(&mut host, &[&request_line("host:1", error)]);
    assert_eq!(port(&effects, PORT_ERROR_FRAME), None);
    let effects = host.committed(1);
    assert_eq!(
        port(&effects, PORT_ERROR_FRAME),
        Some(r#"{"message":"rate limited"}"#.to_owned())
    );
    // A refused error frame says nothing: it was not stored.
    let mut host = core();
    let effects = feed(&mut host, &[&request_line("host:2", error)]);
    assert_eq!(port(&effects, PORT_ERROR_FRAME), None);
    let effects = host.refused(1, "ace could not store a Cursor SDK frame: full");
    assert_eq!(port(&effects, PORT_ERROR_FRAME), None);
}

#[test]
fn a_login_url_must_be_https_and_bounded() {
    let mut host = core();
    let effects = feed(
        &mut host,
        &[r#"{"jsonrpc":"2.0","method":"login-url","params":{"url":"https://cursor.com/login"}}"#],
    );
    assert!(matches!(
        effects.as_slice(),
        [HostEffect::LoginUrl(url)] if url == "https://cursor.com/login"
    ));
    let mut host = core();
    let effects = feed(
        &mut host,
        &[r#"{"jsonrpc":"2.0","method":"login-url","params":{"url":"http://cursor.com/login"}}"#],
    );
    assert_eq!(
        port(&effects, PORT_CONNECTION),
        Some(r#"{"message":"Unsafe login URL"}"#.to_owned())
    );
}

#[test]
fn a_held_frame_still_crosses_before_the_drain_when_the_note_never_comes() {
    let mut host = core();
    let line = request_line("host:1", DELTA);
    let effects = feed(&mut host, &["stray", &line]);
    assert_eq!(
        port(&effects, PORT_STRAY),
        Some(r#"{"line":"stray"}"#.to_owned())
    );
    let finished = host.finish();
    let frame_at = finished
        .iter()
        .position(|effect| matches!(effect, HostEffect::Frame { .. }))
        .expect("the held frame");
    assert!(finished.contains(&HostEffect::Drained));
    let drained_at = finished
        .iter()
        .position(|effect| *effect == HostEffect::Drained)
        .expect("drained");
    assert!(frame_at < drained_at);
    // The drain is the last event, and the held frame still crosses before it.
    assert_eq!(drained_at, finished.len() - 1);
}
