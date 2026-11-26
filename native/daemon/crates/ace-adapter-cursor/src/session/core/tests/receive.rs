// SPDX-License-Identifier: Apache-2.0
//! The frame the session hands over and the turn it reads (`session.ts:105`-`:139`).

use super::*;

#[test]
fn a_frame_starting_at_one_acknowledges_the_host_frame_it_carries() {
    let mut core = session_core();
    let line = frame_line(&envelope(
        "delta",
        "open",
        0.0,
        r#"{"type":"text-delta","text":"a"}"#,
    ));
    let effects = core.stdout_bytes(format!("{line}\n").as_bytes());
    let frame = effects
        .iter()
        .find_map(|effect| match effect {
            CoreEffect::Event(SessionEvent::Frame { seq, dir, text, .. }) => {
                Some((*seq, *dir, text.clone()))
            }
            _ => None,
        })
        .expect("a frame");
    assert_eq!(frame.0, 1);
    assert_eq!(frame.1, FrameDirection::Recv);
    assert!(frame.2.contains(r#""kind":"delta""#));
    // The acknowledgement names the session's number; the host hears its own.
    let effects = core.committed(1);
    assert!(effects.iter().any(|effect| matches!(
        effect,
        CoreEffect::Write { wire, .. }
            if String::from_utf8_lossy(wire).contains(r#""result":{"committed":true}"#)
    )));
}

#[test]
fn an_open_whose_recovery_snapshot_is_over_the_frame_bound_fails_the_open() {
    let mut core = session_core();
    // `maxCheckpointBytes` allows 8 GiB, so a recovery snapshot can be far over the 1 MiB bound
    // of a frame the session builds. `session.ts:217`'s `frame` throws, so the open fails.
    let mut body = ace_json::Map::with_capacity(1);
    body.insert("blob", Value::from("a".repeat(1_100_000)));
    let snapshot = Value::Object(body);
    let mut effects = Vec::new();
    core.start_open(
        1,
        &ace_json::json!({"cwd": "/w", "threadId": "t"}),
        Some(snapshot),
        &mut effects,
    )
    .expect("an open request");
    let effects = ack(&mut core, effects);
    let (id, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the open request");
    let effects = reply(&mut core, id, r#"{"agentId":"a"}"#);
    let failure = effects
        .iter()
        .find_map(|effect| match effect {
            CoreEffect::Event(SessionEvent::Settle {
                result: Err(error), ..
            }) => Some((error.code, error.message.clone())),
            _ => None,
        })
        .expect("the open's failure");
    assert_eq!(failure.0, crate::session::commands::PLAIN_CODE);
    assert_eq!(failure.1, "SDK string exceeds byte budget");
    assert!(
        frames(&effects).is_empty(),
        "the over-bound snapshot note must not be published"
    );
    assert!(
        !effects.iter().any(|effect| matches!(
            effect,
            CoreEffect::Event(SessionEvent::Settle { result: Ok(_), .. })
        )),
        "the open must not report success with the evidence missing"
    );
}

#[test]
fn an_open_that_cannot_be_written_stops_the_host_and_leaves_no_opening() {
    let mut core = session_core();
    // The host stops itself on a line ace cannot route, leaving `closing` and `exit` untouched.
    let stopped = feed(&mut core, r#"{"hello":1}"#);
    assert_eq!(ports(&stopped), vec![String::from("stop")]);
    let mut effects = Vec::new();
    let error = core
        .start_open(
            1,
            &ace_json::json!({"cwd": "/w", "threadId": "t"}),
            None,
            &mut effects,
        )
        .expect_err("the open cannot be written");
    assert_eq!(error.code, "ACE_CURSOR_RPC");
    // `session.ts:318`-`:322`: the failed open stops the host, and no opening is left behind.
    assert!(ports(&effects).contains(&String::from("stop")));
    assert!(core.opening.is_none());
}

#[test]
fn a_snapshot_that_fails_the_open_also_stops_the_host() {
    let mut core = session_core();
    let mut body = ace_json::Map::with_capacity(1);
    body.insert("blob", Value::from("a".repeat(1_100_000)));
    let mut effects = Vec::new();
    core.start_open(
        1,
        &ace_json::json!({"cwd": "/w", "threadId": "t"}),
        Some(Value::Object(body)),
        &mut effects,
    )
    .expect("an open request");
    let effects = ack(&mut core, effects);
    let (id, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the open request");
    let effects = reply(&mut core, id, r#"{"agentId":"a"}"#);
    assert!(ports(&effects).contains(&String::from("stop")));
    assert!(
        effects.iter().any(|effect| matches!(
            effect,
            CoreEffect::Event(SessionEvent::Settle { result: Err(_), .. })
        )),
        "the open must fail loudly"
    );
}
