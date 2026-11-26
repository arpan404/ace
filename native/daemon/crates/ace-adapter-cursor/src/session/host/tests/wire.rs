// SPDX-License-Identifier: Apache-2.0
//! `receiveFrame`'s order and what a frame crosses with: the bound before the envelope, the
//! envelope before the generation, the borrowed text and the batch's schema key order, and the
//! one answer each host request gets.

use super::*;

#[test]
fn a_frame_request_crosses_with_its_own_text_and_is_answered_once_after_its_commit() {
    let mut host = core();
    let effects = feed(&mut host, &[&request_line("host:1", DELTA)]);
    let crossed = frames(&effects);
    assert_eq!(crossed.len(), 1);
    assert_eq!(crossed[0].0, 1);
    assert_eq!(crossed[0].2, DELTA);
    // Nothing is answered before the store.
    assert_eq!(writes(&effects), Vec::<String>::new());
    let answered = host.committed(1);
    assert_eq!(
        writes(&answered),
        vec![r#"{"jsonrpc":"2.0","id":"host:1","result":{"committed":true}}"#.to_owned()]
    );
    // A second report for the same frame answers nothing.
    assert!(writes(&host.committed(1)).is_empty());
}

#[test]
fn a_batch_crosses_one_frame_per_member_in_the_schema_order_and_answers_after_the_last() {
    let mut host = core();
    // The members' keys arrive in an order the schema does not use.
    let first = r#"{"schemaVersion":1,"generation":"g","operationId":"op","segment":0,"kind":"delta","body":{"text":"1","type":"text-delta"}}"#;
    let second = r#"{"generation":"g","schemaVersion":1,"segment":0,"operationId":"op","kind":"result","body":{"status":"finished"}}"#;
    let batch = format!(
        r#"{{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"batch","body":{{"frames":[{first},{second}]}}}}"#
    );
    let effects = feed(&mut host, &[&request_line("host:2", &batch)]);
    let crossed = frames(&effects);
    assert_eq!(crossed.len(), 2);
    assert_eq!(
        crossed[0].2,
        r#"{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"delta","body":{"text":"1","type":"text-delta"}}"#
    );
    assert_eq!(
        crossed[1].2,
        r#"{"schemaVersion":1,"operationId":"op","generation":"g","segment":0,"kind":"result","body":{"status":"finished"}}"#
    );
    assert_eq!((crossed[0].0, crossed[1].0), (1, 2));
    assert!(writes(&effects).is_empty());
    assert!(writes(&host.committed(1)).is_empty());
    assert_eq!(
        writes(&host.committed(2)),
        vec![r#"{"jsonrpc":"2.0","id":"host:2","result":{"committed":true}}"#.to_owned()]
    );
}

#[test]
fn the_bound_runs_before_the_envelope_and_the_envelope_before_the_generation() {
    // Deeper than 64, so the bound fails although the text is short.
    let mut body = String::from("null");
    for _ in 0..70 {
        body = format!("[{body}]");
    }
    let deep = format!(
        r#"{{"schemaVersion":8,"operationId":"op","generation":"other","segment":0,"kind":"delta","body":{body}}}"#
    );
    let mut host = core();
    let lines = feed(&mut host, &[&request_line("host:1", &deep)]);
    let effects = ack(&mut host, lines);
    assert!(frames(&effects).is_empty());
    assert_eq!(
            writes(&effects),
            vec![
                r#"{"jsonrpc":"2.0","id":"host:1","error":{"code":-32603,"message":"SDK payload exceeds structure budget"}}"#
                    .to_owned()
            ]
        );

    // A broken envelope is refused before its generation is compared.
    let bad_version = DELTA.replace(r#""schemaVersion":1"#, r#""schemaVersion":8"#);
    let lines = feed(&mut host, &[&request_line("host:2", &bad_version)]);
    let effects = ack(&mut host, lines);
    assert_eq!(
            writes(&effects),
            vec![
                r#"{"jsonrpc":"2.0","id":"host:2","error":{"code":-32603,"message":"Invalid Cursor SDK frame: schemaVersion is not 1"}}"#
                    .to_owned()
            ]
        );

    // A valid envelope from another generation is refused, and the host keeps reading.
    let other = DELTA.replace(r#""generation":"g""#, r#""generation":"other""#);
    let lines = feed(&mut host, &[&request_line("host:3", &other)]);
    let effects = ack(&mut host, lines);
    assert_eq!(
            writes(&effects),
            vec![
                r#"{"jsonrpc":"2.0","id":"host:3","error":{"code":-32603,"message":"SDK generation mismatch"}}"#
                    .to_owned()
            ]
        );
    // Still reading: the next good frame crosses.
    let effects = feed(&mut host, &[&request_line("host:4", DELTA)]);
    assert_eq!(frames(&effects).len(), 1);
}

#[test]
fn a_frame_that_was_not_written_canonically_crosses_as_json_stringify_writes_it() {
    let mut host = core();
    // `1.0` and a space after the colon are what the host never writes, but a hand-written
    // line is parsed, then re-encoded exactly as `boundedJson` would.
    let spaced = DELTA
        .replace(r#""segment":0"#, r#""segment":1.0"#)
        .replace(r#""kind":"delta""#, r#""kind": "delta""#);
    let effects = feed(&mut host, &[&request_line("host:1", &spaced)]);
    let crossed = frames(&effects);
    assert_eq!(crossed.len(), 1);
    assert_eq!(
        crossed[0].2,
        DELTA.replace(r#""segment":0"#, r#""segment":1"#)
    );
}

#[test]
fn an_unknown_request_is_answered_and_the_host_keeps_reading() {
    let mut host = core();
    let effects = feed(
        &mut host,
        &[r#"{"jsonrpc":"2.0","id":7,"method":"prompt","params":{}}"#],
    );
    assert_eq!(
            writes(&effects),
            vec![
                r#"{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"Unknown SDK host request"}}"#
                    .to_owned()
            ]
        );
    let effects = feed(&mut host, &[&request_line("host:1", DELTA)]);
    assert_eq!(frames(&effects).len(), 1);
}

#[test]
fn a_facade_request_over_its_own_bound_is_refused_before_anything_is_written() {
    let mut host = CursorHostCore::new(CursorHostConfig {
        generation: "g".into(),
        limits: CursorLimits {
            max_frame_bytes: 4_096,
            ..CursorLimits::default()
        },
    });
    let params = format!(r#"{{"input":"{}"}}"#, "a".repeat(4_000));
    let value = ace_json::parse(&params).expect("valid JSON");
    let error = host
        .request("send", Some(&value), 1, None)
        .expect_err("over the bound");
    assert_eq!(error.message(), "SDK string exceeds byte budget");
    // Under it, the request is written and its timer armed.
    let small = ace_json::parse(r#"{"input":"hi"}"#).expect("valid JSON");
    let effects = host
        .request("send", Some(&small), 2, None)
        .expect("a request");
    assert_eq!(writes(&effects).len(), 1);
    assert!(effects.iter().any(|effect| matches!(
        effect,
        HostEffect::ArmTimer { ms, .. } if *ms == CursorLimits::default().send_timeout_ms
    )));
}
