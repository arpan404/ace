// SPDX-License-Identifier: Apache-2.0
//! The interrupt and the memoized close (`session.ts:182`-`:303`): the cancel's frame and
//! request, the close that follows it, the stop's port and the exit that skips the request.

use ace_adapter_api::session::{CloseReason, Delivery};

use super::*;

#[test]
fn an_interrupt_cancels_then_closes_and_settles_with_its_cancel_error() {
    let mut core = session_core();
    opened(&mut core);
    let effects = core.interrupt(2, None, true).expect("an interrupt");
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
    let refused = core
        .interrupt(2, Some("child"), true)
        .err()
        .expect("a child");
    assert!(
        refused
            .message
            .starts_with("unsupported: Cursor SDK task children")
    );
    let effects = send(&mut core, 3, Some("c1"), Delivery::Queue, false).expect("a send");
    let _ = ack(&mut core, effects);
    let refused = core.interrupt(4, None, true).err().expect("busy");
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
