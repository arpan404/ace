// SPDX-License-Identifier: Apache-2.0
//! The open's first steps, moved from `open-failure.process.test.ts`: a fenced, closing or deleted
//! thread refuses before any provider starts, in the TypeScript's order.

use super::{OpenRefusal, OpenStep, OpenView, first_step};

#[test]
fn the_checks_keep_the_typescripts_order_and_words() {
    // A Cursor CLI thread is read-only: the first refusal, before any store work.
    let mut view = OpenView {
        continuation: true,
        cleaning: true,
        ..OpenView::default()
    };
    assert_eq!(first_step(&view), Err(OpenRefusal::Continuation));
    assert_eq!(
        OpenRefusal::Continuation.message(),
        "Cursor CLI threads are read-only; continue in a new thread"
    );
    view.continuation = false;
    assert_eq!(first_step(&view), Err(OpenRefusal::Cleaning));
    view.cleaning = false;
    view.fenced = true;
    assert_eq!(first_step(&view), Err(OpenRefusal::Fenced));
    // The fence's words are the ones a held send is kept under, never a failure.
    assert_eq!(
        OpenRefusal::Fenced.message(),
        "This thread is moving to another machine; nothing more runs here"
    );
    view.fenced = false;
    view.closing = true;
    assert_eq!(first_step(&view), Err(OpenRefusal::Closing));
    view.closing = false;
    view.deleted = true;
    assert_eq!(first_step(&view), Err(OpenRefusal::Deleted));
    assert_eq!(OpenRefusal::Deleted.message(), "Thread deleted");
}

#[test]
fn a_workspace_that_needs_making_and_no_port_refuses() {
    let view = OpenView::default();
    assert_eq!(first_step(&view), Err(OpenRefusal::WorkspaceUnavailable));
    assert_eq!(
        OpenRefusal::WorkspaceUnavailable.message(),
        "Worktree preparation unavailable"
    );
    let ready = OpenView {
        workspace_ready: true,
        ..OpenView::default()
    };
    assert_eq!(first_step(&ready), Ok(OpenStep::Proceed));
    let preparing = OpenView {
        can_prepare_workspace: true,
        ..OpenView::default()
    };
    assert_eq!(first_step(&preparing), Ok(OpenStep::PrepareWorkspace));
}

#[test]
fn a_live_session_is_settled_and_an_open_in_flight_is_joined() {
    // A prepared root starting its first turn is not a pinned live policy, and a turn of ace's
    // own still live keeps the session it has.
    let open = OpenView {
        session_attached: true,
        own_live: true,
        workspace_ready: true,
        access_unchanged: false,
        ..OpenView::default()
    };
    assert_eq!(first_step(&open), Ok(OpenStep::AlreadyOpen));
    let changed_access = OpenView {
        access_unchanged: true,
        ..open
    };
    assert_eq!(first_step(&changed_access), Ok(OpenStep::AlreadyOpen));
    let in_flight = OpenView {
        opening: true,
        workspace_ready: true,
        ..OpenView::default()
    };
    assert_eq!(first_step(&in_flight), Ok(OpenStep::InFlight));
}
