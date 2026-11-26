// SPDX-License-Identifier: Apache-2.0
//! The send machine (`commands/send.rs`) written out at `send` as the brief asks: the steer's
//! orders against a cancel, the fallback operation id's sequence, and the refusals.

use ace_adapter_api::session::Delivery;

use crate::session::commands::{INPUT_REJECTED_CODE, STEER_TARGET_LOST_CODE};

use super::*;

#[test]
fn a_steer_whose_fence_was_lost_while_the_turn_runs_is_refused_with_nothing_written() {
    let mut core = session_core();
    opened(&mut core);
    let effects = send(&mut core, 2, Some("c1"), Delivery::Queue, false).expect("a send");
    let effects = ack(&mut core, effects);
    let (id, method, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the send request");
    assert_eq!(method, "send");
    // The reply settles the send's promise; the turn keeps running.
    let effects = reply(&mut core, id, r#"{}"#);
    assert_eq!(settled(&effects), vec![Ok(String::from("{}"))]);
    assert!(core.state.active);
    assert!(!core.state.control);
    let refused = send(&mut core, 3, Some("c2"), Delivery::Steer, true)
        .err()
        .expect("lost");
    assert_eq!(refused.code, STEER_TARGET_LOST_CODE);
    // The fence failed, so nothing was written for it, and the turn is untouched.
    assert!(core.state.active);
    assert!(!core.state.control);
}

#[test]
fn a_steer_while_the_turn_runs_cancels_first_and_sends_on_the_next_segment() {
    let mut core = session_core();
    opened(&mut core);
    let effects = send(&mut core, 2, Some("c1"), Delivery::Queue, false).expect("a send");
    let effects = ack(&mut core, effects);
    let (first, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the send request");
    let effects = reply(&mut core, first, r#"{}"#);
    assert_eq!(settled(&effects), vec![Ok(String::from("{}"))]);

    let effects = send(&mut core, 3, Some("c2"), Delivery::Steer, false).expect("a steer");
    // The cancel frame goes before the cancel request, and both before the send.
    let order = frames(&effects);
    assert_eq!(
        order,
        vec![(1, FrameDirection::Send, String::from("cancel"))]
    );
    assert!(settled(&effects).is_empty());
    let effects = ack(&mut core, effects);
    let (cancel, method, params) = requests(&effects)
        .into_iter()
        .find(|(_, method, _)| method == "cancel")
        .expect("the cancel request");
    assert_eq!(method, "cancel");
    assert_eq!(params, Value::Null);
    // The cancel's reply advances the segment, and only then does the send go out.
    let effects = reply(&mut core, cancel, r#"{}"#);
    let effects = ack(&mut core, effects);
    let (_, method, params) = requests(&effects)
        .into_iter()
        .find(|(_, method, _)| method == "send")
        .expect("the send request");
    assert_eq!(method, "send");
    assert_eq!(params.get("segment").and_then(Value::as_f64), Some(1.0));
    // The steer replaces the running turn: the operation stays, the segment advances, and the
    // replacement carries the new command id (`session.ts:246`-`:253`).
    assert_eq!(
        params.get("operationId").and_then(Value::as_str),
        Some("c1")
    );
    assert_eq!(params.get("commandId").and_then(Value::as_str), Some("c2"));
}

#[test]
fn a_steer_that_finds_no_running_turn_is_a_plain_send() {
    let mut core = session_core();
    opened(&mut core);
    // No send before it, so no turn is active: the fence is not consulted.
    let effects = send(&mut core, 2, Some("c1"), Delivery::Steer, true).expect("a steer");
    assert!(frames(&effects).is_empty());
    let effects = ack(&mut core, effects);
    let (_, method, params) = requests(&effects)
        .first()
        .cloned()
        .expect("the send request");
    assert_eq!(method, "send");
    assert_eq!(
        params.get("operationId").and_then(Value::as_str),
        Some("c1")
    );
    assert_eq!(params.get("segment").and_then(Value::as_f64), Some(0.0));
    assert!(core.state.active);
}

#[test]
fn a_queued_send_never_checks_the_fence_and_cancels_a_running_turn_first() {
    let mut core = session_core();
    opened(&mut core);
    let effects = send(&mut core, 2, Some("c1"), Delivery::Queue, false).expect("a send");
    let effects = ack(&mut core, effects);
    let (id, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the send request");
    let _ = reply(&mut core, id, r#"{}"#);
    // A queued send with a lost fence is still admitted: the fence is the steer's. A running
    // turn is cancelled first, without the steer's replacement frame.
    let effects = send(&mut core, 3, Some("c2"), Delivery::Queue, true).expect("a send");
    assert!(frames(&effects).is_empty());
    let effects = ack(&mut core, effects);
    let (cancel, method, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the cancel request");
    assert_eq!(method, "cancel");
    let effects = reply(&mut core, cancel, r#"{}"#);
    let effects = ack(&mut core, effects);
    let (_, method, params) = requests(&effects)
        .into_iter()
        .find(|(_, method, _)| method == "send")
        .expect("the send request");
    assert_eq!(method, "send");
    assert_eq!(
        params.get("operationId").and_then(Value::as_str),
        Some("c2")
    );
}

#[test]
fn the_fallback_operation_id_takes_the_next_sequence_number() {
    let mut core = session_core();
    let effects = send(&mut core, 2, None, Delivery::Queue, false).expect("a send");
    let effects = ack(&mut core, effects);
    let (_, method, params) = requests(&effects)
        .first()
        .cloned()
        .expect("the send request");
    assert_eq!(method, "send");
    assert_eq!(
        params.get("operationId").and_then(Value::as_str),
        Some("g:1")
    );
    assert_eq!(params.get("commandId").and_then(Value::as_str), Some("g:1"));
    // The number it took is the one a frame takes next.
    let line = format!(
        r#"{{"jsonrpc":"2.0","id":"h","method":"frame","params":{}}}"#,
        envelope("delta", "g:1", 0.0, r#"{"type":"text-delta","text":"a"}"#)
    );
    let effects = feed(&mut core, &line);
    assert_eq!(
        frames(&effects),
        vec![(2, FrameDirection::Recv, String::from("delta"))]
    );
    // The frame is the session's 2 and the host's 1: the acknowledgement names the host's own,
    // so a swapped map would answer nothing here.
    let answered: Vec<String> = core
        .committed(2)
        .iter()
        .filter_map(|effect| match effect {
            CoreEffect::Write { wire, .. } => std::str::from_utf8(wire)
                .ok()
                .map(|text| text.trim_end().to_owned()),
            _ => None,
        })
        .collect();
    assert_eq!(
        answered,
        vec![r#"{"jsonrpc":"2.0","id":"h","result":{"committed":true}}"#.to_owned()]
    );
}

#[test]
fn send_refuses_while_closing_uncertain_or_in_flight_with_the_scripts_words() {
    // Closing.
    let mut core = session_core();
    opened(&mut core);
    let _ = core.close(9, CloseReason::User);
    let refused = send(&mut core, 2, Some("c1"), Delivery::Queue, false)
        .err()
        .expect("closed");
    assert_eq!(refused.code, INPUT_REJECTED_CODE);
    assert_eq!(refused.message, "SDK host is closed");

    // Uncertain: a result that does not settle the turn.
    let mut core = session_core();
    opened(&mut core);
    let effects = send(&mut core, 2, Some("c1"), Delivery::Queue, false).expect("a send");
    let effects = ack(&mut core, effects);
    let (id, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the send request");
    let _ = reply(&mut core, id, r#"{}"#);
    let line = format!(
        r#"{{"jsonrpc":"2.0","id":"h","method":"frame","params":{}}}"#,
        envelope("result", "c1", 0.0, r#"{"status":"running"}"#)
    );
    let _ = feed(&mut core, &line);
    assert!(core.state.uncertain);
    let refused = send(&mut core, 3, Some("c2"), Delivery::Queue, false)
        .err()
        .expect("uncertain");
    assert_eq!(
        refused.message,
        "SDK delivery or terminal state is uncertain; close and reconcile before sending"
    );

    // In flight.
    let mut core = session_core();
    opened(&mut core);
    let effects = send(&mut core, 2, Some("c1"), Delivery::Queue, false).expect("a send");
    let _ = ack(&mut core, effects);
    let refused = send(&mut core, 3, Some("c2"), Delivery::Queue, false)
        .err()
        .expect("in flight");
    assert_eq!(refused.message, "SDK control already in flight");
}

#[test]
fn a_send_is_refused_after_its_bounded_input_budget() {
    let mut core = session_core();
    opened(&mut core);
    let input = ace_json::json!([{"type": "text", "text": "a".repeat(300_000)}]);
    let mut effects = Vec::new();
    let refused = core
        .send(
            2,
            CursorSend {
                command_id: Some("c1"),
                operation_id: None,
                input: &input,
                delivery: Delivery::Queue,
                steer_lost: false,
            },
            &mut effects,
        )
        .expect_err("over the input budget");
    assert_eq!(refused.code, INPUT_REJECTED_CODE);
    assert_eq!(refused.message, "SDK string exceeds byte budget");
    assert!(!core.state.control);
}

#[test]
fn a_host_refusal_is_input_rejected_and_another_failure_leaves_the_turn_uncertain() {
    // The host says the send never reached Cursor (`refusedByHost`).
    let mut core = session_core();
    opened(&mut core);
    let effects = send(&mut core, 2, Some("c1"), Delivery::Queue, false).expect("a send");
    let effects = ack(&mut core, effects);
    let (id, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the send request");
    // The host's refusal is a JSON-RPC error whose own `data` says it (`refusedByHost`).
    let effects = feed(
        &mut core,
        &format!(
            r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":-32603,"message":"no","data":{{"refused":true}}}}}}"#
        ),
    );
    assert_eq!(
        settled(&effects),
        vec![Err(String::from("ACE_INPUT_REJECTED"))]
    );
    // The catch clears `active` and marks the turn uncertain before it classifies (`:273`-`:279`).
    assert!(core.state.uncertain);
    assert!(!core.state.active);

    // Any other failure may have reached Cursor: the turn is uncertain, and no resend.
    let mut core = session_core();
    opened(&mut core);
    let effects = send(&mut core, 2, Some("c1"), Delivery::Queue, false).expect("a send");
    let effects = ack(&mut core, effects);
    let (id, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the send request");
    let effects = feed(
        &mut core,
        &format!(r#"{{"jsonrpc":"2.0","id":{id},"error":{{"code":-32603,"message":"boom"}}}}"#),
    );
    assert_eq!(settled(&effects), vec![Err(String::from("ACE_CURSOR_RPC"))]);
    assert!(core.state.uncertain);
    assert!(!core.state.active);
}

#[test]
fn a_send_whose_cancel_cannot_be_written_is_refused_and_leaves_no_control_behind() {
    let mut core = session_core();
    opened(&mut core);
    let effects = send(&mut core, 2, Some("c1"), Delivery::Queue, false).expect("a send");
    let effects = ack(&mut core, effects);
    let (id, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the send request");
    let _ = reply(&mut core, id, r#"{}"#);
    assert!(core.state.active);
    // The host stops itself on a line ace cannot route. The session is still open: `closing`
    // has not run and `exit` has not either, so only the peer is gone (`peer.rs:504`).
    let stopped = feed(&mut core, r#"{"hello":1}"#);
    assert_eq!(ports(&stopped), vec![String::from("stop")]);
    assert!(!core.state.closed);
    // The steer cancels the running turn first, and that write cannot reach the dead peer.
    let (effects, result) = send_with_effects(&mut core, 3, Some("c2"), Delivery::Steer, false);
    let error = result.expect_err("the cancel cannot be written");
    // `session.ts:250`'s catch: the input never reached Cursor, so it is a refusal.
    assert_eq!(error.code, INPUT_REJECTED_CODE);
    // The steer's cancel frame went out before the request, and the finally cleared `control`.
    assert_eq!(
        frames(&effects),
        vec![(1, FrameDirection::Send, String::from("cancel"))]
    );
    assert!(!core.state.control);
    assert!(core.sending.is_none());
    assert!(core.state.active, "the running turn is still the turn");
    // The next send tries its cancel again; the refusal is the dead peer's, never a control
    // already in flight.
    let refused = send(&mut core, 4, Some("c3"), Delivery::Queue, false)
        .err()
        .expect("the peer is gone");
    assert_eq!(refused.code, INPUT_REJECTED_CODE);
    assert_ne!(refused.message, "SDK control already in flight");
}

#[test]
fn a_send_whose_request_cannot_be_written_leaves_the_turn_uncertain_and_inactive() {
    let mut core = session_core();
    opened(&mut core);
    let stopped = feed(&mut core, r#"{"hello":1}"#);
    assert_eq!(ports(&stopped), vec![String::from("stop")]);
    // No turn runs, so there is no cancel: the send request itself cannot be written.
    let error = send(&mut core, 2, Some("c1"), Delivery::Queue, false)
        .err()
        .expect("the peer is gone");
    assert_eq!(error.code, "ACE_CURSOR_RPC");
    // `session.ts:273`-`:280`: the catch clears `active` and marks the turn uncertain, and the
    // finally clears `control`.
    assert!(!core.state.control);
    assert!(!core.state.active);
    assert!(core.state.uncertain);
    assert!(core.sending.is_none());
}
