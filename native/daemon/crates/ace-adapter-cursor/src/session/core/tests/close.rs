// SPDX-License-Identifier: Apache-2.0
//! The interrupt and the memoized close (`session.ts:182`-`:303`): the cancel's frame and
//! request, the close that follows it, the stop's port and the exit that skips the request.

use ace_adapter_api::session::{CloseReason, Delivery};

use super::*;

#[test]
fn an_interrupt_cancels_then_closes_and_settles_with_its_cancel_error() {
    let mut core = session_core();
    opened(&mut core);
    let effects = interrupt(&mut core, 2, None, true).expect("an interrupt");
    assert_eq!(
        frames(&effects),
        vec![(1, FrameDirection::Send, String::from("cancel"))]
    );
    let effects = ack(&mut core, effects);
    let (cancel, method, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the cancel request");
    assert_eq!(method, "cancel");
    // The cancel fails, and the close still runs; the interrupt settles with the cancel's error.
    let effects = feed(
        &mut core,
        &format!(r#"{{"jsonrpc":"2.0","id":{cancel},"error":{{"code":-32603,"message":"no"}}}}"#),
    );
    let effects = ack(&mut core, effects);
    let (close, method, params) = requests(&effects)
        .first()
        .cloned()
        .expect("the close request");
    assert_eq!(method, "close");
    assert_eq!(params.get("reason").and_then(Value::as_str), Some("user"));
    let effects = reply(&mut core, close, r#"{}"#);
    assert_eq!(ports(&effects), vec![String::from("stop")]);
    assert!(settled(&effects).is_empty());
    let stopped = core.note("stop", None);
    assert_eq!(settled(&stopped), vec![Err(String::from("ACE_CURSOR_RPC"))]);
    assert!(!core.state.control);
}

#[test]
fn an_interrupt_refuses_a_child_and_a_busy_control() {
    let mut core = session_core();
    opened(&mut core);
    let refused = interrupt(&mut core, 2, Some("child"), true)
        .err()
        .expect("a child");
    assert!(
        refused
            .message
            .starts_with("unsupported: Cursor SDK task children")
    );
    let effects = send(&mut core, 3, Some("c1"), Delivery::Queue, false).expect("a send");
    let _ = ack(&mut core, effects);
    let refused = interrupt(&mut core, 4, None, true).err().expect("busy");
    assert_eq!(refused.message, "SDK control already in flight");
}

#[test]
fn close_is_memoized_and_settles_every_waiter_once() {
    let mut core = session_core();
    opened(&mut core);
    let first = core.close(2, CloseReason::User);
    let second = core.close(3, CloseReason::Shutdown);
    // One close request, and the second caller waits on the first.
    let first = ack(&mut core, first);
    assert!(second.is_empty());
    let (close, method, params) = requests(&first)
        .first()
        .cloned()
        .expect("the close request");
    assert_eq!(method, "close");
    assert_eq!(params.get("reason").and_then(Value::as_str), Some("user"));
    let effects = reply(&mut core, close, r#"{}"#);
    assert_eq!(ports(&effects), vec![String::from("stop")]);
    let stopped = core.note("stop", None);
    assert_eq!(
        settled(&stopped),
        vec![Ok(String::from("null")), Ok(String::from("null"))]
    );
    // A late stop answer settles nothing more.
    assert!(settled(&core.note("stop", None)).is_empty());
}

#[test]
fn a_close_after_the_host_exited_asks_for_the_stop_without_a_request() {
    let mut core = session_core();
    opened(&mut core);
    let effects = core.exit(Some(0), None, "exit", None, None);
    assert!(ports(&effects).is_empty());
    assert!(core.state.exited);
    let effects = core.close(2, CloseReason::Shutdown);
    assert_eq!(ports(&effects), vec![String::from("stop")]);
    assert!(requests(&effects).is_empty());
}

#[test]
fn the_stop_port_carries_no_reason_and_only_its_answer_settles_the_close() {
    let mut core = session_core();
    opened(&mut core);
    let closed = core.close(2, CloseReason::User);
    let effects = ack(&mut core, closed);
    let (close, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the close request");
    let effects = reply(&mut core, close, r#"{}"#);
    // The facade is asked to stop the child with an empty payload, and nothing settles yet.
    let stopped: Vec<&str> = effects
        .iter()
        .filter_map(|effect| match effect {
            CoreEffect::Event(SessionEvent::Port { name, json }) if *name == "stop" => {
                assert_eq!(json, "{}");
                Some(*name)
            }
            _ => None,
        })
        .collect();
    assert_eq!(stopped, vec!["stop"]);
    assert!(settled(&effects).is_empty());
    // Only the facade's answer settles it.
    assert_eq!(
        settled(&core.note("stop", None)),
        vec![Ok(String::from("null"))]
    );
}

#[test]
fn a_cascading_interrupt_stops_the_one_host_its_children_run_in() {
    let mut core = session_core();
    opened(&mut core);
    let effects = interrupt(&mut core, 2, None, true).expect("a cascading interrupt");
    assert_eq!(
        frames(&effects),
        vec![(1, FrameDirection::Send, String::from("cancel"))]
    );
    let effects = ack(&mut core, effects);
    let (cancel, method, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the cancel request");
    assert_eq!(method, "cancel");
    // A successful cancel still closes the host, because that close is Cursor's cascade.
    let effects = reply(&mut core, cancel, r#"{"settled":true}"#);
    let (_, method, params) = requests(&effects)
        .first()
        .cloned()
        .expect("the close request");
    assert_eq!(method, "close");
    assert_eq!(params.get("reason").and_then(Value::as_str), Some("user"));
    let (close, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the close request");
    let effects = reply(&mut core, close, r#"{}"#);
    assert_eq!(ports(&effects), vec![String::from("stop")]);
    assert_eq!(
        settled(&core.note("stop", None)),
        vec![Ok(String::from("null"))]
    );
    // Nothing in the host — child tasks included — can take input after it.
    let refused = send(&mut core, 3, None, Delivery::Queue, false)
        .err()
        .expect("the host is closed");
    assert_eq!(refused.message, "SDK host is closed");
}

#[test]
fn an_interrupt_whose_cancel_cannot_be_written_still_closes_and_settles_after_the_stop() {
    let mut core = session_core();
    opened(&mut core);
    let stopped = feed(&mut core, r#"{"hello":1}"#);
    assert_eq!(ports(&stopped), vec![String::from("stop")]);
    // `session.ts:293`-`:298`: the inner finally still runs, so the close is attempted and the
    // child is stopped when that cannot be written either.
    let effects = interrupt(&mut core, 2, None, true).expect("the close runs");
    assert_eq!(
        frames(&effects),
        vec![(1, FrameDirection::Send, String::from("cancel"))]
    );
    assert!(requests(&effects).is_empty());
    assert_eq!(ports(&effects), vec![String::from("stop")]);
    assert!(core.state.closed);
    assert!(core.state.control, "the outer finally runs after the close");
    // The close's rejection is the interrupt's: it settles with the cancel's error once stopped.
    let stopped = core.note("stop", None);
    assert_eq!(settled(&stopped), vec![Err(String::from("ACE_CURSOR_RPC"))]);
    assert!(!core.state.control);
    assert!(core.closing.is_none());
}

#[test]
fn a_close_after_the_first_settled_does_not_stop_the_child_a_second_time() {
    let mut core = session_core();
    opened(&mut core);
    let closed = core.close(2, CloseReason::User);
    let effects = ack(&mut core, closed);
    let (close, _, _) = requests(&effects)
        .first()
        .cloned()
        .expect("the close request");
    let effects = reply(&mut core, close, r#"{}"#);
    assert_eq!(ports(&effects), vec![String::from("stop")]);
    assert_eq!(
        settled(&core.note("stop", None)),
        vec![Ok(String::from("null"))]
    );
    // `closing ??=` keeps the settled promise: a later close resolves without a second stop.
    let late = core.close(3, CloseReason::Shutdown);
    assert_eq!(ports(&late), Vec::<String>::new());
    assert!(requests(&late).is_empty());
    assert_eq!(settled(&late), vec![Ok(String::from("null"))]);
}
